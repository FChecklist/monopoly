// Round-1 money findings: each test pins one failure. Races are real: several writers run at once on one database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, exampleCard, SYSTEM, T0 } from './helpers.js';
import { submitEvent, approveEvent, requestReversal, processReversals, appealReversal, decideReversalAppeal } from '../src/events.js';
import { settleCompany } from '../src/periods.js';
import { grant, reverseReward, releaseWaiting, capOf, MAX_CAP, sendReward } from '../src/rewards.js';
import { ProviderError } from '../src/provider/errors.js';
import { StubProvider } from '../src/provider/stub.js';
import { MoneypennyProvider } from '../src/provider/moneypenny.js';
import { getProvider } from '../src/provider/index.js';
import * as setup from '../src/setup.js';

const DAY = 86400_000;
const sumOf = (w, where, ...p) => w.db.first(`SELECT COALESCE(SUM(amount),0) s FROM reward WHERE ${where}`, ...p).then((r) => r.s);
const COUNTED = "state IN ('queued','sent','waiting','recorded')";

test('1: twenty writers at once cannot overshoot the person-month cap, the season cap or the season budget', async () => {
  const w = await world({ budget: 100, settings: { cap_person_month: 100, cap_person_season: 100 } });
  const { ctx, company } = w, a = w.people.a, b = w.people.b;
  await Promise.all(Array.from({ length: 20 }, (_, i) => grant(ctx, company, { person: a, kind: 'event', amount: 30, idem: 'race:a:' + i, groupKey: 'g', at: w.clock.t, actor: 'system' })));
  assert.ok(await sumOf(w, `person_id=? AND ${COUNTED}`, a.id) <= 100, 'person cap holds under a race');
  // season budget of 100 shared by two people: funded money never passes it
  await Promise.all(Array.from({ length: 12 }, (_, i) => grant(ctx, company, { person: i % 2 ? a : b, kind: 'event', amount: 25, idem: 'race:b:' + i, groupKey: 'g' + i, at: w.clock.t, actor: 'system' })));
  const funded = await sumOf(w, "season_id=? AND amount>0 AND state IN ('queued','sent')", w.season);
  assert.ok(funded <= 100, 'season budget holds under a race, funded=' + funded);
});

test('1: a row month cap and a day cap are enforced inside the insert, also under a race', async () => {
  const w = await world();
  const { ctx, company } = w, a = w.people.a;
  await Promise.all(Array.from({ length: 10 }, (_, i) => grant(ctx, company, { person: a, kind: 'event', amount: 20, idem: 'row:' + i, groupKey: 'card:x:y', capMonth: 50, capDay: 40, at: w.clock.t, actor: 'system' })));
  assert.ok(await sumOf(w, "person_id=? AND group_key='card:x:y' AND state IN ('queued','sent')", a.id) <= 40);
});

test('2: a period bonus outside any published season waits, and at release the season cap is checked again', async () => {
  const w = await world({ settings: { cap_person_season: 100 } });
  const { ctx, company, admin } = w, a = w.people.a;
  const early = T0 - 120 * DAY;
  const g = await grant(ctx, company, { person: a, kind: 'tier', amount: 60, idem: 'tier:nos', groupKey: 'tier:t:p', periodKey: 'P1', at: early, periodBonus: true, actor: 'system' });
  assert.ok(g.waiting, 'no season: it waits');
  assert.equal((await w.db.first('SELECT season_id, state FROM reward WHERE idem_key = ?', 'tier:nos')).season_id, null);
  // a season for that date is published later, and the person already used 80 of its 100
  await w.db.run("INSERT INTO season (id, company_id, name, starts_at, ends_at, budget, mode, status, published_at) VALUES ('se_old',?,?,?,?,?,?,?,?)", company.id, 'Old', early - 10 * DAY, early + 20 * DAY, 100000, 'steady', 'published', early);
  await w.db.run("INSERT INTO reward (id, company_id, person_id, kind, idem_key, amount, month_key, day_key, season_id, state, created_at, sent_amount) VALUES ('rw_used',?,?,'event','used:1',80,'M','D','se_old','sent',?,80)", company.id, a.id, early);
  const r = await releaseWaiting(ctx, company);
  assert.equal(r.moved, 0, 'it does not fit the season cap, so it is not paid');
  assert.equal((await w.db.first("SELECT state FROM reward WHERE idem_key='tier:nos'")).state, 'void');
  assert.equal(admin.role, 'admin');
});

