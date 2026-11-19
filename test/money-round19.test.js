// Round-19 (credit-only v1): re-issue is ONE atomic step, the settle never pays a group with a failed row or a re-issue chain, dice bonus above 500 is refused/clamped,
// mark-received, history paging, the account sealed with the attempt, and the shop (spend path) is not enabled in v1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './helpers.js';
import { boot } from './webhelp.js';
import { settleEntitlement } from '../src/periods.js';
import { grant, retryQueued, reissueReward, markReceived, openFailedRewards } from '../src/rewards.js';
import { MoneypennyProvider } from '../src/provider/moneypenny.js';
import { updateSettings } from '../src/people.js';
import { tick } from '../src/api.js';
import * as setup from '../src/setup.js';

const HOUR = 3600_000, DAY = 86400_000, A = 'a@acme.test';

/** Fake Moneypenny (see money-round18): history ref "manual:<ref>", ext_ref null, pages of 100 with next_before_seq, 30-day idempotency purge is simulated by st.idem.clear(). */
function fakeMnp({ lifetime = 800, now = () => Date.now() } = {}) {
  const st = { events: new Map(), idem: new Map(), grants: [], lifetime, down: false, lose: 0, calls: [] };
  const mine = (email) => st.grants.filter((g) => g.email === email);
  st.fetchImpl = async (url, init) => {
    const u = new URL(url), path = u.pathname, key = (init.headers ?? {})['idempotency-key'] ?? null;
    const rep = (status, j, extra = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => extra[k] ?? null }, json: async () => j });
    st.calls.push({ path, key, q: u.search });
    if (st.down) throw new TypeError('fetch failed');
    if (path === '/v1/history') {
      const all = mine(u.searchParams.get('email')).map((g, i) => ({ id: i + 1, kind: 'bonus', delta: g.amount, ref: 'manual:' + g.ref, ext_ref: null })).reverse();
      const limit = Math.min(+u.searchParams.get('limit') || 50, 100); const before = u.searchParams.get('before_seq');
      const rows = all.filter((e) => before == null || e.id < +before).slice(0, limit);
      return rep(200, { ok: true, entries: rows, next_before_seq: rows.length === limit ? rows[rows.length - 1].id : null });
    }
    if (path !== '/v1/credit') return rep(404, { ok: false, error: { code: 'not_found' } });
    const body = init.body ?? '', j = JSON.parse(body), prior = st.idem.get(key);
    if (prior) return prior.body !== body ? rep(400, { ok: false, error: { code: 'idempotency_conflict' } }) : rep(200, prior.res, { 'idempotent-replay': 'true' });
    if (st.events.has('manual:' + j.ref)) return rep(409, { ok: false, error: { code: 'duplicate_ref' } });
    if (j.amount > 500) return rep(400, { ok: false, error: { code: 'bad_amount' } });
    const total = mine(j.email).reduce((a, g) => a + g.amount, 0), headroom = Math.min(j.amount, st.lifetime - total);
    if (headroom < 1) return rep(422, { ok: false, error: { code: 'cap_reached' } });
    st.events.set('manual:' + j.ref, true); st.grants.push({ email: j.email, amount: headroom, ref: j.ref, at: now() });
    const res = { ok: true, granted: headroom, balance: total + headroom }; st.idem.set(key, { body, res });
    if (st.lose > 0) { st.lose--; throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); }
    return rep(200, res);
  };
  st.total = (email) => mine(email).reduce((a, g) => a + g.amount, 0);
  st.credits = () => st.calls.filter((c) => c.path === '/v1/credit').length;
  return st;
}
async function mworld(mopts = {}, wopts = {}) {
  let clock; const f = fakeMnp({ ...mopts, now: () => clock?.t ?? Date.now() });
  const prov = new MoneypennyProvider({ baseUrl: 'https://mnp.test', keyId: 'k', secret: 's'.repeat(32) }, { fetchImpl: f.fetchImpl });
  const w = await world({ v1: true, providerOverride: () => prov, ...wopts, settings: { cap_person_month: 1e6, cap_person_season: 1e6, cap_period_bonus_person_period: 1e6, cap_event: 500, ...(wopts.settings ?? {}) } });
  clock = w.clock; w.f = f;
  await w.db.run("UPDATE company SET provider = 'moneypenny' WHERE id = ?", w.company.id); await w.reload();
  return w;
}
const ent = (w, e, person = 'a') => settleEntitlement(w.ctx, w.company, { person: w.people[person], kind: 'tier', groupKey: 'tier:t1:W1', periodKey: 'W1', entitled: e, at: w.clock.t, label: 'x' });
const rowOf = (w, id) => w.db.first('SELECT * FROM reward WHERE id = ?', id);
const tiers = (w) => w.db.all("SELECT state, amount, sent_amount, last_error, idem_key FROM reward WHERE kind = 'tier' ORDER BY created_at, rowid");
const days = async (w, n, fn) => { for (let i = 0; i < n; i++) { w.clock.t += 26 * HOUR; await fn(); await retryQueued(w.ctx, w.company); } };

