// Round-18 (credit-only v1): no single credit above 500, no automatic top-up or revive, a failed or partial reward needs an admin who checks the ledger and re-issues it as a NEW grant,
// duplicate_ref is never paid again by itself, erased people are closed for good, a hold that has to go back is driven by the clock.
// The provider is the REAL Moneypenny adapter against a fake that follows Moneypenny's wallet rules (history ref "manual:<ref>" with ext_ref null,
// manual_bonus_max 500, lifetime 800 per person, 20 events per person per day, a rolling 24h tenant cap, duplicate_ref before headroom, idempotency rows purged after 30 days).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './helpers.js';
import { boot } from './webhelp.js';
import { settleEntitlement, settleCompany } from '../src/periods.js';
import { grant, retryQueued, reissueReward, openPartialGrants, openFailedRewards, sendReward } from '../src/rewards.js';
import { ProviderError } from '../src/provider/errors.js';
import { MoneypennyProvider } from '../src/provider/moneypenny.js';
import * as setup from '../src/setup.js';
import { updateSettings, createCompany } from '../src/people.js';
import { tick } from '../src/api.js';

const HOUR = 3600_000, DAY = 86400_000;
const wrap = (real, over) => new Proxy(real, { get: (t, k) => (k in over ? over[k] : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });

function fakeMnp({ lifetime = 800, daily = Infinity, max = 500, now = () => Date.now() } = {}) {
  const st = { events: new Map(), idem: new Map(), grants: [], lifetime, daily, max, down: false, lose: 0, calls: [], hideHistory: false };
  const mine = (email) => st.grants.filter((g) => g.email === email);
  st.fetchImpl = async (url, init) => {
    const u = new URL(url), path = u.pathname, h = init.headers ?? {}, key = h['idempotency-key'] ?? null;
    const rep = (status, j, extra = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => extra[k] ?? null }, json: async () => j });
    st.calls.push({ path, key });
    if (st.down) throw new TypeError('fetch failed');
    if (path === '/v1/history') {
      if (st.hideHistory) return rep(200, { ok: true, entries: [] });
      return rep(200, { ok: true, entries: mine(u.searchParams.get('email')).map((g, i) => ({ id: i + 1, kind: 'bonus', delta: g.amount, ref: 'manual:' + g.ref, ext_ref: null, at: g.at })) });
    }
    if (path !== '/v1/credit') return rep(404, { ok: false, error: { code: 'not_found' } });
    const body = init.body ?? '', j = JSON.parse(body);
    const prior = st.idem.get(key);
    if (prior) return prior.body !== body ? rep(400, { ok: false, error: { code: 'idempotency_conflict' } }) : rep(200, prior.res, { 'idempotent-replay': 'true' });
    if (st.events.has('manual:' + j.ref)) return rep(409, { ok: false, error: { code: 'duplicate_ref' } }); // BEFORE headroom
    if (j.amount > st.max) return rep(400, { ok: false, error: { code: 'bad_amount' } });
    const today = st.grants.filter((g) => g.email === j.email && now() - g.at < DAY).length;
    if (today >= 20) return rep(429, { ok: false, error: { code: 'too_many_events' } });
    const total = mine(j.email).reduce((a, g) => a + g.amount, 0), last24 = st.grants.filter((g) => now() - g.at < DAY).reduce((a, g) => a + g.amount, 0);
    const headroom = Math.min(j.amount, st.lifetime - total, st.daily - last24);
    if (headroom < 1) return rep(422, { ok: false, error: { code: 'cap_reached' } });
    st.events.set('manual:' + j.ref, true); st.grants.push({ email: j.email, amount: headroom, ref: j.ref, at: now() });
    const res = { ok: true, granted: headroom, balance: total + headroom }; st.idem.set(key, { body, res, at: now() });
    if (st.lose > 0) { st.lose--; throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); }
    return rep(200, res);
  };
  st.total = (email) => mine(email).reduce((a, g) => a + g.amount, 0);
  st.credits = () => st.calls.filter((c) => c.path === '/v1/credit').length;
  return st;
}
async function mworld(mopts = {}) {
  let clock; const f = fakeMnp({ ...mopts, now: () => clock?.t ?? Date.now() });
  const prov = new MoneypennyProvider({ baseUrl: 'https://mnp.test', keyId: 'k', secret: 's'.repeat(32) }, { fetchImpl: f.fetchImpl });
  const w = await world({ v1: true, providerOverride: () => prov, settings: { cap_person_month: 1e6, cap_person_season: 1e6, cap_period_bonus_person_period: 1e6, cap_event: 500 } });
  clock = w.clock; w.f = f; w.prov = prov;
  await w.db.run("UPDATE company SET provider = 'moneypenny' WHERE id = ?", w.company.id); await w.reload();
  return w;
}
const G = (w, o) => grant(w.ctx, w.company, { person: w.people.a, kind: 'tier', groupKey: 'g', periodKey: 'W1', at: w.clock.t, ...o });
const rowOf = (w, id) => w.db.first('SELECT * FROM reward WHERE id = ?', id);
const A = 'a@acme.test';

