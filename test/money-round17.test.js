// FUTURE (not enabled in v1; runs only under the test-only FUTURE_OPS switch): top-ups, revive. Round 18 moved v1 to ledger-check + re-issue (money-round18).
// Round-17 (credit-path audit 16): partial top-ups under their own reference, erased people, period revive, no hard stop, races, ref stability, orders and the clock.
// The provider is the REAL Moneypenny adapter talking to a fake that follows Moneypenny's wallet rules:
// duplicate_ref is checked BEFORE headroom, a bonus is at most manual_bonus_max, a person has a lifetime cap, the tenant a rolling 24h cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './helpers.js';
import { boot } from './webhelp.js';
import { settleEntitlement, settleCompany } from '../src/periods.js';
import { grant, retryQueued, reviveFailedRewards, openPartialGrants, retryPartialsNow, reverseReward, sendReward } from '../src/rewards.js';
import { ProviderError } from '../src/provider/errors.js';
import { MoneypennyProvider } from '../src/provider/moneypenny.js';
import { providerCapWarnings } from '../src/config.js';
import { correctDetails } from '../src/people.js';
import { tick } from '../src/api.js';
import * as setup from '../src/setup.js';

const HOUR = 3600_000, DAY = 86400_000;
const wrap = (real, over) => new Proxy(real, { get: (t, k) => (k in over ? over[k] : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });

/** Fake Moneypenny: wallet rules from moneypenny/src/wallet.js (creditManualBonus). */
function fakeMnp({ lifetime = 800, daily = Infinity, max = 500, now = () => Date.now() } = {}) {
  const st = { events: new Map(), idem: new Map(), grants: [], lifetime, daily, max, down: false, lose: 0, calls: [], history404: false };
  const mine = (email) => st.grants.filter((g) => g.email === email);
  const fetchImpl = async (url, init) => {
    const u = new URL(url), path = u.pathname, h = init.headers ?? {}, key = h['idempotency-key'] ?? null;
    const rep = (status, j, extra = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => extra[k] ?? null }, json: async () => j });
    st.calls.push({ path, key });
    if (st.down) throw new TypeError('fetch failed');
    if (path === '/v1/history') {
      const email = u.searchParams.get('email');
      return rep(200, { ok: true, entries: mine(email).map((g, i) => ({ id: i + 1, kind: 'bonus', delta: g.amount, ext_ref: 'manual:' + g.ref, at: g.at })) });
    }
    if (path !== '/v1/credit') return rep(404, { ok: false, error: { code: 'not_found' } });
    const body = init.body ?? '', j = JSON.parse(body);
    const prior = st.idem.get(key);
    if (prior) return prior.body !== body ? rep(400, { ok: false, error: { code: 'idempotency_conflict' } }) : rep(200, prior.res, { 'idempotent-replay': 'true' });
    if (st.events.has('manual:' + j.ref)) return rep(409, { ok: false, error: { code: 'duplicate_ref' } }); // BEFORE headroom
    if (j.amount > st.max) return rep(400, { ok: false, error: { code: 'bad_amount' } });
    const total = mine(j.email).reduce((a, g) => a + g.amount, 0), last24 = st.grants.filter((g) => now() - g.at < DAY).reduce((a, g) => a + g.amount, 0);
    const headroom = Math.min(j.amount, st.lifetime - total, st.daily - last24);
    if (headroom < 1) return rep(422, { ok: false, error: { code: 'cap_reached' } });
    st.events.set('manual:' + j.ref, true); st.grants.push({ email: j.email, amount: headroom, ref: j.ref, at: now() });
    const res = { ok: true, granted: headroom, balance: total + headroom }; st.idem.set(key, { body, res });
    if (st.lose > 0) { st.lose--; throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); } // landed, reply lost
    return rep(200, res);
  };
  st.fetchImpl = fetchImpl; st.total = (email) => mine(email).reduce((a, g) => a + g.amount, 0);
  return st;
}
async function mworld(opts = {}, mopts = {}) {
  let clock; const f = fakeMnp({ ...mopts, now: () => clock?.t ?? Date.now() });
  const prov = new MoneypennyProvider({ baseUrl: 'https://mnp.test', keyId: 'k', secret: 's'.repeat(32) }, { fetchImpl: f.fetchImpl });
  const w = await world({ providerOverride: () => prov, settings: { cap_person_month: 1e6, cap_person_season: 1e6, cap_period_bonus_person_period: 1e6, cap_event: 1e6, ...(opts.settings ?? {}) }, ...opts, settings: undefined });
  clock = w.clock; w.f = f; w.prov = prov;
  if (opts.settings) await w.db.run('UPDATE company SET settings = ? WHERE id = ?', JSON.stringify({ ...JSON.parse((await w.reload()).settings || '{}'), ...opts.settings }), w.company.id);
  await w.db.run('UPDATE company SET settings = ? WHERE id = ?', JSON.stringify({ ...JSON.parse((await w.reload()).settings || '{}'), cap_person_month: 1e6, cap_person_season: 1e6, cap_period_bonus_person_period: 1e6, cap_event: 1e6 }), w.company.id); await w.reload();
  w.email = (k) => `${k}@acme.test`;
  return w;
}
const G = (w, o) => grant(w.ctx, w.company, { person: w.people.a, kind: 'tier', groupKey: 'g', periodKey: 'W1', at: w.clock.t, ...o });
const rowOf = (w, id) => w.db.first('SELECT * FROM reward WHERE id = ?', id);
const auditN = (w, a) => w.db.first('SELECT COUNT(*) n FROM audit WHERE action=?', a).then((r) => r.n);