test('S1 re-issue is ONE atomic step: the settle can never pay the group under another key, before or after it', async () => {
  const w = await mworld({ lifetime: 0 });
  await ent(w, 80); const failed = (await tiers(w))[0]; assert.equal(failed.state, 'failed');
  w.f.lifetime = 800;
  const row = await w.db.first("SELECT id FROM reward WHERE kind = 'tier'");
  // a settle that runs at the worst moment: while the batch of the re-issue is being executed, nothing can run in between (one batch)
  const ob = w.db.batch.bind(w.db); let inner = 0;
  w.db.batch = async (stmts) => { const o = await ob(stmts); if (stmts.some((x) => String(x?.[0] ?? x).includes("last_error = 'reissued'"))) { inner++; assert.equal((await w.db.first("SELECT COUNT(*) n FROM reward WHERE kind = 'tier' AND state NOT IN ('void','failed')")).n, 1, 'old row closed AND new row present after the same batch'); } return o; };
  const out = await reissueReward(w.ctx, w.company, 'admin', { id: row.id, confirm: true });
  w.db.batch = ob; assert.equal(inner, 1);
  assert.equal(out.state, 'sent'); assert.equal(out.paid, 80);
  await days(w, 10, () => ent(w, 80));
  assert.equal(w.f.total(A), 80, 'paid exactly once'); assert.equal((await tiers(w)).filter((r) => r.state === 'sent').length, 1);
  // later the entitlement grows: the settle does not pay the difference by itself either (the group has a re-issue chain)
  await days(w, 3, () => ent(w, 120)); assert.equal(w.f.total(A), 80);
  const line = await w.db.first("SELECT data FROM audit WHERE action = 'reward.reissued'");
  const d = JSON.parse(line.data); assert.equal(d.old, row.id); assert.equal(d.new, out.new_reward); assert.equal(d.key, out.key);
});

test('S1 a re-issue that cannot place the new grant leaves the old row untouched (no lost reward)', async () => {
  const w = await mworld({ lifetime: 0 });
  await ent(w, 80); const row = await w.db.first("SELECT id FROM reward WHERE kind = 'tier'");
  const ob = w.db.batch.bind(w.db);
  w.db.batch = async (stmts) => { if (stmts.some((x) => String(x?.[0] ?? x).includes("last_error = 'reissued'"))) throw new Error('audit chain is busy'); return ob(stmts); };
  await assert.rejects(reissueReward(w.ctx, w.company, 'admin', { id: row.id, confirm: true }), (e) => ['busy', 'not_reissued'].includes(e.code));
  w.db.batch = ob;
  const r = await rowOf(w, row.id); assert.deepEqual([r.state, r.reversed, r.last_error], ['failed', 0, 'cap_reached']);
  assert.equal(await openFailedRewards(w.ctx, w.company.id), 1);
});

test('S2 a closed partial period row is not topped up by the settle: only the admin pays the rest, with the amount the admin chose', async () => {
  const w = await mworld({ lifetime: 30 });
  await ent(w, 100); let [r] = await tiers(w); assert.deepEqual([r.state, r.sent_amount, r.last_error], ['sent', 30, 'partial_grant']);
  const id = (await w.db.first("SELECT id FROM reward WHERE kind = 'tier'")).id;
  w.f.lifetime = 800;
  await days(w, 5, () => ent(w, 100)); assert.equal(w.f.credits(), 1, 'no top-up by itself');
  const out = await reissueReward(w.ctx, w.company, 'admin', { id, confirm: true, amount: 40 });
  assert.equal(out.state, 'sent'); assert.equal(w.f.total(A), 70);
  await days(w, 5, () => ent(w, 100)); assert.equal(w.f.total(A), 70, 'the settle still does not pay the remaining 30');
  assert.equal((await tiers(w)).map((x) => x.last_error).sort().join(), 'closed_partial,');
});

