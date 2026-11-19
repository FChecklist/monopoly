// Round-10 money findings (audit 9A/9B). Each test pins one failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, exampleCard, SYSTEM, T0 } from './helpers.js';
import { submitEvent } from '../src/events.js';
import { settleCompany, settleEntitlement } from '../src/periods.js';
import { accountRef, retryQueued, openFailedRewards } from '../src/rewards.js';
import { ProviderError } from '../src/provider/errors.js';
import { proposePenalty, approvePenalty, appealPenalty, decideAppeal, tickPenalties, restoreDebit, openRestoresFailed } from '../src/penalty.js';
import * as setup from '../src/setup.js';
import { tick } from '../src/api.js';

const DAY = 86400_000;
const wrap = (real, over) => new Proxy(real, { get: (t, k) => (k in over ? over[k] : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
const auditCount = (w, action) => w.db.first('SELECT COUNT(*) n FROM audit WHERE company_id=? AND action=?', w.company.id, action).then((r) => r.n);
const entitle = (w, e, gk = 'tier:t1:W1', person = 'a') => settleEntitlement(w.ctx, w.company, { person: w.people[person], kind: 'tier', groupKey: gk, periodKey: 'W1', entitled: e, at: w.clock.t, label: 'x' });
const provBal = async (w, person = 'a') => (await w.db.first('SELECT balance FROM stub_account WHERE ref=?', await accountRef(w.ctx, w.company, w.people[person]))).balance;
async function paidTier() {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  await exampleCard(w);
  await setup.addTarget(w.ctx, w.company, w.admin, { name: 'Weekly', scope: 'person', period: 'week', event_type: 'game', stage: 'completed', tiers: [{ count: 1, bonus: 40 }, { count: 2, bonus: 100 }], active_from: T0 - 40 * DAY });
  for (const id of ['r10', 'r10b']) await submitEvent(w.ctx, w.company, SYSTEM, { person_id: w.people.a.id, event_type: 'game', stage: 'completed', ext_id: id, source: 'api', occurred_at: T0 });
  w.clock.t = T0 + 20 * DAY;
  return w;
}
const settle = (w) => settleCompany(w.ctx, w.company, w.clock.t, { force: true });

test('P2: an overpay that is kept (season closed) leaves one audit line with the amount, and shows in the report', async () => {
  const w = await paidTier();
  await settle(w);
  await setup.closeSeason(w.ctx, w.company, w.admin, w.season);
  await w.db.run("UPDATE event SET status='reversed' WHERE ext_id='r10b'");
  const r1 = await settle(w);
  assert.equal(r1.reversal_kept, 1); assert.equal(r1.reversal_kept_amount, 60);
  assert.equal(await auditCount(w, 'period.reversal_kept'), 1);
  const line = await w.db.first("SELECT data FROM audit WHERE action='period.reversal_kept'");
  assert.equal(JSON.parse(line.data).amount, 60);
  await settle(w);
  assert.equal(await auditCount(w, 'period.reversal_kept'), 1, 'once per key');
});

test('P3: the restore_pending marker is written BEFORE the credit, so a failing receipt (audit busy) is finished by the tick, once', async () => {
  const w = await world({ settings: { penalty_credit_loss: true } });
  const person = w.people.a, ref = await accountRef(w.ctx, w.company, person), real = w.ctx.provider(w.company);
  const bal = async () => (await w.db.first('SELECT balance FROM stub_account WHERE ref = ?', ref)).balance;
  await entitle(w, 1000);
  const c = await proposePenalty(w.ctx, w.company, w.people.mgr, { person_id: person.id, effect: 'credits', amount: 100, reason: 'test' });
  await approvePenalty(w.ctx, w.company, w.people.hr, c.id);
  await real.debit({ accountRef: ref, amount: 100, reasonCode: 'penalty', ref: c.id, idem: 'pen:' + c.id });
  const before = await bal();
  await w.db.run("UPDATE penalty_case SET state='reversed', applied_credits=0 WHERE id=?", c.id);
  const orig = w.db.batch.bind(w.db); let broke = true;
  w.db.batch = async (stmts) => { if (broke && stmts.some(([, ...p]) => p.includes('penalty.restore'))) throw new Error('audit chain is busy'); return orig(stmts); };
  await assert.rejects(restoreDebit(w.ctx, w.company, c.id, 100, 0), /busy/);
  assert.equal(await bal(), before + 100, 'the credit reached the provider');
  assert.equal(await auditCount(w, 'penalty.restore_pending'), 1, 'marker exists although the receipt failed');
  broke = false;
  await tickPenalties(w.ctx, w.company); await tickPenalties(w.ctx, w.company);
  assert.equal(await bal(), before + 100, 'same key: not credited twice');
  assert.equal(await auditCount(w, 'penalty.restore'), 1);
  assert.equal(await auditCount(w, 'penalty.restore_pending'), 1);
});

test('P4: a restore that fails for good is tried at most 5 times, then shows as open_restores_failed', async () => {
  const w = await world({ settings: { penalty_credit_loss: true } });
  const person = w.people.a, ref = await accountRef(w.ctx, w.company, person), real = w.ctx.provider(w.company);
  await entitle(w, 1000);
  const c = await proposePenalty(w.ctx, w.company, w.people.mgr, { person_id: person.id, effect: 'credits', amount: 100, reason: 'test' });
  await approvePenalty(w.ctx, w.company, w.people.hr, c.id);
  await real.debit({ accountRef: ref, amount: 100, reasonCode: 'penalty', ref: c.id, idem: 'pen:' + c.id });
  await w.db.run("UPDATE penalty_case SET state='reversed', applied_credits=0 WHERE id=?", c.id);
  let calls = 0;
  w.ctx.provider = () => wrap(real, { credit: async () => { calls++; throw new ProviderError('account_closed'); } });
  await restoreDebit(w.ctx, w.company, c.id, 100, 0);
  for (let i = 0; i < 10; i++) await tickPenalties(w.ctx, w.company);
  assert.equal(calls, 5, 'five tries, then it stops');
  assert.equal(await openRestoresFailed(w.ctx, w.company.id), 1);
  const lines = await auditCount(w, 'penalty.restore_failed');
  await tickPenalties(w.ctx, w.company);
  assert.equal(await auditCount(w, 'penalty.restore_failed'), lines, 'no growth');
});

test('P5: a non-provider error on one entry is logged as internal and the close goes on', async () => {
  const w = await paidTier();
  const first = w.db.first.bind(w.db); let on = true;
  w.db.first = (sql, ...p) => (on && /FROM season WHERE company_id = \? AND status = 'published'/.test(sql) ? Promise.reject(new TypeError('boom')) : first(sql, ...p));
  const rep = await settle(w);
  assert.ok(rep.errors >= 1);
  assert.ok((await w.db.first("SELECT COUNT(*) n FROM audit WHERE action='period.settle_error' AND data LIKE '%internal%'")).n >= 1);
  on = false;
  assert.equal((await settle(w)).paid, 100, 'the next close pays');
});

test('Q1: raising the budget while rewards are queued does not draw their hold twice: both are sent', async () => {
  const w = await world({ budget: 100 });
  const real = w.ctx.provider(w.company); let down = true;
  w.ctx.provider = () => wrap(real, { credit: async (x) => { if (down) throw new ProviderError('provider_down'); return real.credit(x); } });
  await entitle(w, 40, 'tier:t1:W1', 'a'); await entitle(w, 40, 'tier:t1:W1', 'b');
  await setup.raiseBudget(w.ctx, w.company, w.admin, w.season, 120);
  down = false;
  for (let i = 0; i < 3; i++) { w.clock.t += DAY; await tick(w.ctx, w.company); }
  assert.deepEqual((await w.db.all('SELECT state FROM reward ORDER BY rowid')).map((r) => r.state), ['sent', 'sent']);
  assert.equal(await provBal(w, 'a') + await provBal(w, 'b'), 80);
});

test('Q2a: a reverse that was applied and then timed out is not charged twice (no correction)', async () => {
  const w = await world(); const real = w.ctx.provider(w.company);
  await entitle(w, 40);
  let flaky = true;
  w.ctx.provider = () => wrap(real, { reverse: async (x) => { const r = await real.reverse(x); if (flaky) throw new ProviderError('timeout'); return r; } });
  await entitle(w, 0).catch(() => {}); flaky = false;
  for (let i = 0; i < 3; i++) { await tick(w.ctx, w.company); await entitle(w, 0).catch(() => {}); }
  assert.equal(await provBal(w), 0);
  assert.equal((await w.db.first('SELECT COALESCE(SUM(amount),0) s FROM correction')).s, 0);
});

test('Q2b: a debit that was applied and then timed out is recorded on the retry, so an appeal win hands it back', async () => {
  const w = await world({ settings: { penalty_credit_loss: true } }); const real = w.ctx.provider(w.company);
  await entitle(w, 100);
  let flaky = true;
  w.ctx.provider = () => wrap(real, { debit: async (x) => { const r = await real.debit(x); if (flaky) throw new ProviderError('timeout'); return r; } });
  const pc = await proposePenalty(w.ctx, w.company, w.admin, { person_id: w.people.a.id, effect: 'credits', amount: 30, reason: 'r' });
  await approvePenalty(w.ctx, w.company, w.people.hr, pc.id);
  w.clock.t += 4 * DAY; await tickPenalties(w.ctx, w.company); flaky = false; await tickPenalties(w.ctx, w.company); await tickPenalties(w.ctx, w.company);
  assert.equal((await w.db.first('SELECT applied_credits a FROM penalty_case WHERE id=?', pc.id)).a, 20);
  await appealPenalty(w.ctx, w.company, w.people.a, pc.id);
  await decideAppeal(w.ctx, w.company, w.people.hr, pc.id, true, 'ok');
  for (let i = 0; i < 3; i++) await tickPenalties(w.ctx, w.company);
  assert.equal(await provBal(w), 100);
});

test('Q3: a credit row that failed after more than one try is not revived by itself after the block time (an admin does it)', async () => {
  const w = await world(); const real = w.ctx.provider(w.company); let n = 0;
  w.ctx.provider = () => wrap(real, { credit: async (x) => { n++; if (n === 1) { await real.credit(x); throw new ProviderError('provider_down'); } throw new ProviderError('account_closed'); } });
  await entitle(w, 40); await tick(w.ctx, w.company);
  assert.equal((await w.db.first("SELECT state FROM reward WHERE group_key='tier:t1:W1'")).state, 'queued', 'a definitive no after a lost reply is not believed at once');
  for (let i = 0; i < 6; i++) await tick(w.ctx, w.company);
  assert.equal((await w.db.first("SELECT state FROM reward WHERE group_key='tier:t1:W1'")).state, 'failed', 'after the limit it fails, visibly');
  w.ctx.provider = () => real; w.clock.t += 25 * 3600_000;
  await entitle(w, 40); await tick(w.ctx, w.company);
  assert.equal(await provBal(w), 40, 'not credited a second time');
  assert.equal(await openFailedRewards(w.ctx, w.company.id), 1, 'visible for the admin');
});

test('Q4: the hand-back credit that waited out an outage is sent by tickPenalties alone', async () => {
  const w = await world({ settings: { penalty_credit_loss: true } }); const real = w.ctx.provider(w.company);
  await entitle(w, 100); let down = false;
  w.ctx.provider = () => wrap(real, { credit: async (x) => { if (down) throw new ProviderError('provider_down'); return real.credit(x); } });
  const pc = await proposePenalty(w.ctx, w.company, w.admin, { person_id: w.people.a.id, effect: 'credits', amount: 30, reason: 'r' });
  await approvePenalty(w.ctx, w.company, w.people.hr, pc.id);
  w.clock.t += 4 * DAY; await tickPenalties(w.ctx, w.company);
  await appealPenalty(w.ctx, w.company, w.people.a, pc.id);
  down = true; await decideAppeal(w.ctx, w.company, w.people.hr, pc.id, true, 'ok');
  assert.equal(await provBal(w), 80);
  down = false;
  await tickPenalties(w.ctx, w.company);
  assert.equal(await provBal(w), 100);
});