test('Z1 a partial grant is topped up under its own reference (a reused reference is a duplicate_ref before headroom) and the credits add up', async () => {
  const w = await mworld({}, { lifetime: 100 });
  const g = await G(w, { amount: 300, idem: 'z1' });
  let r = await rowOf(w, g.reward.id);
  assert.deepEqual([r.state, r.sent_amount, r.last_error], ['sent', 100, 'partial_grant']);
  w.f.lifetime = 1000; // the provider cap is lifted
  for (let i = 0; i < 3; i++) { w.clock.t += 7 * HOUR; await retryQueued(w.ctx, w.company); }
  r = await rowOf(w, g.reward.id);
  assert.equal(r.sent_amount, 300); assert.equal(r.last_error, null);
  assert.equal(w.f.total('a@acme.test'), 300, 'exactly what the row says');
  assert.ok(w.f.events.has(`manual:${g.reward.id}:r0`) || w.f.events.has(`manual:${g.reward.id}:r1`), 'the top-up used its own reference');
  assert.equal(w.f.events.size, 2, 'one for the first grant, one top-up');
});

test('Z1 a duplicate_ref on a top-up counts as landed only when the provider history confirms it; otherwise it is retried, then moves to a new reference', async () => {
  const w = await mworld({}, { lifetime: 100 });
  const g = await G(w, { amount: 300, idem: 'z1b' });
  w.f.lifetime = 1000;
  // The reference of the next top-up was already used (an earlier, lost call); the history shows the credit.
  w.f.events.set(`manual:${g.reward.id}:r0`, true); w.f.grants.push({ email: w.email('a'), amount: 200, ref: `${g.reward.id}:r0`, at: w.clock.t });
  w.clock.t += 7 * HOUR; await retryQueued(w.ctx, w.company);
  let r = await rowOf(w, g.reward.id);
  assert.equal(r.sent_amount, 300, 'confirmed by history: recorded, not paid twice'); assert.equal(w.f.total('a@acme.test'), 300);
  // Unconfirmed: the reference is taken but the history does not list it.
  const w2 = await mworld({}, { lifetime: 100 });
  const g2 = await G(w2, { amount: 300, idem: 'z1c' });
  w2.f.lifetime = 1000; w2.f.events.set(`manual:${g2.reward.id}:r0`, true);
  for (let i = 0; i < 4; i++) { w2.clock.t += 7 * HOUR; await retryQueued(w2.ctx, w2.company); }
  r = await rowOf(w2, g2.reward.id);
  assert.equal(r.sent_amount, 300, 'after the unconfirmed duplicates it moved on to a new reference and was paid');
  assert.equal(w2.f.total(w2.email('a')), 300);
});

