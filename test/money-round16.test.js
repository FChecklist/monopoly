// Round-16 (credit-path audit 15): shop orders vs expiring holds, v1 delta settlement, partial grants, lazy tick, revive, error mapping, overview.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, exampleCard, SYSTEM } from './helpers.js';
import { boot } from './webhelp.js';
import { submitEvent } from '../src/events.js';
import { settleEntitlement } from '../src/periods.js';
import { accountRef, grant, sendReward, retryQueued, reviveFailedRewards, openPartialGrants, releaseWaiting } from '../src/rewards.js';
import { ProviderError } from '../src/provider/errors.js';
import { MoneypennyProvider, mapStatus } from '../src/provider/moneypenny.js';
import { providerCapWarnings } from '../src/config.js';
import { correctDetails } from '../src/people.js';
import { tick } from '../src/api.js';
import * as setup from '../src/setup.js';

const HOUR = 3600_000, DAY = 86400_000;
const wrap = (real, over) => new Proxy(real, { get: (t, k) => (k in over ? over[k] : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
const entitle = (w, e, gk = 'tier:t1:W1', person = 'a') => settleEntitlement(w.ctx, w.company, { person: w.people[person], kind: 'tier', groupKey: gk, periodKey: 'W1', entitled: e, at: w.clock.t, label: 'x' });
const net = async (w) => (await w.db.first("SELECT COALESCE(SUM(amount),0) s FROM reward WHERE group_key='tier:t1:W1' AND state IN ('queued','sent','waiting','recorded')")).s;
const corr = async (w) => (await w.db.first('SELECT COALESCE(SUM(amount),0) a FROM correction')).a;
const auditN = (w, action) => w.db.first('SELECT COUNT(*) n FROM audit WHERE action=?', action).then((r) => r.n);

// a fake Moneypenny endpoint for the real adapter
const mnp = (handler) => new MoneypennyProvider({ baseUrl: 'https://mnp.test', keyId: 'k', secret: 's'.repeat(32) }, { fetchImpl: async (url, init) => {
  const path = new URL(url).pathname; const r = handler(path, init) ?? { status: 200, body: { ok: true } };
  return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, json: async () => { if (r.body === undefined) throw new SyntaxError('x'); return r.body; } };
} });
const fails = async (p, code, retriable) => { try { await p; assert.fail('expected a ProviderError'); } catch (e) { assert.ok(e instanceof ProviderError, String(e)); assert.equal(e.code, code); assert.equal(e.retriable, retriable); } };

test('Y1 X1/X7: hold and item answers are definitive for orders only; other codes keep their meaning; a reply without hold_id is a retriable bad_response', async () => {
  assert.equal(mapStatus(410), 'hold_expired'); assert.equal(mapStatus(409, 'hold_closed'), 'hold_expired');
  assert.equal(mapStatus(409, 'no_item'), 'no_item'); assert.equal(mapStatus(409, 'price_changed'), 'price_changed');
  assert.equal(mapStatus(403, 'blocked_domain'), 'misconfigured'); assert.equal(mapStatus(503, 'paused'), 'provider_down');
  assert.equal(mapStatus(400, 'paused'), 'unavailable'); assert.equal(mapStatus(400, 'paused_global'), 'unavailable');
  assert.equal(mapStatus(400, 'too_many_events'), 'rate_limited'); assert.equal(mapStatus(400, 'duplicate_ref'), 'duplicate');
  assert.equal(mapStatus(409, 'idempotency_conflict'), 'idempotency_conflict');
  const p = mnp((path) => (path === '/v1/credit' || path === '/v1/spend/capture' ? { status: 410, body: { ok: false, error: { code: 'hold_closed' } } } : { status: 200, body: { ok: true } }));
  await fails(p.credit({ accountRef: 'a@x.test', amount: 5, ref: 'r', idem: 'i' }), 'misconfigured', true); // on a credit call it is OUR setup, never "the order's hold"
  await fails(p.captureSpend({ holdId: 'h', idem: 'c' }), 'hold_expired', false);
  await fails(p.reserveSpend({ accountRef: 'a@x.test', amount: 5, ref: 'o', idem: 'o' }), 'bad_response', true);
  await fails(mnp(() => ({ status: 200, body: { ok: true, status: 'pending' } })).captureSpend({ holdId: 'h', idem: 'c' }), 'bad_response', true);
});

test('Y2 X1: capturing an order whose hold expired makes the order "expired", once, and the provider is not asked again', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); const real = w.ctx.provider(w.company);
  await entitle(w, 100);
  const it = await setup.addItem(w.ctx, w.company, w.admin, { name: 'Lunch', credits: 30 });
  const o = await setup.placeOrder(w.ctx, w.company, w.people.a, it.id);
  let caps = 0;
  w.ctx.provider = () => wrap(real, { captureSpend: async () => { caps++; throw new ProviderError('hold_expired', 'gone'); } });
  const r = await setup.decideOrder(w.ctx, w.company, w.admin, o.id, true);
  assert.equal(r.state, 'expired');
  assert.equal((await w.db.first('SELECT state FROM catalogue_order WHERE id=?', o.id)).state, 'expired');
  for (let i = 0; i < 3; i++) { w.clock.t += 2 * HOUR; await setup.finishOrders(w.ctx, w.company); }
  assert.equal(caps, 1, 'one call, no loop');
  assert.equal(await auditN(w, 'order.expired'), 1);
});

