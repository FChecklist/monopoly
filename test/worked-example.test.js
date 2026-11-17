// The worked example from the design report (section 4B.7): 2,275 earned, then reversals, net 1,945.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, exampleCard, SYSTEM, T0 } from './helpers.js';
import { submitEvent, approveEvent, requestReversal, approveReversal, processReversals } from '../src/events.js';
import { settleCompany } from '../src/periods.js';
import * as setup from '../src/setup.js';

const DAY = 86400_000;
const net = (w, who) => w.db.first("SELECT COALESCE(SUM(amount),0) s FROM reward WHERE person_id = ? AND state IN ('queued','sent','recorded')", w.people[who].id).then((r) => r.s);

test('worked example: 2,275 earned, 1,945 after reversals', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  const { ctx, company, admin } = w;
  await exampleCard(w);
  const wk = await setup.addTarget(ctx, company, admin, { name: 'Weekly games', scope: 'person', period: 'week', event_type: 'game', stage: 'completed', tiers: [{ count: 3, bonus: 40 }, { count: 5, bonus: 100 }], streak: { length: 4, bonus: 200 } });
  await setup.addTarget(ctx, company, admin, { name: 'Monthly games', scope: 'person', period: 'month', event_type: 'game', stage: 'completed', tiers: [{ count: 10, bonus: 300 }, { count: 20, bonus: 800 }, { count: 30, bonus: 1500 }] });
  const a = w.people.a, mgr = w.people.mgr, hr = w.people.hr;
  const ids = { entered: [], verified: [], created: [], completed: [] };
  const sub = async (actor, o) => { const r = await submitEvent(ctx, company, actor, { person_id: a.id, occurred_at: w.clock.t, ...o }); assert.ok(r.ok, JSON.stringify(r)); return r; };

  // week 1: 40 leads entered, 25 verified, 6 converted
  w.clock.t = T0 + 1 * DAY;
  for (let i = 1; i <= 40; i++) ids.entered.push((await sub(mgr, { event_type: 'lead', stage: 'entered', ext_id: 'L' + i, dedupe_key: 'prospect-' + i, source: 'manual' })).id);
  for (let i = 1; i <= 25; i++) { const r = await sub(mgr, { event_type: 'lead', stage: 'verified', ext_id: 'L' + i, source: 'manual' }); assert.equal(r.status, 'pending'); await approveEvent(ctx, company, hr, r.id); ids.verified.push(r.id); }
  for (let i = 1; i <= 6; i++) await sub(SYSTEM, { event_type: 'lead', stage: 'converted', ext_id: 'L' + i, source: 'api' });
  // four weeks of games: 2 created and 3 completed each week
  for (let wk = 0; wk < 4; wk++) {
    w.clock.t = T0 + (wk * 7 + 2) * DAY;
    for (let g = 1; g <= 2; g++) ids.created.push((await sub(mgr, { event_type: 'game', stage: 'created', ext_id: `G${wk}-${g}`, source: 'manual' })).id);
    for (let g = 1; g <= 3; g++) ids.completed.push((await sub(SYSTEM, { event_type: 'game', stage: 'completed', ext_id: `G${wk}-${g}`, source: 'api' })).id);
  }
  assert.equal(await net(w, 'a'), 1615, 'per-event subtotal');

  w.clock.t = T0 + 40 * DAY;
  await settleCompany(ctx, company, w.clock.t);
  assert.equal(await net(w, 'a'), 2275, 'total earned');
  assert.equal(await net(w, 'a'), 200 + 375 + 480 + 80 + 480 + 300 + 160 + 200);

  // the stub provider (demo wallet) agrees with what we decided to send
  const bal = await ctx.provider(company).getBalance({ accountRef: 'acct_' + a.id });
  assert.equal(bal.balance, 2275);

  // 2 verified leads found fake (20 each = entered 5 + verified 15): manager records, HR approves
  for (const lead of [0, 1]) for (const evId of [ids.entered[lead], ids.verified[lead]]) {
    await requestReversal(ctx, company, mgr, evId, { reason: 'fake lead' });
    await approveReversal(ctx, company, hr, evId);
  }
  assert.equal(await net(w, 'a'), 2275 - 40);
  // 1 game cancelled after completion (10 + 40): system-confirmed, 3 days notice
  await requestReversal(ctx, company, SYSTEM, ids.created[0], { reason: 'cancelled' });
  await requestReversal(ctx, company, SYSTEM, ids.completed[0], { reason: 'cancelled' });
  assert.equal(await processReversals(ctx, company), 0, 'not before the notice is over');
  w.clock.t += 4 * DAY;
  assert.equal(await processReversals(ctx, company), 2);
  assert.equal(await net(w, 'a'), 2275 - 40 - 50);
  // re-check at close: that week falls to 2 games (tier -40) and the 4-week streak breaks (-200). Month still has 11 games, tier 1 holds.
  await settleCompany(ctx, company, w.clock.t);
  assert.equal(await net(w, 'a'), 1945);
  const bal2 = await ctx.provider(company).getBalance({ accountRef: 'acct_' + a.id });
  assert.equal(bal2.balance, 1945, 'provider and decisions agree');
  // settling again changes nothing
  await settleCompany(ctx, company, w.clock.t);
  assert.equal(await net(w, 'a'), 1945);
});
