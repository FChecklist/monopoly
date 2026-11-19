// Round-13 money findings (audit 12A/12B). Each test pins one failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, exampleCard, SYSTEM, T0 } from './helpers.js';
import { submitEvent, resumeApproved } from '../src/events.js';
import { settleCompany, settleEntitlement } from '../src/periods.js';
import { accountRef, retryQueued, reviveFailedRewards, openReversesFailed, releasePendingHolds, grant, earnedNet } from '../src/rewards.js';
import { ProviderError } from '../src/provider/errors.js';
import { proposePenalty, approvePenalty, appealPenalty, decideAppeal, tickPenalties } from '../src/penalty.js';
import * as setup from '../src/setup.js';
import { tick } from '../src/api.js';

const DAY = 86400_000;
const wrap = (real, over) => new Proxy(real, { get: (t, k) => (k in over ? over[k] : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
const entitle = (w, e, gk = 'tier:t1:W1', person = 'a') => settleEntitlement(w.ctx, w.company, { person: w.people[person], kind: 'tier', groupKey: gk, periodKey: 'W1', entitled: e, at: w.clock.t, label: 'x' });
const provBal = async (w, person = 'a') => (await w.db.first('SELECT balance FROM stub_account WHERE ref=?', await accountRef(w.ctx, w.company, w.people[person]))).balance;
const auditN = (w, action) => w.db.first('SELECT COUNT(*) n FROM audit WHERE action=?', action).then((r) => r.n);
const holds = (w) => w.db.all("SELECT id, remaining FROM stub_hold WHERE kind='budget'");

test('T1: a reverse that keeps getting a permanent "no" after a lost reply stops after 5 tries, is surfaced, and does not spam the audit', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); const real = w.ctx.provider(w.company);
  await exampleCard(w);
  await setup.addTarget(w.ctx, w.company, w.admin, { name: 'Weekly', scope: 'person', period: 'week', event_type: 'game', stage: 'completed', tiers: [{ count: 1, bonus: 100 }], active_from: T0 - 40 * DAY });
  await submitEvent(w.ctx, w.company, SYSTEM, { person_id: w.people.a.id, event_type: 'game', stage: 'completed', ext_id: 't1', source: 'api', occurred_at: T0 });
  w.clock.t = T0 + 20 * DAY;
  await settleCompany(w.ctx, w.company, w.clock.t, { force: true });
  await w.db.run("UPDATE event SET status='reversed' WHERE ext_id='t1'");
  let calls = 0;
  w.ctx.provider = () => wrap(real, { reverse: async (x) => { calls++; if (calls === 1) { await real.reverse(x); throw new ProviderError('timeout'); } throw new ProviderError('account_closed'); } });
  for (let i = 0; i < 14; i++) await settleCompany(w.ctx, w.company, w.clock.t, { force: true });
  assert.ok(calls <= 7, 'provider calls are bounded: ' + calls);
  assert.ok((await auditN(w, 'reward.reverse_failed')) <= 5);
  assert.ok((await auditN(w, 'period.settle_error')) <= 3, 'one settle_error line per code, not per close: ' + (await auditN(w, 'period.settle_error')));
  assert.equal(await openReversesFailed(w.ctx, w.company.id), 1);
});

test('T2: a reserveBudget whose answer was lost is found and released by the tick', async () => {
  const w = await world({ budget: 1000 }); const real = w.ctx.provider(w.company);
  let n = 0;
  w.ctx.provider = () => wrap(real, { reserveBudget: async (x) => { const h = await real.reserveBudget(x); if (++n === 1) throw new ProviderError('timeout'); return h; } });
  await assert.rejects(setup.raiseBudget(w.ctx, w.company, w.admin, w.season, 2000), /timeout|reach|answer/i);
  assert.equal((await holds(w)).filter((h) => h.remaining === 2000).length, 1, 'the hold exists at the provider');
  await setup.raiseBudget(w.ctx, w.company, w.admin, w.season, 2500);
  w.clock.t += 11 * 60_000;
  await retryQueued(w.ctx, w.company);
  const live = (await w.db.first('SELECT hold_id FROM season WHERE id=?', w.season)).hold_id;
  for (const h of await holds(w)) assert.equal(h.remaining > 0, h.id === live, 'only the season hold is live: ' + h.id);
});

test('T3: a definitive "no" to the replay of a landed debit is not believed: it is retried and then handed back', async () => {
  const w = await world({ settings: { penalty_credit_loss: true } }); const real = w.ctx.provider(w.company);
  await entitle(w, 100);
  let n = 0;
  w.ctx.provider = () => wrap(real, { debit: async (x) => { n++; if (n === 1) { await real.debit(x); throw new ProviderError('timeout'); } if (n === 2) throw new ProviderError('account_closed'); return real.debit(x); } });
  const c = await proposePenalty(w.ctx, w.company, w.admin, { person_id: w.people.a.id, effect: 'credits', amount: 20, reason: 'r' });
  await approvePenalty(w.ctx, w.company, w.people.hr, c.id);
  w.clock.t += 4 * DAY; await tickPenalties(w.ctx, w.company);
  await appealPenalty(w.ctx, w.company, w.people.a, c.id); await decideAppeal(w.ctx, w.company, w.people.hr, c.id, true, 'ok');
  for (let i = 0; i < 5; i++) { w.clock.t += 6 * 3600_000; await tick(w.ctx, w.company); }
  assert.equal(await provBal(w), 100);
});

test('T4: ambiguity is remembered by attempts alone (a crash after marking, no last_error)', async () => {
  const w = await world(); const real = w.ctx.provider(w.company);
  let down = true;
  w.ctx.provider = () => wrap(real, { credit: async (x) => { if (down) throw new ProviderError('account_closed'); return real.credit(x); } });
  await w.db.run('SELECT 1');
  const g = await grant(w.ctx, w.company, { person: w.people.a, kind: 'tier', amount: 40, idem: 't4', groupKey: 'tier:t1:W1', periodKey: 'W1', at: w.clock.t, periodBonus: true, actor: 'system' });
  assert.equal(g.failed, true, 'a first, clear "no" fails the row');
  const w2 = await world(); const real2 = w2.ctx.provider(w2.company);
  w2.ctx.provider = () => wrap(real2, { credit: async () => { throw new ProviderError('provider_down'); } });
  await grant(w2.ctx, w2.company, { person: w2.people.a, kind: 'tier', amount: 40, idem: 't4b', groupKey: 'tier:t1:W1', periodKey: 'W1', at: w2.clock.t, periodBonus: true, actor: 'system' });
  await w2.db.run("UPDATE reward SET last_error = NULL WHERE idem_key = 't4b'"); // the error text is gone (a crash after the attempt was marked)
  w2.ctx.provider = () => wrap(real2, { credit: async () => { throw new ProviderError('account_closed'); } });
  await retryQueued(w2.ctx, w2.company);
  assert.equal((await w2.db.first("SELECT state FROM reward WHERE idem_key = 't4b'")).state, 'queued');
});

test('T5a: no hold_freed line is written when the provider has no holds', async () => {
  const w = await world({ budget: 1000 }); const real = w.ctx.provider(w.company);
  w.ctx.provider = () => wrap(real, { releaseHold: async () => { throw new ProviderError('provider_down'); } });
  await setup.raiseBudget(w.ctx, w.company, w.admin, w.season, 2000);
  w.ctx.provider = () => wrap(real, { capabilities: async () => ({ ...(await real.capabilities()), hold: false }) });
  assert.equal(await releasePendingHolds(w.ctx, w.company), 0);
  assert.equal(await auditN(w, 'season.hold_freed'), 0);
});

test('T5b: a non-provider error in hold housekeeping does not stop retryQueued', async () => {
  const w = await world({ budget: 1000, settings: { daily_event_limit: 1000 } }); const real = w.ctx.provider(w.company);
  await exampleCard(w);
  w.ctx.provider = () => wrap(real, { releaseHold: async () => { throw new ProviderError('provider_down'); } });
  await setup.raiseBudget(w.ctx, w.company, w.admin, w.season, 2000); // old hold stays pending
  let down = true;
  w.ctx.provider = () => wrap(real, { credit: async (x) => { if (down) throw new ProviderError('provider_down'); return real.credit(x); }, releaseHold: async () => { throw new TypeError('boom'); } });
  await submitEvent(w.ctx, w.company, SYSTEM, { person_id: w.people.a.id, event_type: 'game', stage: 'completed', ext_id: 't5b', source: 'api', occurred_at: w.clock.t });
  down = false;
  assert.equal((await retryQueued(w.ctx, w.company)).sent, 1);
});

test('T5c: a raise cannot lower a budget that a concurrent raise already moved up', async () => {
  const w = await world({ budget: 1000 }); const real = w.ctx.provider(w.company);
  w.ctx.provider = () => wrap(real, { reserveBudget: async (x) => { await w.db.run('UPDATE season SET budget = 3000 WHERE id = ?', w.season); return real.reserveBudget(x); } });
  await assert.rejects(setup.raiseBudget(w.ctx, w.company, w.admin, w.season, 2000), /budget_changed|changed/);
  assert.equal((await w.db.first('SELECT budget FROM season WHERE id=?', w.season)).budget, 3000);
});

test('T5d: retrying a raise at the same budget after the orphan hold was released never reuses the released hold', async () => {
  const w = await world({ budget: 1000 });
  const orig = w.db.batch.bind(w.db); let boom = true;
  w.db.batch = async (st) => { if (boom && st.some(([, ...p]) => p.includes('season.budget'))) { boom = false; throw new Error('crash'); } return orig(st); };
  await setup.raiseBudget(w.ctx, w.company, w.admin, w.season, 2000).catch(() => {});
  const orphan = JSON.parse((await w.db.first("SELECT result FROM provider_op WHERE kind='hold_reserve' ORDER BY rowid DESC LIMIT 1")).result).hold_id;
  w.clock.t += 11 * 60_000; await retryQueued(w.ctx, w.company);
  assert.equal((await w.db.first('SELECT remaining r FROM stub_hold WHERE id=?', orphan)).r, 0);
  await setup.raiseBudget(w.ctx, w.company, w.admin, w.season, 2000);
  const live = (await w.db.first('SELECT hold_id FROM season WHERE id=?', w.season)).hold_id;
  assert.notEqual(live, orphan);
  assert.equal((await w.db.first('SELECT remaining r FROM stub_hold WHERE id=?', live)).r > 0, true);
});

test('T6: an event whose reward could not be decided (audit busy) stays approved and is paid by the tick', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  const orig = w.db.batch.bind(w.db); let busy = true;
  w.db.batch = async (st) => { if (busy && st.some(([, ...p]) => p.includes('reward.create'))) throw new Error('audit chain is busy'); return orig(st); };
  const r = await submitEvent(w.ctx, w.company, SYSTEM, { person_id: w.people.a.id, event_type: 'game', stage: 'completed', ext_id: 't6', source: 'api', occurred_at: w.clock.t }).catch(() => null);
  const st = (await w.db.first("SELECT status FROM event WHERE ext_id='t6'"))?.status;
  assert.notEqual(st, 'applied', 'not marked applied without a decision');
  busy = false;
  await resumeApproved(w.ctx, w.company);
  assert.equal((await w.db.first("SELECT status FROM event WHERE ext_id='t6'")).status, 'applied');
  assert.equal(await provBal(w), 40);
});