test('Y3 X1: an order step that cannot finish for a day is shown in the overview; a refused decision op is not left behind', async () => {
  const w = await boot({ settings: { daily_event_limit: 1000 } }); await w.login('admin');
  const it = await setup.addItem(w.ctx, w.company, w.admin, { name: 'Lunch', credits: 30 });
  await w.db.run("INSERT INTO provider_op (id, company_id, kind, key, subject, params, state, tries, budget, settled, claim_until, created_at, updated_at) VALUES ('po_o', ?, 'order_decide', 'odec:x', 'x', '{\"accept\":true,\"hold\":\"hx\"}', 'unknown', 5, 5, 0, 0, ?, ?)", w.company.id, w.clock.t - 2 * DAY, w.clock.t - 2 * DAY);
  const ov = await w.call('admin', 'GET', '/api/admin/overview');
  assert.equal(ov.json.open_orders_stuck, 1);
  assert.ok(ov.json.alerts.some((a) => /shop order/.test(a)));
  await w.db.run("INSERT INTO provider_op (id, company_id, kind, key, subject, params, state, tries, budget, settled, claim_until, created_at, updated_at, last_code) VALUES ('po_r', ?, 'order_decide', 'odec:y', 'y', '{}', 'refused', 1, 5, 0, 0, 1, 1, 'bad_request')", w.company.id);
  await setup.finishOrders(w.ctx, w.company);
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM provider_op WHERE key='odec:y'")).n, 0, 'the refused decision is dropped so a new decision can be made');
  assert.ok(it.id);
});

test('Y4 X2: a drop in v1 is a DELTA: 3000 -> 2600 owes 400, pays nothing again, and the cap counts net', async () => {
  const w = await world({ v1: true, settings: { cap_period_bonus_person_period: 3000, cap_person_month: 100000, cap_person_season: 100000, cap_event: 100000 } });
  await entitle(w, 3000);
  const bal = async () => (await w.db.first('SELECT balance FROM stub_account WHERE ref=?', await accountRef(w.ctx, w.company, w.people.a))).balance;
  const after = await bal();
  await entitle(w, 2600);
  assert.equal(await corr(w), 400); assert.equal(await net(w), 2600); assert.equal(await bal(), after, 'nothing re-granted');
  await entitle(w, 2600); assert.equal(await corr(w), 400, 'idempotent: no second correction');
  await entitle(w, 3000); // regained tier: the 400 is topped up although the cap is 3000 (net 2600 counts)
  assert.equal(await net(w), 3000);
  await entitle(w, 2600); // and dropped again: a second, separate correction
  assert.equal(await corr(w), 800); assert.equal(await net(w), 2600);
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM reward WHERE kind='tier' AND reversed=1")).n, 0, 'the original rows are never reversed in v1');
});

