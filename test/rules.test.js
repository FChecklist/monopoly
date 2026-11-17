// Rate card maths, periods, caps, idempotency, team split, versioning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, exampleCard, SYSTEM, T0 } from './helpers.js';
import { submitEvent, approveEvent } from '../src/events.js';
import { splitTeamBonus, settleCompany } from '../src/periods.js';
import { periodOf, DAY } from '../src/util.js';
import * as setup from '../src/setup.js';
import { grant } from '../src/rewards.js';

test('team split from the report: 494 / 313 / 193 / 0, sums to 1,000', () => {
  const m = splitTeamBonus(1000, [{ id: 'A', events: 12 }, { id: 'B', events: 6 }, { id: 'C', events: 2 }, { id: 'D', events: 0 }], 60);
  assert.deepEqual([m.get('A'), m.get('B'), m.get('C'), m.get('D')], [494, 313, 193, 0]);
  assert.equal([...m.values()].reduce((a, b) => a + b, 0), 1000);
});
test('team split always sums exactly (many shapes)', () => {
  for (let n = 1; n <= 9; n++) for (const total of [1, 7, 999, 1000, 12345]) {
    const mem = Array.from({ length: n }, (_, i) => ({ id: 'm' + i, events: (i * 7) % 5, weight: 0.3 + (i % 3) * 0.3 }));
    const m = splitTeamBonus(total, mem, 60);
    const sum = [...m.values()].reduce((a, b) => a + b, 0);
    if (mem.some((x) => x.events > 0)) assert.equal(sum, total); else assert.equal(sum, 0);
    for (const x of mem) if (x.events === 0) assert.equal(m.get(x.id), 0, 'idle member gets nothing');
  }
});
test('periods: week starts Monday in India time, financial year follows the setting', () => {
  const p = periodOf('week', Date.parse('2026-11-08T23:30:00+05:30')); // Sunday night
  assert.equal(p.key, 'W2026-11-02');
  assert.equal(periodOf('week', Date.parse('2026-11-09T00:00:00+05:30')).key, 'W2026-11-09');
  assert.equal(periodOf('month', Date.parse('2026-12-31T23:59:00+05:30')).key, 'M2026-12');
  assert.equal(periodOf('quarter', Date.parse('2026-11-17T12:00:00+05:30'), 4).key, 'Q2026-3'); // Oct-Dec is Q3 of an April year
  assert.equal(periodOf('quarter', Date.parse('2027-02-01T12:00:00+05:30'), 4).key, 'Q2026-4');
  assert.equal(periodOf('half', Date.parse('2026-11-17T12:00:00+05:30'), 4).key, 'H2026-2');
  assert.equal(periodOf('year', Date.parse('2027-03-31T12:00:00+05:30'), 4).key, 'Y2026-1');
  assert.equal(periodOf('year', Date.parse('2027-04-01T12:00:00+05:30'), 4).key, 'Y2027-1');
  assert.equal(periodOf('quarter', Date.parse('2026-11-17T12:00:00+05:30'), 1).key, 'Q2026-4');
});

test('stage credits are steps: a lead earns 5, then 15, then 80 (total 100); each stage pays once', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  await exampleCard(w);
  const { ctx, company } = w, a = w.people.a, mgr = w.people.mgr, hr = w.people.hr;
  const e = await submitEvent(ctx, company, mgr, { person_id: a.id, event_type: 'lead', stage: 'entered', ext_id: 'X1', dedupe_key: 'p1', source: 'manual', occurred_at: w.clock.t });
  const v = await submitEvent(ctx, company, mgr, { person_id: a.id, event_type: 'lead', stage: 'verified', ext_id: 'X1', source: 'manual', occurred_at: w.clock.t });
  await approveEvent(ctx, company, hr, v.id);
  const c = await submitEvent(ctx, company, SYSTEM, { person_id: a.id, event_type: 'lead', stage: 'converted', ext_id: 'X1', source: 'api', occurred_at: w.clock.t });
  assert.ok(e.ok && v.ok && c.ok);
  const sum = async () => (await w.db.first("SELECT SUM(amount) s FROM reward WHERE person_id = ? AND state IN ('queued','sent')", a.id)).s;
  assert.equal(await sum(), 100);
  // the same stage again is a duplicate and pays nothing
  const again = await submitEvent(ctx, company, SYSTEM, { person_id: a.id, event_type: 'lead', stage: 'converted', ext_id: 'X1', source: 'api', occurred_at: w.clock.t });
  assert.equal(again.reason, 'duplicate');
  assert.equal(await sum(), 100);
});

test('per-row monthly cap and person monthly cap hold', async () => {
  const w = await world({ settings: { daily_event_limit: 1000, cap_person_month: 250 } });
  await exampleCard(w);
  const { ctx, company } = w, a = w.people.a, mgr = w.people.mgr;
  for (let i = 1; i <= 80; i++) await submitEvent(ctx, company, mgr, { person_id: a.id, event_type: 'lead', stage: 'entered', ext_id: 'C' + i, dedupe_key: 'cap' + i, source: 'manual', occurred_at: w.clock.t });
  const s = (await w.db.first("SELECT SUM(amount) s FROM reward WHERE person_id = ? AND state IN ('queued','sent')", a.id)).s;
  assert.equal(s, 250, 'person cap of 250 wins over the row cap of 300');
  const bal = await ctx.provider(company).getBalance({ accountRef: 'acct_' + a.id });
  assert.equal(bal.balance, 250);
});