test('2: a waiting period bonus that fits is released into the right season', async () => {
  const w = await world();
  const { ctx, company } = w, a = w.people.a;
  const early = T0 - 120 * DAY;
  await grant(ctx, company, { person: a, kind: 'tier', amount: 60, idem: 'tier:ok', groupKey: 'tier:t:p', periodKey: 'P1', at: early, periodBonus: true, actor: 'system' });
  await w.db.run("INSERT INTO season (id, company_id, name, starts_at, ends_at, budget, mode, status, published_at) VALUES ('se_old',?,?,?,?,?,?,?,?)", company.id, 'Old', early - 10 * DAY, early + 20 * DAY, 100000, 'steady', 'published', early);
  assert.equal((await releaseWaiting(ctx, company)).moved, 1);
  const row = await w.db.first("SELECT state, season_id FROM reward WHERE idem_key='tier:ok'");
  assert.deepEqual({ ...row }, { state: 'sent', season_id: 'se_old' });
});

test('3: a target added later never pays the months before it started', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  await exampleCard(w);
  const { ctx, company, admin } = w, a = w.people.a;
  for (let i = 1; i <= 3; i++) await submitEvent(ctx, company, SYSTEM, { person_id: a.id, event_type: 'game', stage: 'completed', ext_id: 'old' + i, source: 'api', occurred_at: T0 });
  const before = await sumOf(w, 'person_id=?', a.id);
  await setup.addTarget(ctx, company, admin, { name: 'Late', scope: 'person', period: 'month', event_type: 'game', stage: 'completed', tiers: [{ count: 1, bonus: 500 }], active_from: T0 + 40 * DAY });
  w.clock.t = T0 + 100 * DAY;
  await settleCompany(ctx, company, w.clock.t);
  assert.equal(await sumOf(w, "person_id=? AND kind='tier'", a.id), 0, 'nothing for the past');
  assert.equal(await sumOf(w, 'person_id=?', a.id), before);
});

test('4: team bonus is paid once per period: a mover and a leaver change nothing after the close', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  await exampleCard(w);
  const { ctx, company, admin } = w, a = w.people.a, b = w.people.b;
  await setup.addTarget(ctx, company, admin, { name: 'Team games', scope: 'team', period: 'month', event_type: 'game', stage: 'completed', tiers: [{ count: 2, bonus: 1000 }] });
  for (const [who, n] of [[a, 3], [b, 2]]) for (let i = 1; i <= n; i++) await submitEvent(ctx, company, SYSTEM, { person_id: who.id, event_type: 'game', stage: 'completed', ext_id: who.id + i, source: 'api', occurred_at: w.clock.t });
  w.clock.t = T0 + 45 * DAY;
  await settleCompany(ctx, company, w.clock.t);
  const team1 = await sumOf(w, "kind='team' AND state IN ('queued','sent')");
  assert.ok(team1 > 0 && team1 <= 1000, 'one pool: ' + team1);
  // a moves to a new team, b leaves the company: the closed period is not recomputed
  const t2 = await setup.createTeam(ctx, company, admin, { name: 'Ops', manager_id: null });
  await w.db.run('UPDATE app_user SET team_id = ? WHERE id = ?', t2.id, a.id);
  await w.db.run("UPDATE app_user SET status='left', left_at=? WHERE id = ?", T0 + 20 * DAY, b.id);
  await settleCompany(ctx, company, w.clock.t);
  await settleCompany(ctx, company, w.clock.t);
  assert.equal(await sumOf(w, "kind='team' AND state IN ('queued','sent')"), team1, 'no second payment, no bigger pool');
  assert.equal(await w.db.first("SELECT COUNT(*) n FROM team_period_member WHERE person_id = ?", a.id).then((r) => r.n), 1, 'one team per person per period');
});