test('R1 a credit above 500 is refused when it is configured (rate card, tier, streak, card, settings, company) and never sent', async () => {
  const w = await mworld();
  const code = async (p) => { try { await p; return null; } catch (e) { return e.code; } };
  assert.equal(await code(setup.addRateCard(w.ctx, w.company, w.admin, { active_from: 1, event_type: 'big', stage: 'done', stage_no: 1, credits: 600, state_needed: 'system' })), 'above_provider_max');
  await setup.addRateCard(w.ctx, w.company, w.admin, { active_from: 1, event_type: 'ok', stage: 'done', stage_no: 1, credits: 500, state_needed: 'system' });
  assert.equal(await code(setup.addTarget(w.ctx, w.company, w.admin, { name: 't', scope: 'person', period: 'week', event_type: 'ok', stage: 'done', active_from: 1, tiers: [{ count: 1, bonus: 501 }] })), 'above_provider_max');
  assert.equal(await code(setup.addTarget(w.ctx, w.company, w.admin, { name: 't', scope: 'team', period: 'week', event_type: 'ok', stage: 'done', active_from: 1, tiers: [{ count: 1, bonus: 100 }], streak: { length: 2, bonus: 900 } })), 'above_provider_max');
  assert.equal(await code(setup.addNoteCard(w.ctx, w.company, w.admin, { text: 'x', effect: 'credits', amount: 700, kind: 'note' })), 'above_provider_max');
  assert.equal(await code(updateSettings(w.ctx, w.company, w.admin, { cap_event: 600 })), 'above_provider_max');
  assert.equal(await code(createCompany(w.ctx, { name: 'N', slug: 'n2', provider: 'moneypenny', adminEmail: 'x@n2.test', settings: { cap_event: 700 } })), 'above_provider_max');
  // the safety net at send time
  const before = w.f.credits();
  const g = await G(w, { amount: 600, idem: 'r1' });
  assert.equal(g.reward.state, 'failed'); assert.equal(g.reward.last_error, 'above_provider_max'); assert.equal(w.f.credits(), before, 'never sent');
});