test('Y5 X2: a partial drop and a drop to zero; an unsent row is simply voided', async () => {
  const w = await world({ v1: true, settings: { cap_person_month: 100000 } });
  await entitle(w, 100); await entitle(w, 40);
  assert.equal(await corr(w), 60); assert.equal(await net(w), 40);
  await entitle(w, 0);
  assert.equal(await corr(w), 100); assert.equal(await net(w), 0);
  const w2 = await world({ v1: true });
  const real = w2.ctx.provider(w2.company); let down = true;
  w2.ctx.provider = () => wrap(real, { credit: async (x) => { if (down) throw new ProviderError('provider_down'); return real.credit(x); } });
  await w2.db.run("UPDATE app_user SET provider_account_ref = NULL");
  await grant(w2.ctx, w2.company, { person: w2.people.a, kind: 'tier', amount: 50, idem: 'y5', groupKey: 'tier:t1:W1', periodKey: 'W1', at: w2.clock.t, periodBonus: true });
  // a queued row that was tried (attempts 1) may have landed: it is not voided; the delta is owed instead
  await entitle(w2, 0);
  assert.equal(await corr(w2), 50);
});

test('Y6 X3: a partial grant is topped up later under its own key; a zero grant moves to a new key; the overview counts the open remainder', async () => {
  const w = await world({ cap_person_month: 100000 }); const real = w.ctx.provider(w.company);
  const calls = []; let mode = 'partial';
  w.ctx.provider = () => wrap(real, { credit: async (x) => {
    calls.push([x.amount, x.idem]);
    if (mode === 'partial') { mode = 'zero'; return { entry_id: x.idem, granted: 10, partial: true }; }
    if (mode === 'zero') { mode = 'full'; throw new ProviderError('cap_reached'); }
    return { entry_id: x.idem, granted: x.amount };
  } });
  const g = await grant(w.ctx, w.company, { person: w.people.a, kind: 'tier', amount: 40, idem: 'y6', groupKey: 'g6', periodKey: 'W1', at: w.clock.t });
  let row = await w.db.first('SELECT sent_amount, last_error, state FROM reward WHERE id=?', g.reward.id);
  assert.deepEqual([row.state, row.sent_amount, row.last_error], ['sent', 10, 'partial_grant']);
  assert.equal(await openPartialGrants(w.ctx, w.company.id), 1);
  await retryQueued(w.ctx, w.company);
  assert.equal(calls.length, 1, 'not retried inside 6 hours');
  w.clock.t += 7 * HOUR; await retryQueued(w.ctx, w.company); // remainder 30, key y6:r0 -> zero grant
  w.clock.t += 7 * HOUR; await retryQueued(w.ctx, w.company); // new key y6:r1 -> paid
  assert.deepEqual(calls.map((c) => c[1]), ['y6', 'y6:r0', 'y6:r1']); assert.equal(calls[2][0], 30);
  row = await w.db.first('SELECT sent_amount, last_error FROM reward WHERE id=?', g.reward.id);
  assert.deepEqual([row.sent_amount, row.last_error], [40, null]);
  assert.equal(await openPartialGrants(w.ctx, w.company.id), 0);
});

test('Y7 X3: the provider-cap warning names every game cap above Moneypenny\'s own limits', async () => {
  const warn = providerCapWarnings({ provider: 'moneypenny', settings: '{}' });
  assert.equal(warn.length, 3);
  assert.deepEqual(providerCapWarnings({ provider: 'stub', settings: '{}' }), []);
});