test('5: an event under reversal notice still counts until the reversal runs', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  await exampleCard(w);
  const { ctx, company, admin } = w, a = w.people.a;
  await setup.addTarget(ctx, company, admin, { name: 'Monthly', scope: 'person', period: 'month', event_type: 'game', stage: 'completed', tiers: [{ count: 2, bonus: 100 }] });
  const ids = [];
  for (let i = 1; i <= 2; i++) ids.push((await submitEvent(ctx, company, SYSTEM, { person_id: a.id, event_type: 'game', stage: 'completed', ext_id: 'r' + i, source: 'api', occurred_at: w.clock.t })).id);
  w.clock.t = T0 + 45 * DAY;
  const tier = () => sumOf(w, "person_id=? AND group_key LIKE 'tier:%' AND state IN ('queued','sent','recorded')", a.id);
  await settleCompany(ctx, company, w.clock.t);
  assert.equal(await tier(), 100);
  await requestReversal(ctx, company, SYSTEM, ids[0], { reason: 'cancelled' });
  await settleCompany(ctx, company, w.clock.t);
  assert.equal(await tier(), 100, 'notice period: the tier is not reversed yet');
  // appeal won: still 100 and no second payment under a new key
  await appealReversal(ctx, company, a, ids[0]);
  await decideReversalAppeal(ctx, company, w.people.hr, ids[0], false);
  await settleCompany(ctx, company, w.clock.t);
  assert.equal(await tier(), 100);
  assert.equal(await w.db.first("SELECT COUNT(*) n FROM reward WHERE person_id=? AND kind='tier'", a.id).then((r) => r.n), 1);
  // second request, not appealed: reversal runs, tier is lost at the next close
  await requestReversal(ctx, company, SYSTEM, ids[0], { reason: 'cancelled' });
  w.clock.t += 4 * DAY; await processReversals(ctx, company);
  await settleCompany(ctx, company, w.clock.t);
  assert.equal(await tier(), 0);
});

test('6: two settle runs at once pay a tier once', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  await exampleCard(w);
  const { ctx, company, admin } = w, a = w.people.a;
  await setup.addTarget(ctx, company, admin, { name: 'Monthly', scope: 'person', period: 'month', event_type: 'game', stage: 'completed', tiers: [{ count: 1, bonus: 100 }, { count: 2, bonus: 250 }] });
  for (let i = 1; i <= 2; i++) await submitEvent(ctx, company, SYSTEM, { person_id: a.id, event_type: 'game', stage: 'completed', ext_id: 'c' + i, source: 'api', occurred_at: w.clock.t });
  w.clock.t = T0 + 45 * DAY;
  await Promise.all([settleCompany(ctx, company, w.clock.t), settleCompany(ctx, company, w.clock.t), settleCompany(ctx, company, w.clock.t)]);
  assert.equal(await sumOf(w, "person_id=? AND kind='tier' AND state IN ('queued','sent')", a.id), 250);
  const bal = await ctx.provider(company).getBalance({ accountRef: 'acct_' + a.id });
  assert.equal(bal.balance, await sumOf(w, "person_id=? AND state IN ('queued','sent','recorded')", a.id));
});

test('7: corrections are taken at most once, also when rewards are granted at the same time', async () => {
  const w = await world();
  const { ctx, company } = w, a = w.people.a;
  await w.db.run("INSERT INTO correction (id, company_id, person_id, amount, state, reason, created_at) VALUES ('cr_x',?,?,40,'open','t',?)", company.id, a.id, T0);
  await Promise.all(Array.from({ length: 6 }, (_, i) => grant(ctx, company, { person: a, kind: 'event', amount: 100, idem: 'cr:' + i, groupKey: 'g' + i, at: w.clock.t, actor: 'system' })));
  const c = await w.db.first("SELECT * FROM correction WHERE id='cr_x'");
  assert.ok(c.recovered <= c.amount, 'recovered ' + c.recovered);
  const offsets = await w.db.first("SELECT COALESCE(SUM(amount - sent_amount),0) s FROM reward WHERE person_id = ? AND kind = 'event'", a.id);
  assert.equal(offsets.s, c.recovered, 'what rewards withheld equals what the correction recovered');
});