test('R2 a partial grant is recorded, not topped up by itself; admin routes for top-up and revive are refused; re-issue needs the confirm flag and makes a NEW grant', async () => {
  const w = await boot({ settings: { daily_event_limit: 1000, cap_event: 500 } }); await w.login('admin');
  const f = fakeMnp({ lifetime: 100, now: () => w.clock.t });
  const prov = new MoneypennyProvider({ baseUrl: 'https://mnp.test', keyId: 'k', secret: 's'.repeat(32) }, { fetchImpl: f.fetchImpl });
  w.ctx.provider = () => prov; w.ctx.env = { ...w.ctx.env, FUTURE_OPS: undefined };
  await w.db.run("UPDATE company SET provider = 'moneypenny' WHERE id = ?", w.company.id); await w.reload();
  const g = await grant(w.ctx, w.company, { person: w.people.a, kind: 'tier', amount: 300, idem: 'r2', groupKey: 'g2', periodKey: 'W1', at: w.clock.t });
  let r = await rowOf(w, g.reward.id);
  assert.deepEqual([r.state, r.sent_amount, r.last_error], ['sent', 100, 'partial_grant']);
  f.lifetime = 1000; const n0 = f.credits();
  for (let i = 0; i < 12; i++) { w.clock.t += 7 * HOUR; await retryQueued(w.ctx, w.company); }
  assert.equal(f.credits(), n0, 'no top-up call, ever');
  await w.login('admin');
  assert.equal((await w.call('admin', 'POST', '/api/admin/retry-partials', {})).status, 409);
  assert.equal((await w.call('admin', 'POST', '/api/admin/revive-failed', {})).status, 409);
  const ov = await w.call('admin', 'GET', '/api/admin/overview');
  assert.equal(ov.json.open_partial_grants, 1); assert.ok(ov.json.alerts.some((a) => /Moneypenny ledger/.test(a) && /NEW grant/.test(a)));
  assert.equal((await w.call('admin', 'POST', '/api/admin/reissue', { id: g.reward.id })).status, 400, 'confirm is required');
  const ok = await w.call('admin', 'POST', '/api/admin/reissue', { id: g.reward.id, confirm: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const nr = await rowOf(w, ok.json.new_reward);
  assert.equal(nr.state, 'sent'); assert.equal(nr.amount, 200); assert.notEqual(nr.idem_key, r.idem_key);
  r = await rowOf(w, g.reward.id); assert.equal(r.amount, 100); assert.equal(r.last_error, 'closed_partial');
  assert.equal(f.total(A), 300); assert.ok(f.events.has('manual:' + nr.id) && !f.events.has(`manual:${g.reward.id}:r0`), 'a new reference, no :r<k>');
  assert.equal((await w.call('admin', 'POST', '/api/admin/reissue', { id: g.reward.id, confirm: true })).status, 404, 'the closed row cannot be re-issued again');
  assert.equal(await w.db.first("SELECT COUNT(*) n FROM audit WHERE action='reward.reissued'").then((x) => x.n), 1);
});

test('R3 a reward the provider refused for good is not retried or revived; re-issue closes it and sends a new one', async () => {
  const w = await mworld({ lifetime: 0 });
  const g = await G(w, { amount: 80, idem: 'r3' });
  assert.equal(g.reward.state, 'failed'); const n0 = w.f.credits();
  for (let i = 0; i < 10; i++) { w.clock.t += 26 * HOUR; await retryQueued(w.ctx, w.company); await tick(w.ctx, w.company); }
  assert.equal(w.f.credits(), n0, 'nothing is sent again by itself');
  assert.equal(await openFailedRewards(w.ctx, w.company.id), 1);
  await assert.rejects(reissueReward(w.ctx, w.company, 'admin', { id: g.reward.id }), (e) => e.code === 'confirm_required');
  w.f.lifetime = 800;
  const out = await reissueReward(w.ctx, w.company, 'admin', { id: g.reward.id, confirm: true });
  const old = await rowOf(w, g.reward.id), nr = await rowOf(w, out.new_reward);
  assert.deepEqual([old.state, old.last_error], ['void', 'reissued']); assert.equal(nr.state, 'sent'); assert.equal(w.f.total(A), 80);
  assert.equal(await openFailedRewards(w.ctx, w.company.id), 0);
});

test('R4 duplicate_ref: the amount comes from the history ("manual:<ref>"); unconfirmed it needs an admin and is never paid again by itself', async () => {
  const w = await mworld();
  w.f.lose = 1; // the credit lands, the reply is lost
  const g = await G(w, { amount: 80, idem: 'r4' });
  assert.equal((await rowOf(w, g.reward.id)).state, 'queued');
  w.f.idem.clear(); // the provider purged its idempotency rows (30 days): the retry meets duplicate_ref
  w.clock.t += 2 * HOUR; await retryQueued(w.ctx, w.company);
  const r = await rowOf(w, g.reward.id);
  assert.deepEqual([r.state, r.sent_amount, r.last_error], ['sent', 80, null]); assert.equal(w.f.total(A), 80, 'not paid twice');
  // the history cannot confirm
  const w2 = await mworld();
  w2.f.lose = 1; const g2 = await G(w2, { amount: 80, idem: 'r4b' });
  w2.f.idem.clear(); w2.f.hideHistory = true;
  for (let i = 0; i < 5; i++) { w2.clock.t += 7 * HOUR; await retryQueued(w2.ctx, w2.company); }
  const r2 = await rowOf(w2, g2.reward.id);
  assert.deepEqual([r2.state, r2.last_error], ['failed', 'duplicate_unconfirmed']); assert.equal(w2.f.total(A), 80);
  // a duplicate whose history shows less than asked is a partial grant
  const w3 = await mworld();
  w3.f.lose = 1; const g3 = await G(w3, { amount: 80, idem: 'r4c' });
  w3.f.grants[0].amount = 30; w3.f.idem.clear();
  w3.clock.t += 2 * HOUR; await retryQueued(w3.ctx, w3.company);
  const r3 = await rowOf(w3, g3.reward.id);
  assert.deepEqual([r3.state, r3.sent_amount, r3.last_error], ['sent', 30, 'partial_grant']);
});

test('R5 an erased person: queued rows (even with tries) are closed as voided_erased with an audit line, and nothing counts or settles them again', async () => {
  const w = await mworld();
  w.f.down = true; const g = await G(w, { person: w.people.b, amount: 40, idem: 'r5' });
  assert.equal((await rowOf(w, g.reward.id)).attempts, 1);
  const g2 = await G(w, { person: w.people.b, amount: 20, idem: 'r5b', groupKey: 'g5' });
  await w.db.run("UPDATE reward SET state = 'sent', last_error = 'partial_grant', sent_amount = 5 WHERE id = ?", g2.reward.id);
  await w.db.run('UPDATE app_user SET erased_at = ? WHERE id = ?', w.clock.t, w.people.b.id); w.f.down = false;
  await retryQueued(w.ctx, w.company);
  const r = await rowOf(w, g.reward.id);
  assert.deepEqual([r.state, r.last_error], ['void', 'voided_erased']);
  const line = await w.db.first("SELECT data FROM audit WHERE action = 'reward.void' ORDER BY rowid DESC LIMIT 1");
  assert.match(line.data, /voided_erased/); assert.match(line.data, /"maybe_landed":true/);
  assert.equal(await openPartialGrants(w.ctx, w.company.id), 0); assert.equal(await openFailedRewards(w.ctx, w.company.id), 0);
  const before = (await w.db.first('SELECT COUNT(*) n FROM reward')).n;
  for (let i = 0; i < 3; i++) { w.clock.t += DAY; await settleCompany(w.ctx, w.company, w.clock.t); await tick(w.ctx, w.company); }
  assert.equal((await w.db.first('SELECT COUNT(*) n FROM reward')).n, before);
});

test('R6 a failed period bonus is not re-sent by the daily settle (v1): one provider call, then it waits for the admin', async () => {
  const w = await mworld({ lifetime: 0 });
  const ent = (e) => settleEntitlement(w.ctx, w.company, { person: w.people.a, kind: 'tier', groupKey: 'tier:t1:W1', periodKey: 'W1', entitled: e, at: w.clock.t, label: 'x' });
  for (let i = 0; i < 12; i++) { await ent(80); w.clock.t += 26 * HOUR; await retryQueued(w.ctx, w.company); }
  assert.equal(w.f.credits(), 1);
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM reward WHERE kind = 'tier'")).n, 1);
});

test('R7 FUTURE (the shop is not enabled in v1, see R9) a hold that has to go back (declined auto order) is released by the clock until the provider confirms', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); const real = w.ctx.provider(w.company);
  await settleEntitlement(w.ctx, w.company, { person: w.people.a, kind: 'tier', groupKey: 'tier:t1:W1', periodKey: 'W1', entitled: 100, at: w.clock.t, label: 'x' });
  const it = await setup.addItem(w.ctx, w.company, w.admin, { name: 'Mug', credits: 30, needs_approval: false });
  let rel = 0, down = true;
  w.ctx.provider = () => wrap(real, { captureSpend: async () => { throw new ProviderError('bad_request', 'x'); }, releaseSpend: async (x) => { rel++; if (down) throw new ProviderError('provider_down', 'x'); return real.releaseSpend(x); } });
  try { await setup.placeOrder(w.ctx, w.company, w.people.a, it.id); } catch { /* may answer with the state */ }
  assert.equal((await w.db.first('SELECT state FROM catalogue_order')).state, 'declined');
  const n0 = rel; down = false;
  w.clock.t += 2 * HOUR; await setup.finishOrders(w.ctx, w.company);
  assert.ok(rel > n0, 'the clock tried the release again');
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM provider_op WHERE kind = 'order_release' AND settled = 0")).n, 0);
});

test('R8 the adapter reads the history ref from ref, then ext_ref', async () => {
  const mk = (e) => new MoneypennyProvider({ baseUrl: 'https://mnp.test', keyId: 'k', secret: 's'.repeat(32) }, { fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, entries: [e] }) }) });
  assert.equal((await mk({ id: 1, delta: 5, ref: 'manual:x', ext_ref: null }).history({ accountRef: A })).lines[0].ref, 'manual:x');
  assert.equal((await mk({ id: 1, delta: 5, ext_ref: 'y' }).history({ accountRef: A })).lines[0].ref, 'y');
});