test('S3 re-issue is refused when live rows already cover the entitlement', async () => {
  const w = await mworld({ lifetime: 0 });
  await ent(w, 80); const id = (await w.db.first("SELECT id FROM reward WHERE kind = 'tier'")).id;
  await w.db.run("INSERT INTO reward (id, company_id, person_id, kind, group_key, idem_key, amount, state, created_at, sent_amount) VALUES ('rw_cover', ?, ?, 'tier', 'tier:t1:W1', 'cover', 80, 'sent', ?, 80)", w.company.id, w.people.a.id, w.clock.t);
  await assert.rejects(reissueReward(w.ctx, w.company, 'admin', { id, confirm: true }), (e) => e.code === 'already_covered');
  assert.equal((await rowOf(w, id)).state, 'failed');
});

test('S4 a dice bonus above 500 is refused when configured (and clamped at event time)', async () => {
  const w = await mworld();
  await w.db.run("UPDATE season SET mode = 'dice' WHERE company_id = ?", w.company.id);
  const code = async (p) => { try { await p; return null; } catch (e) { return e.code; } };
  await w.db.run('UPDATE company SET settings = ? WHERE id = ?', JSON.stringify({ ...JSON.parse((await w.reload()).settings || '{}'), bonus_max_pct: 300 }), w.company.id); await w.reload();
  assert.equal(await code(setup.addRateCard(w.ctx, w.company, w.admin, { active_from: 1, event_type: 'big', stage: 'done', stage_no: 1, credits: 200, state_needed: 'system' })), 'above_provider_max', '200 x 300% = 600');
  await w.db.run('UPDATE company SET settings = ? WHERE id = ?', JSON.stringify({ ...JSON.parse((await w.reload()).settings || '{}'), bonus_max_pct: 50 }), w.company.id); await w.reload();
  await setup.addRateCard(w.ctx, w.company, w.admin, { active_from: 1, event_type: 'ok', stage: 'done', stage_no: 1, credits: 400, state_needed: 'system' });
  assert.equal(await code(updateSettings(w.ctx, w.company, w.admin, { bonus_max_pct: 200 })), 'above_provider_max', '400 x 200% = 800');
  await updateSettings(w.ctx, w.company, w.admin, { bonus_max_pct: 100 }); // 400 is fine
});

test('S5 open_failed_rewards counts every failed row of a LIVE company even with the test-only switch on', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  await w.db.run("INSERT INTO reward (id, company_id, person_id, kind, group_key, idem_key, amount, state, created_at, sent_amount, attempts) VALUES ('rw_f', ?, ?, 'tier', 'g', 'kf', 50, 'failed', 1, 50, 1)", w.company.id, w.people.a.id);
  await w.db.run('UPDATE company SET live = 1 WHERE id = ?', w.company.id);
  assert.equal(await openFailedRewards(w.ctx, w.company.id), 1);
});