test('T7: handed-back credits do not count as earned; a revive that cannot take a correction again says so', async () => {
  const w = await world();
  await entitle(w, 100);
  const mk = (await w.db.first('SELECT month_key m FROM reward LIMIT 1')).m;
  const before = await earnedNet(w.ctx, w.company.id, w.people.a.id, mk);
  await grant(w.ctx, w.company, { person: w.people.a, kind: 'penalty_return', amount: 30, idem: 't7', groupKey: 'penrev', at: w.clock.t, bypassCaps: true, actor: 'system' });
  assert.equal(await earnedNet(w.ctx, w.company.id, w.people.a.id, mk), before);

  const w2 = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w2);
  const real = w2.ctx.provider(w2.company);
  await w2.db.run("INSERT INTO correction (id, company_id, person_id, amount, state, reason, created_at) VALUES ('crx',?,?,100,'open','t',?)", w2.company.id, w2.people.a.id, w2.clock.t);
  let n = 0, fixed = false;
  w2.ctx.provider = () => wrap(real, { credit: async (x) => { if (fixed) return real.credit(x); n++; if (n === 1) { await real.credit(x); throw new ProviderError('provider_down'); } throw new ProviderError('account_closed'); } });
  await submitEvent(w2.ctx, w2.company, SYSTEM, { person_id: w2.people.a.id, event_type: 'game', stage: 'completed', ext_id: 't7', source: 'api', occurred_at: w2.clock.t });
  for (let i = 0; i < 6; i++) await tick(w2.ctx, w2.company);
  await w2.db.run("UPDATE correction SET state='cleared' WHERE id='crx'");
  fixed = true;
  await reviveFailedRewards(w2.ctx, w2.company);
  assert.equal(await auditN(w2, 'reward.take_lost'), 1);
});

test('T8: two overlapping decisions on one order call the provider once', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  await submitEvent(w.ctx, w.company, SYSTEM, { person_id: w.people.a.id, event_type: 'game', stage: 'completed', ext_id: 't8', source: 'api', occurred_at: w.clock.t });
  const it = await setup.addItem(w.ctx, w.company, w.admin, { name: 'Lunch', credits: 30 });
  const o = await setup.placeOrder(w.ctx, w.company, w.people.a, it.id);
  const real = w.ctx.provider(w.company); let cap = 0, rel = 0;
  w.ctx.provider = () => wrap(real, { captureSpend: async (x) => { cap++; await new Promise((r) => setTimeout(r, 5)); return real.captureSpend(x); }, releaseSpend: async (x) => { rel++; return real.releaseSpend(x); } });
  const res = await Promise.allSettled([setup.decideOrder(w.ctx, w.company, w.admin, o.id, true), setup.decideOrder(w.ctx, w.company, w.admin, o.id, false)]);
  assert.equal(cap + rel, 1);
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
});