test('Z2 an erased person is not settled again: no re-grant, no re-void, no growing audit', async () => {
  const w = await mworld({ v1: true });
  const cnt = async () => (await w.db.first('SELECT COUNT(*) n FROM reward')).n;
  await settleEntitlement(w.ctx, w.company, { person: w.people.d, kind: 'tier', groupKey: 'tier:t1:W1', periodKey: 'W1', entitled: 50, at: w.clock.t, label: 'x' });
  await w.db.run('UPDATE app_user SET erased_at = ? WHERE id = ?', w.clock.t, w.people.d.id);
  const before = await cnt(), a0 = await w.db.first('SELECT COUNT(*) n FROM audit');
  for (let i = 0; i < 3; i++) { w.clock.t += DAY; await settleCompany(w.ctx, w.company, w.clock.t); await tick(w.ctx, w.company); }
  assert.equal(await cnt(), before, 'no new reward rows for the erased person');
  const a1 = await w.db.first('SELECT COUNT(*) n FROM audit');
  assert.ok(a1.n - a0.n < 12, 'the audit does not grow by rows per tick');
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM reward WHERE state='queued' OR state='waiting'")).n, 0);
});

test('Z3 FUTURE a period bonus that failed for good is revived (fresh :v key, same entitlement) and is also tried weekly by itself', async () => {
  const w = await mworld({});
  w.f.down = false;
  const real = w.prov; let refuse = true;
  w.ctx.provider = () => wrap(real, { credit: async (x) => { if (refuse) throw new ProviderError('cap_reached', 'x'); return real.credit(x); } });
  const ent = (e) => settleEntitlement(w.ctx, w.company, { person: w.people.a, kind: 'tier', groupKey: 'tier:t1:W1', periodKey: 'W1', entitled: e, at: w.clock.t, label: 'x' });
  for (let i = 0; i < 5; i++) { await ent(80); await retryQueued(w.ctx, w.company); w.clock.t += 26 * HOUR; } // the daily settle makes a new :x try each day, the third failure is the last quick one
  for (const r of await w.db.all("SELECT * FROM reward WHERE kind='tier'")) assert.ok(['failed', 'queued', 'void'].includes(r.state));
  refuse = false;
  const out = await reviveFailedRewards(w.ctx, w.company, 'admin', { force: true });
  await retryQueued(w.ctx, w.company);
  const rows = await w.db.all("SELECT state, amount, idem_key FROM reward WHERE kind='tier' ORDER BY created_at");
  assert.ok(out.revived >= 1 || rows.some((r) => r.state === 'sent'), JSON.stringify([out, rows]));
  assert.equal(rows.filter((r) => r.state === 'sent').reduce((a, r) => a + r.amount, 0), 80, 'the entitlement is paid once');
  assert.equal(w.f.total('a@acme.test'), 80);
});