test('same reward key twice pays once (idempotent), and amounts must be whole credits', async () => {
  const w = await world();
  const { ctx, company } = w, a = w.people.a;
  const p = { person: a, kind: 'event', amount: 30, idem: 'event:evX:s', at: w.clock.t, actor: 'system' };
  const r1 = await grant(ctx, company, p), r2 = await grant(ctx, company, p);
  assert.equal(r1.paid, 30); assert.ok(r2.replay);
  assert.equal((await ctx.provider(company).getBalance({ accountRef: 'acct_' + a.id })).balance, 30);
  assert.equal((await grant(ctx, company, { ...p, idem: 'k2', amount: 1.5 })).paid, 0);
  assert.equal((await grant(ctx, company, { ...p, idem: 'k3', amount: -5 })).paid, 0);
});

test('changing the rate card never changes the past; stricter changes wait for next month', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  await exampleCard(w);
  const { ctx, company, admin } = w, a = w.people.a, mgr = w.people.mgr;
  await submitEvent(ctx, company, mgr, { person_id: a.id, event_type: 'game', stage: 'created', ext_id: 'g1', source: 'manual', occurred_at: w.clock.t });
  const old = await w.db.first("SELECT rate_version, amount FROM reward WHERE person_id = ?", a.id);
  assert.equal(old.amount, 10);
  const stricter = await setup.addRateCard(ctx, company, admin, { event_type: 'game', stage: 'created', stage_no: 1, credits: 4, cap_month: 200 });
  assert.ok(stricter.active_from >= periodOf('month', w.clock.t).end, 'a stricter card starts next month');
  const kinder = await setup.addRateCard(ctx, company, admin, { event_type: 'game', stage: 'created', stage_no: 1, credits: 12, cap_month: 200 });
  assert.equal(kinder.version, 3);
  const still = await w.db.first("SELECT amount, rate_version FROM reward WHERE person_id = ?", a.id);
  assert.deepEqual(still, old, 'the old reward row is untouched');
});

test('tier pays the difference once; settling twice changes nothing; tier lost is reversed at close', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  await exampleCard(w);
  const { ctx, company, admin } = w, a = w.people.a;
  await setup.addTarget(ctx, company, admin, { name: 'Monthly games', scope: 'person', period: 'month', event_type: 'game', stage: 'completed', tiers: [{ count: 2, bonus: 100 }, { count: 4, bonus: 250 }] });
  const ids = [];
  for (let i = 1; i <= 4; i++) ids.push((await submitEvent(ctx, company, SYSTEM, { person_id: a.id, event_type: 'game', stage: 'completed', ext_id: 'T' + i, source: 'api', occurred_at: w.clock.t })).id);
  w.clock.t = T0 + 45 * DAY;
  await settleCompany(ctx, company, w.clock.t);
  const tierSum = async () => (await w.db.first("SELECT COALESCE(SUM(amount),0) s FROM reward WHERE person_id = ? AND group_key LIKE 'tier:%' AND state IN ('queued','sent','recorded')", a.id)).s;
  assert.equal(await tierSum(), 250);
  await settleCompany(ctx, company, w.clock.t);
  assert.equal(await tierSum(), 250, 'no double pay');
  const { requestReversal, processReversals } = await import('../src/events.js');
  await requestReversal(ctx, company, SYSTEM, ids[0], { reason: 'cancelled' });
  await requestReversal(ctx, company, SYSTEM, ids[1], { reason: 'cancelled' });
  w.clock.t += 4 * DAY; await processReversals(ctx, company);
  await settleCompany(ctx, company, w.clock.t);
  assert.equal(await tierSum(), 100, '4 -> 2 events: tier 2 reversed, tier 1 stays');
  const ev = await w.db.first("SELECT SUM(amount) s FROM reward WHERE person_id = ? AND state IN ('queued','sent','recorded')", a.id);
  assert.equal((await ctx.provider(company).getBalance({ accountRef: 'acct_' + a.id })).balance, ev.s);
});

test('streak with a freeze: one missed week per quarter does not break it', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  await exampleCard(w);
  const { ctx, company, admin } = w, a = w.people.a;
  await setup.addTarget(ctx, company, admin, { name: 'Weekly', scope: 'person', period: 'week', event_type: 'game', stage: 'completed', tiers: [{ count: 1, bonus: 10 }], streak: { length: 3, bonus: 500, freeze_per_quarter: 1 } });
  for (const wk of [0, 1, 3]) { // weeks 0,1 hit, week 2 missed (frozen), week 3 hit => 3 hits in a row with one freeze
    w.clock.t = T0 + (wk * 7 + 1) * DAY;
    await submitEvent(ctx, company, SYSTEM, { person_id: a.id, event_type: 'game', stage: 'completed', ext_id: 'W' + wk, source: 'api', occurred_at: w.clock.t });
  }
  w.clock.t = T0 + 60 * DAY;
  await settleCompany(ctx, company, w.clock.t);
  const st = (await w.db.first("SELECT COALESCE(SUM(amount),0) s FROM reward WHERE person_id = ? AND kind = 'streak'", a.id)).s;
  assert.equal(st, 500);
});