test('Y8 X4: a signed-in request runs a small tick when none ran for 5 minutes (one winner), and the overview shows when the clock last ran', async () => {
  const w = await boot({ settings: { daily_event_limit: 1000 } });
  w.ctx.env = { ...w.ctx.env, LAZY_TICK: '1' };
  await w.login('admin');
  const real = w.ctx.provider(w.company); let down = true;
  w.ctx.provider = () => wrap(real, { credit: async (x) => { if (down) throw new ProviderError('provider_down'); return real.credit(x); } });
  await grant(w.ctx, w.company, { person: w.people.a, kind: 'tier', amount: 20, idem: 'y8', groupKey: 'g8', periodKey: 'W1', at: w.clock.t });
  assert.equal((await w.db.first("SELECT state FROM reward WHERE idem_key='y8'")).state, 'queued');
  down = false; w.clock.t += 6 * 60_000;
  const ov = await w.call('admin', 'GET', '/api/admin/overview');
  assert.equal((await w.db.first("SELECT state FROM reward WHERE idem_key='y8'")).state, 'sent', 'the lazy tick sent it');
  assert.equal(ov.json.last_tick_at, w.clock.t); assert.equal(ov.json.tick_stale, false);
  const t1 = (await w.db.first('SELECT last_tick_at t FROM company')).t;
  w.clock.t += 60_000; await w.call('admin', 'GET', '/api/admin/overview');
  assert.equal((await w.db.first('SELECT last_tick_at t FROM company')).t, t1, 'not again inside 5 minutes');
  w.ctx.env = { ...w.ctx.env, LAZY_TICK: '0' };
  w.clock.t += 2 * HOUR;
  const stale = await w.call('admin', 'GET', '/api/admin/overview');
  assert.equal(stale.json.tick_stale, true); assert.ok(stale.json.alerts.some((a) => /clock/.test(a)));
});

test('Y9 X5: a revived row whose first try was refused cleanly is recomputed fresh under a new key; beyond five revives needs force', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  const real = w.ctx.provider(w.company);
  await w.db.run("INSERT INTO correction (id, company_id, person_id, amount, state, reason, created_at) VALUES ('cry',?,?,100,'open','t',?)", w.company.id, w.people.a.id, w.clock.t);
  let n = 0, fixed = false; const sent = [];
  w.ctx.provider = () => wrap(real, { credit: async (x) => { if (!fixed) { n++; throw new ProviderError('account_closed'); } sent.push([x.amount, x.idem]); return real.credit(x); } });
  await submitEvent(w.ctx, w.company, SYSTEM, { person_id: w.people.a.id, event_type: 'game', stage: 'completed', ext_id: 'y9', source: 'api', occurred_at: w.clock.t });
  const row0 = await w.db.first("SELECT id, amount, attempts, state FROM reward WHERE kind='event'");
  assert.equal(row0.state, 'failed'); assert.equal(row0.attempts, 1);
  await w.db.run("UPDATE correction SET state='cleared' WHERE id='cry'"); // the correction is gone: its take cannot be repeated
  fixed = true;
  await reviveFailedRewards(w.ctx, w.company);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], row0.amount, 'the full amount is sent (fresh), not the reduced first amount');
  assert.match(sent[0][1], /:v1$/, 'under a new key');
  assert.equal(await auditN(w, 'reward.take_lost'), 0);
  // force
  await w.db.run("UPDATE reward SET state='failed', note=? WHERE id=?", JSON.stringify({ revives: 5 }), row0.id);
  assert.equal((await reviveFailedRewards(w.ctx, w.company)).revived, 0);
  assert.equal((await reviveFailedRewards(w.ctx, w.company, 'admin', { force: true })).revived, 1);
});