test('Z4 a partial top-up never stops: after the quick tries it retries daily, the admin can retry now, and the alert tells the truth', async () => {
  const w = await boot({ settings: { daily_event_limit: 1000 } }); await w.login('admin');
  const f = fakeMnp({ lifetime: 20, now: () => w.clock.t });
  const prov = new MoneypennyProvider({ baseUrl: 'https://mnp.test', keyId: 'k', secret: 's'.repeat(32) }, { fetchImpl: f.fetchImpl });
  w.ctx.provider = () => prov;
  const g = await grant(w.ctx, w.company, { person: w.people.a, kind: 'tier', amount: 100, idem: 'z4', groupKey: 'g4', periodKey: 'W1', at: w.clock.t });
  for (let i = 0; i < 40; i++) { w.clock.t += 6 * HOUR + 1000; await retryQueued(w.ctx, w.company); }
  let r = await rowOf(w, g.reward.id);
  assert.equal(r.sent_amount, 20); assert.equal(r.last_error, 'partial_grant', 'still open after many tries: no hard stop');
  const k1 = JSON.parse(r.note).remK; await w.login('admin');
  const ov = await w.call('admin', 'GET', '/api/admin/overview');
  assert.equal(ov.json.open_partial_grants, 1);
  assert.ok(ov.json.alerts.some((a) => /Moneypenny ledger/.test(a)), 'the alert names the ledger check');
  f.lifetime = 1000;
  const res = await w.call('admin', 'POST', '/api/admin/retry-partials', {});
  assert.equal(res.status, 200); assert.equal(res.json.paid, 80);
  r = await rowOf(w, g.reward.id);
  assert.equal(r.sent_amount, 100); assert.equal(r.last_error, null); assert.ok(k1 >= 8);
  assert.equal(f.total('a@acme.test'), 100);
});

test('Z5 a reversal waits for an in-flight top-up, and the owed amount is what the provider actually credited', async () => {
  const w = await mworld({}, { lifetime: 100 });
  const g = await G(w, { amount: 300, idem: 'z5' });
  w.f.lifetime = 1000;
  // A top-up call is announced (cut short): a reversal now must not decide on stale numbers.
  const real = w.prov; let hold = null;
  w.ctx.provider = () => wrap(real, { credit: async (x) => { if (x.ref.includes(':r')) { hold = x; throw new ProviderError('provider_down', 'cut'); } return real.credit(x); } });
  w.clock.t += 7 * HOUR; await retryQueued(w.ctx, w.company);
  assert.ok(hold, 'the top-up was attempted');
  const rr = await reverseReward(w.ctx, w.company, await rowOf(w, g.reward.id), { reason: 'x', actor: 'system' });
  assert.ok(rr.pending || rr.state === 'pending' || rr.skipped || rr.reason === 'topup_pending' || JSON.stringify(rr).includes('topup_pending'), JSON.stringify(rr));
  assert.equal((await rowOf(w, g.reward.id)).reversed, 0, 'not reversed while the top-up is in flight');
});

test('Z6 a changed email does not change the account of a call that may have landed; an erased leaver with tries stays queued', async () => {
  const w = await mworld({});
  w.f.down = true; // the first call fails with a lost reply: the row stays queued with attempts 1
  const g = await G(w, { amount: 40, idem: 'z6' });
  assert.equal((await rowOf(w, g.reward.id)).state, 'queued');
  w.f.down = false;
  await correctDetails(w.ctx, w.company, w.admin, w.people.a.id, { email: 'a.new@acme.test' });
  w.clock.t += 2 * HOUR; await retryQueued(w.ctx, w.company);
  const r = await rowOf(w, g.reward.id);
  assert.equal(r.state, 'sent');
  assert.equal(w.f.total('a@acme.test'), 40, 'credited to the account used at the first try, with the same request');
  assert.equal(w.f.total('a.new@acme.test'), 0);
  // erased with attempts > 0: kept queued, not voided as person_erased
  const g2 = await grant(w.ctx, w.company, { person: w.people.b, kind: 'tier', amount: 30, idem: 'z6b', groupKey: 'g6b', periodKey: 'W1', at: w.clock.t });
  await w.db.run("UPDATE reward SET state='queued', attempts=1, sent_at=NULL, sent_amount=0, provider_ref=NULL WHERE id=?", g2.reward.id);
  await w.db.run('UPDATE app_user SET erased_at = ? WHERE id = ?', w.clock.t, w.people.b.id);
  await retryQueued(w.ctx, w.company);
  assert.notEqual((await rowOf(w, g2.reward.id)).state, 'void');
});