test('S6 mark-received closes a failed row that really landed, with a note, and nothing pays it again', async () => {
  const w = await boot({ settings: { daily_event_limit: 1000 } }); await w.login('admin');
  const f = fakeMnp({ lifetime: 0, now: () => w.clock.t });
  w.ctx.provider = () => new MoneypennyProvider({ baseUrl: 'https://mnp.test', keyId: 'k', secret: 's'.repeat(32) }, { fetchImpl: f.fetchImpl });
  w.ctx.env = { ...w.ctx.env, FUTURE_OPS: undefined };
  await w.db.run("UPDATE company SET provider = 'moneypenny' WHERE id = ?", w.company.id); await w.reload();
  const g = await grant(w.ctx, w.company, { person: w.people.a, kind: 'tier', amount: 80, idem: 's6', groupKey: 'g6', periodKey: 'W1', at: w.clock.t });
  assert.equal(g.reward.state, 'failed');
  await w.login('admin');
  assert.equal((await w.call('admin', 'POST', '/api/admin/mark-received', { id: g.reward.id })).status, 400);
  assert.equal((await w.call('admin', 'POST', '/api/admin/mark-received', { id: g.reward.id, confirm: true, note: '' })).status, 400, 'a ledger note is required');
  const ov0 = await w.call('admin', 'GET', '/api/admin/overview'); assert.ok(ov0.json.alerts.some((a) => /mark-received/.test(a) && /reissue/.test(a)));
  const ok = await w.call('admin', 'POST', '/api/admin/mark-received', { id: g.reward.id, confirm: true, note: 'ledger line 14 Nov, 80 credits' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const r = await rowOf(w, g.reward.id); assert.deepEqual([r.state, r.sent_amount, r.last_error], ['sent', 80, null]);
  assert.equal(await openFailedRewards(w.ctx, w.company.id), 0);
  assert.match(r.note, /ledger line 14 Nov/); assert.ok(await w.db.first("SELECT 1 x FROM audit WHERE action = 'reward.marked_received'"), 'an audit line (free text stays on the row)');
  assert.equal((await w.call('admin', 'POST', '/api/admin/reissue', { id: g.reward.id, confirm: true })).status, 404);
  assert.equal(f.credits(), 1);
});

test('S7 the re-issue answer says the real state: a grant that waits for the budget has paid nothing yet', async () => {
  const w = await mworld({ lifetime: 0 }, { budget: 1000 });
  await ent(w, 80); const id = (await w.db.first("SELECT id FROM reward WHERE kind = 'tier'")).id;
  w.f.lifetime = 800;
  await w.db.run('UPDATE season SET budget = 10 WHERE company_id = ?', w.company.id);
  const out = await reissueReward(w.ctx, w.company, 'admin', { id, confirm: true });
  assert.equal(out.state, 'waiting'); assert.equal(out.paid, 0);
});

test('S8 duplicate_ref: the history is read page by page (100 a page, next_before_seq) before it is called unconfirmed', async () => {
  const w = await mworld();
  w.f.lose = 1;
  const g = await grant(w.ctx, w.company, { person: w.people.a, kind: 'tier', amount: 80, idem: 's8', groupKey: 'g8', periodKey: 'W1', at: w.clock.t });
  assert.equal((await rowOf(w, g.reward.id)).state, 'queued');
  for (let i = 0; i < 130; i++) w.f.grants.push({ email: A, amount: 1, ref: 'other' + i, at: 0 }); // newer entries push ours onto page 2
  w.f.lifetime = 5000; w.f.idem.clear();
  w.clock.t += 2 * HOUR; await retryQueued(w.ctx, w.company);
  const r = await rowOf(w, g.reward.id); assert.deepEqual([r.state, r.sent_amount], ['sent', 80]);
  const h = w.f.calls.filter((c) => c.path === '/v1/history'); assert.ok(h.length >= 2 && h.every((c) => /limit=100/.test(c.q)));
});

test('S9 the account of the first try is sealed in the same update that counts the attempt', async () => {
  const w = await mworld(); w.f.down = true;
  const g = await grant(w.ctx, w.company, { person: w.people.a, kind: 'tier', amount: 20, idem: 's9', groupKey: 'g9', periodKey: 'W1', at: w.clock.t });
  const r = await rowOf(w, g.reward.id);
  assert.equal(r.attempts, 1); assert.ok(JSON.parse(r.note).acct, 'acct stored');
});

test('S10 the shop (hold, capture, release) is NOT enabled in v1: orders, items and the clock refuse or do nothing; the overview says so', async () => {
  const w = await boot({ settings: { daily_event_limit: 1000 } }); w.ctx.env = { ...w.ctx.env, FUTURE_OPS: undefined }; await w.login('admin');
  const code = async (p) => { try { await p; return null; } catch (e) { return e.code; } };
  assert.equal(await code(setup.addItem(w.ctx, w.company, w.admin, { name: 'Mug', credits: 5 })), 'not_enabled_in_v1');
  assert.equal(await code(setup.placeOrder(w.ctx, w.company, w.people.a, 'it_x')), 'not_enabled_in_v1');
  assert.equal(await code(setup.decideOrder(w.ctx, w.company, w.admin, 'or_x', true)), 'not_enabled_in_v1');
  assert.equal(await setup.finishOrders(w.ctx, w.company), 0);
  const w3 = await world({ v1: true }); assert.equal((await w3.ctx.provider(w3.company).capabilities()).spend, false);
  const items = await w.call('admin', 'GET', '/api/shop/items'); assert.equal(items.json.enabled, false); assert.deepEqual(items.json.items, []);
  const o = await w.call('admin', 'POST', '/api/shop/order', { item_id: 'it_x' }); assert.equal(o.status, 409); assert.equal(o.json.error.code, 'not_enabled_in_v1');
  const ov = await w.call('admin', 'GET', '/api/admin/overview'); assert.equal(ov.json.shop, 'not enabled in v1');
  // a live company never gets it, switch or not
  const w2 = await world({ settings: { daily_event_limit: 1000 } }); await w2.db.run('UPDATE company SET live = 1 WHERE id = ?', w2.company.id); await w2.reload();
  assert.equal(await code(setup.addItem(w2.ctx, w2.company, w2.admin, { name: 'Mug', credits: 5 })), 'not_enabled_in_v1');
});