test('Y10 X6: a queued reward of an erased person is voided with a reason (no throw), and a new e-mail clears the cached provider account', async () => {
  const w = await world();
  const real = w.ctx.provider(w.company);
  w.ctx.provider = () => wrap(real, { credit: async () => { throw new ProviderError('provider_down'); } });
  const g = await grant(w.ctx, w.company, { person: w.people.b, kind: 'tier', amount: 20, idem: 'y10', groupKey: 'g10', periodKey: 'W1', at: w.clock.t });
  assert.equal(g.reward.state, 'queued');
  await w.db.run('UPDATE reward SET attempts = 0 WHERE id = ?', g.reward.id); // never tried: nothing can have landed
  await w.db.run('UPDATE app_user SET erased_at = ? WHERE id = ?', w.clock.t, w.people.b.id);
  const out = await sendReward(w.ctx, w.company, await w.db.first('SELECT * FROM reward WHERE id=?', g.reward.id));
  assert.equal(out.state, 'void'); assert.equal(out.last_error, 'person_erased');
  await accountRef(w.ctx, w.company, await w.db.first('SELECT * FROM app_user WHERE id=?', w.people.a.id));
  assert.ok((await w.db.first('SELECT provider_account_ref r FROM app_user WHERE id=?', w.people.a.id)).r);
  await correctDetails(w.ctx, w.company, w.admin, w.people.a.id, { email: 'new-a@acme.test' });
  assert.equal((await w.db.first('SELECT provider_account_ref r FROM app_user WHERE id=?', w.people.a.id)).r, null);
});

test('Y11 X7: a provider that says "duplicate" for a credit has it already: the row is marked sent, not failed', async () => {
  const w = await world(); const real = w.ctx.provider(w.company);
  w.ctx.provider = () => wrap(real, { credit: async () => { throw new ProviderError('duplicate'); } });
  const g = await grant(w.ctx, w.company, { person: w.people.a, kind: 'tier', amount: 20, idem: 'y11', groupKey: 'g11', periodKey: 'W1', at: w.clock.t });
  assert.equal(g.reward.state, 'sent');
});

test('Y12 X8/X9: me/rewards shows sent_amount; silent voids are counted; a failed period row is not auto-revived when it was tried more than once', async () => {
  const w = await boot(); await w.login('admin'); await w.login('a');
  await w.db.run("INSERT INTO reward (id, company_id, person_id, kind, group_key, idem_key, amount, state, last_error, reversed, created_at, sent_amount) VALUES ('rw_v', ?, ?, 'tier', 'g', 'v1', 10, 'void', 'season_closed', 1, 1, 10)", w.company.id, w.people.a.id);
  const ov = await w.call('admin', 'GET', '/api/admin/overview');
  assert.equal(ov.json.rewards_voided_silent, 1);
  const real = w.ctx.provider(w.company);
  await w.db.run("UPDATE app_user SET provider_account_ref = NULL");
  w.ctx.provider = () => wrap(real, { credit: async (x) => ({ entry_id: x.idem, granted: 4, partial: true }) });
  await grant(w.ctx, w.company, { person: w.people.a, kind: 'tier', amount: 10, idem: 'y12', groupKey: 'g12', periodKey: 'W1', at: w.clock.t });
  const me = await w.call('a', 'GET', '/api/me/rewards');
  assert.ok(me.json.rewards.some((r) => r.sent_amount === 4));
  // never auto-revive an ambiguous failed period row
  const w2 = await world({ v1: true });
  await w2.db.run("INSERT INTO reward (id, company_id, person_id, kind, group_key, idem_key, amount, period_key, state, last_error, attempts, created_at, sent_amount) VALUES ('rw_f', ?, ?, 'tier', 'tier:t1:W1', 'f1', 10, 'W1', 'failed', 'bad_request', 3, 1, 10)", w2.company.id, w2.people.a.id);
  w2.clock.t += 3 * DAY;
  await entitle(w2, 10);
  assert.equal((await w2.db.first("SELECT COUNT(*) n FROM reward WHERE idem_key LIKE '%:x%'")).n, 0);
  assert.ok(releaseWaiting && tick);
});