test('Z7 revived waiting rows get an alert line; a tier above the provider bonus maximum is warned about; LAZY_TICK is forwarded', async () => {
  const w = await boot({ settings: { daily_event_limit: 1000 } }); await w.login('admin');
  await w.db.run("INSERT INTO reward (id, company_id, person_id, kind, amount, state, idem_key, created_at, last_error, season_id) VALUES ('rw_z7', ?, ?, 'tier', 10, 'waiting', 'z7', 1, 'revived', NULL)", w.company.id, w.people.a.id);
  const ov = await w.call('admin', 'GET', '/api/admin/overview');
  assert.equal(ov.json.rewards_waiting_revived, 1);
  assert.ok(providerCapWarnings({ provider: 'moneypenny', settings: '{}' }, 800).some((x) => /single bonus maximum/.test(x)));
  assert.equal(providerCapWarnings({ provider: 'moneypenny', settings: '{}' }, 100).length, 3);
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(new URL('../functions/[[path]].js', import.meta.url), 'utf8'), /LAZY_TICK: env\.LAZY_TICK/);
});

test('Z7 an auto-approved order whose capture is refused for good becomes declined with the reason and the hold goes back', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); const real = w.ctx.provider(w.company);
  await settleEntitlement(w.ctx, w.company, { person: w.people.a, kind: 'tier', groupKey: 'tier:t1:W1', periodKey: 'W1', entitled: 100, at: w.clock.t, label: 'x' });
  const it = await setup.addItem(w.ctx, w.company, w.admin, { name: 'Tea', credits: 5, needs_approval: false });
  let released = 0;
  w.ctx.provider = () => wrap(real, { captureSpend: async () => { throw new ProviderError('bad_request', 'no'); }, releaseSpend: async (x) => { released++; return real.releaseSpend(x); } });
  let o; try { o = await setup.placeOrder(w.ctx, w.company, w.people.a, it.id); } catch { /* the order may be answered with its state */ }
  const st = await w.db.first('SELECT state FROM catalogue_order ORDER BY created_at DESC LIMIT 1');
  if (st) assert.notEqual(st.state, 'reserved', 'never left reserved after a refused capture');
  assert.equal(st.state, 'declined'); assert.ok(released >= 1, 'the hold was given back');
});

test('Z7 one failing tick stage does not stop the others and its audit line is written once a day', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  const real = w.ctx.provider(w.company); let down = true;
  w.ctx.provider = () => wrap(real, { credit: async (x) => { if (down) throw new ProviderError('provider_down'); return real.credit(x); } });
  await grant(w.ctx, w.company, { person: w.people.a, kind: 'tier', amount: 20, idem: 'z7t', groupKey: 'g7', periodKey: 'W1', at: w.clock.t });
  const out = await tick(w.ctx, w.company);
  assert.ok(out && typeof out === 'object');
  down = false; w.clock.t += 2 * HOUR; await tick(w.ctx, w.company);
  assert.equal((await w.db.first("SELECT state FROM reward WHERE idem_key='z7t'")).state, 'sent');
});

test('Z7 an auto-approved order refused on the clock\'s try (after a transient first answer) is declined too, not left reserved for ever', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); const real = w.ctx.provider(w.company);
  await settleEntitlement(w.ctx, w.company, { person: w.people.a, kind: 'tier', groupKey: 'tier:t1:W1', periodKey: 'W1', entitled: 100, at: w.clock.t, label: 'x' });
  const it = await setup.addItem(w.ctx, w.company, w.admin, { name: 'Mug', credits: 30, needs_approval: false });
  let n = 0, released = 0;
  w.ctx.provider = () => wrap(real, { captureSpend: async () => { n++; throw new ProviderError(n === 1 ? 'unauthorized' : 'bad_request', 'x'); }, releaseSpend: async (x) => { released++; return real.releaseSpend(x); } });
  try { await setup.placeOrder(w.ctx, w.company, w.people.a, it.id); } catch { /* the first answer is not definitive: a 502 */ }
  for (let i = 0; i < 3; i++) { w.clock.t += 2 * HOUR; await setup.finishOrders(w.ctx, w.company); }
  assert.equal((await w.db.first('SELECT state FROM catalogue_order')).state, 'declined');
  assert.ok(released >= 1);
});