const wrap = (real, over) => new Proxy(real, { get: (t, k) => (k in over ? over[k] : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
/** A provider that credits the stub and then "crashes" before we can write the receipt. */
function crashingWorld(w, { crash }) {
  const real = new StubProvider(w.db, w.company.id);
  const prov = wrap(real, { credit: async (x) => { const r = await real.credit(x); if (crash.on) throw new ProviderError('provider_down', 'crash'); return r; } });
  w.ctx.provider = () => prov;
  return real;
}
test('8: a reward the provider may already hold is never voided; it is sent and then reversed', async () => {
  const w = await world();
  const { ctx, company } = w, a = w.people.a;
  const crash = { on: true };
  const real = crashingWorld(w, { crash });
  const g = await grant(ctx, company, { person: a, kind: 'tier', amount: 70, idem: 'tier:crash', groupKey: 'tier:t:p', periodKey: 'P', at: w.clock.t, periodBonus: true, actor: 'system' });
  let row = await w.db.first('SELECT * FROM reward WHERE id = ?', g.reward.id);
  assert.equal(row.state, 'queued'); assert.ok(row.attempts > 0, 'the attempt is written before the call');
  assert.equal((await real.getBalance({ accountRef: 'acct_' + a.id })).balance, 70, 'the provider did credit');
  crash.on = false;
  const out = await reverseReward(ctx, company, row, { reason: 'tier_lost' });
  row = await w.db.first('SELECT * FROM reward WHERE id = ?', g.reward.id);
  assert.notEqual(row.state, 'void');
  assert.equal(row.reversed, 1);
  assert.equal(out.reversed, 70);
  assert.equal((await real.getBalance({ accountRef: 'acct_' + a.id })).balance, 0, 'money is back, nothing stranded');
});

test('8: while the provider is still unsure the reversal waits instead of voiding', async () => {
  const w = await world();
  const { ctx, company } = w, a = w.people.a;
  crashingWorld(w, { crash: { on: true } });
  const g = await grant(ctx, company, { person: a, kind: 'tier', amount: 20, idem: 'tier:unsure', groupKey: 'tier:t:p', periodKey: 'P', at: w.clock.t, periodBonus: true, actor: 'system' });
  const out = await reverseReward(ctx, company, await w.db.first('SELECT * FROM reward WHERE id = ?', g.reward.id), { reason: 'x' });
  assert.ok(out.skipped && out.pending);
  assert.equal((await w.db.first('SELECT state FROM reward WHERE id = ?', g.reward.id)).state, 'queued');
});

test('9: a second live Moneypenny company is refused, and a global key belongs to one named company only', async () => {
  const w = await world();
  const ins = (id, live) => w.db.run("INSERT INTO company (id, name, slug, provider, live, created_at) VALUES (?,?,?,'moneypenny',?,0)", id, id, id, live);
  await ins('co_m1', 1);
  await ins('co_m2', 0);
  await assert.rejects(w.db.run("UPDATE company SET live = 1 WHERE id = 'co_m2'"), /UNIQUE|constraint/i);
  const env = { MNP_BASE_URL: 'https://mnp.test', MNP_KEY_ID: 'k', MNP_SECRET: 's' };
  assert.throws(() => getProvider(env, w.db, { id: 'co_m1', provider: 'moneypenny' }), /No Moneypenny key/);
  assert.throws(() => getProvider({ ...env, MNP_COMPANY_ID: 'co_m1' }, w.db, { id: 'co_m2', provider: 'moneypenny' }), /No Moneypenny key/);
  assert.equal(getProvider({ ...env, MNP_COMPANY_ID: 'co_m1' }, w.db, { id: 'co_m1', provider: 'moneypenny' }).name, 'moneypenny');
  const keys = JSON.stringify({ co_m2: { key_id: 'k2', secret: 's2' } });
  assert.equal(getProvider({ ...env, MNP_KEYS: keys }, w.db, { id: 'co_m2', provider: 'moneypenny' }).cfg.keyId, 'k2');
});

test('10: dice bonus is at least 1 credit even on a 5-credit reward, and the top of the range is reserved with the base', async () => {
  const w = await world({ mode: 'dice', budget: 1000, settings: { daily_event_limit: 1000 } });
  await exampleCard(w);
  const { ctx, company } = w, a = w.people.a, mgr = w.people.mgr;
  const r = await submitEvent(ctx, company, mgr, { person_id: a.id, event_type: 'lead', stage: 'entered', ext_id: 'D1', dedupe_key: 'dice-1', source: 'manual', occurred_at: w.clock.t });
  assert.equal(r.status, 'applied');
  const bonus = await w.db.first("SELECT amount, state FROM reward WHERE person_id = ? AND kind = 'bonus_roll'", a.id);
  assert.ok(bonus && bonus.amount >= 1, 'bonus ' + bonus?.amount);
  assert.equal(bonus.state, 'sent');
});
test('10: a base that fits the budget only without room for the top bonus waits (never a bonus left waiting alone)', async () => {
  const w = await world({ mode: 'dice', budget: 12, settings: { daily_event_limit: 1000 } });
  await exampleCard(w);
  const { ctx, company } = w, a = w.people.a, mgr = w.people.mgr;
  // card pays 10; top bonus 50 percent = 5; 10 + 5 > 12 so the base waits as well
  await submitEvent(ctx, company, mgr, { person_id: a.id, event_type: 'game', stage: 'created', ext_id: 'D2', dedupe_key: 'dice-2', source: 'manual', occurred_at: w.clock.t });
  const base = await w.db.first("SELECT state FROM reward WHERE person_id = ? AND kind = 'event'", a.id);
  assert.equal(base.state, 'waiting');
});

test('11: a partial grant from Moneypenny is recorded as partial', async () => {
  const f = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, granted: 3, balance: 3 }) });
  const p = new MoneypennyProvider({ baseUrl: 'https://mnp.test', keyId: 'k', secret: 's' }, { fetchImpl: f });
  const out = await p.credit({ accountRef: 'a@b.test', amount: 5, reasonCode: 'x', ref: 'r', idem: 'i' });
  assert.equal(out.granted, 3); assert.equal(out.partial, true);
  const w = await world();
  const real = new StubProvider(w.db, w.company.id);
  const prov = wrap(real, { credit: async (x) => ({ ...(await real.credit({ ...x, amount: 3 })), granted: 3 }) });
  w.ctx.provider = () => prov;
  const g = await grant(w.ctx, w.company, { person: w.people.a, kind: 'event', amount: 5, idem: 'part:1', groupKey: 'g', at: w.clock.t, actor: 'system' });
  const row = await w.db.first('SELECT sent_amount, last_error FROM reward WHERE id = ?', g.reward.id);
  assert.deepEqual({ ...row }, { sent_amount: 3, last_error: 'partial_grant' });
});

test('14: a reward the provider refused for good is not paid again under a new key at every close', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  await exampleCard(w);
  const { ctx, company, admin } = w, a = w.people.a;
  const real = new StubProvider(w.db, w.company.id);
  let calls = 0;
  const prov = wrap(real, { credit: async (x) => { if (x.reasonCode === 'tier') { calls++; throw new ProviderError('account_closed', 'closed'); } return real.credit(x); } });
  w.ctx.provider = () => prov;
  await setup.addTarget(ctx, company, admin, { name: 'Monthly', scope: 'person', period: 'month', event_type: 'game', stage: 'completed', tiers: [{ count: 1, bonus: 100 }] });
  await submitEvent(ctx, company, SYSTEM, { person_id: a.id, event_type: 'game', stage: 'completed', ext_id: 'f1', source: 'api', occurred_at: w.clock.t });
  w.clock.t = T0 + 45 * DAY;
  for (let i = 0; i < 4; i++) await settleCompany(ctx, company, w.clock.t);
  assert.equal(calls, 1);
  assert.equal(await w.db.first("SELECT COUNT(*) n FROM reward WHERE kind='tier'").then((r) => r.n), 1);
});

test('15: a cap of 0 is not "no cap", and no cap can be set above the upper bound', () => {
  assert.equal(capOf({ cap_person_month: 0 }, 'cap_person_month'), 5000);
  assert.equal(capOf({ cap_person_month: -5 }, 'cap_person_month'), 5000);
  assert.equal(capOf({ cap_person_season: 1e12 }, 'cap_person_season'), MAX_CAP);
});
test('15: with a person cap of 0 in the settings the default cap still binds', async () => {
  const w = await world({ settings: { cap_person_month: 0 } });
  const g = await grant(w.ctx, w.company, { person: w.people.a, kind: 'event', amount: 9000, idem: 'zero:1', groupKey: 'g', at: w.clock.t, actor: 'system' });
  assert.equal(g.paid, 5000);
});

test('16: a typed-in min_approvals can never switch off the per-event cap', async () => {
  const w = await world({ settings: { daily_event_limit: 1000, cap_event: 50 } });
  const { ctx, company, admin } = w, a = w.people.a;
  await setup.addRateCard(ctx, company, admin, { event_type: 'big', stage: 'one', stage_no: 1, credits: 80, state_needed: 'auto', active_from: T0 - 30 * DAY });
  const r = await submitEvent(ctx, company, a, { person_id: a.id, event_type: 'big', stage: 'one', ext_id: 'm1', dedupe_key: 'm1', min_approvals: 2, source: 'manual', occurred_at: w.clock.t });
  assert.ok(r.ok); assert.equal(r.approvals_required, 1, 'employee-supplied approvals are ignored');
  await approveEvent(ctx, company, w.people.mgr, r.id);
  assert.equal(await sumOf(w, "person_id=? AND kind='event'", a.id), 50);
});

test('3/10 sanity: sendReward on a non-queued row does nothing', async () => {
  const w = await world();
  const g = await grant(w.ctx, w.company, { person: w.people.a, kind: 'event', amount: 5, idem: 'san:1', groupKey: 'g', at: w.clock.t, actor: 'system' });
  const again = await sendReward(w.ctx, w.company, g.reward);
  assert.equal(again.state, 'sent');
});
