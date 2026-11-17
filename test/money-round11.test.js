// Round-11 money findings (audit 10A/10B). Each test pins one failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, exampleCard, SYSTEM, T0 } from './helpers.js';
import { submitEvent, requestReversal, processReversals } from '../src/events.js';
import { settleEntitlement } from '../src/periods.js';
import { accountRef, retryQueued, reviveFailedRewards, openFailedRewards, releaseWaiting } from '../src/rewards.js';
import { ProviderError } from '../src/provider/errors.js';
import { MoneypennyProvider } from '../src/provider/moneypenny.js';
import { proposePenalty, approvePenalty, appealPenalty, decideAppeal, tickPenalties } from '../src/penalty.js';
import * as setup from '../src/setup.js';

const DAY = 86400_000;
const wrap = (real, over) => new Proxy(real, { get: (t, k) => (k in over ? over[k] : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
const entitle = (w, e, gk = 'tier:t1:W1', person = 'a') => settleEntitlement(w.ctx, w.company, { person: w.people[person], kind: 'tier', groupKey: gk, periodKey: 'W1', entitled: e, at: w.clock.t, label: 'x' });
const provBal = async (w, person = 'a') => (await w.db.first('SELECT balance FROM stub_account WHERE ref=?', await accountRef(w.ctx, w.company, w.people[person]))).balance;
const ev = (w, id) => submitEvent(w.ctx, w.company, SYSTEM, { person_id: w.people.a.id, event_type: 'game', stage: 'completed', ext_id: id, source: 'api', occurred_at: w.clock.t });

test('R1: a broken provider setup (constructor or ctx.provider) keeps rewards queued, never fails them', async () => {
  assert.throws(() => new MoneypennyProvider({ baseUrl: 'https://x.test' }), (e) => e.code === 'misconfigured' && e.retriable);
  assert.throws(() => new MoneypennyProvider({ baseUrl: 'http://evil.example', keyId: 'k', secret: 's' }), (e) => e.code === 'misconfigured');
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  const real = w.ctx.provider(w.company); let broken = true;
  w.ctx.provider = () => { if (broken) throw new ProviderError('bad_request', 'Moneypenny settings are incomplete.'); return real; };
  await ev(w, 'r1');
  const row = await w.db.first('SELECT state, last_error FROM reward WHERE person_id=?', w.people.a.id);
  assert.equal(row.state, 'queued'); assert.equal(row.last_error, 'misconfigured');
  broken = false;
  assert.equal((await retryQueued(w.ctx, w.company)).sent, 1);
});

test('R2: a failed event reward is voided when its event is reversed; an admin revive can never pay a reversed event', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  const real = w.ctx.provider(w.company); let bad = true;
  w.ctx.provider = () => wrap(real, { credit: async (x) => { if (bad) throw new ProviderError('account_closed'); return real.credit(x); } });
  const r = await ev(w, 'r2');
  assert.equal((await w.db.first("SELECT state FROM reward WHERE kind='event' AND person_id=?", w.people.a.id)).state, 'failed');
  await requestReversal(w.ctx, w.company, SYSTEM, r.id, { reason: 'refund', kind: 'refund' });
  w.clock.t += 4 * DAY; await processReversals(w.ctx, w.company);
  assert.equal((await w.db.first('SELECT status FROM event WHERE id=?', r.id)).status, 'reversed');
  assert.equal((await w.db.first("SELECT state FROM reward WHERE kind='event' AND person_id=?", w.people.a.id)).state, 'void');
  bad = false;
  assert.equal((await reviveFailedRewards(w.ctx, w.company)).revived, 0);
  assert.equal(await provBal(w), 0);
});

test('R2b: a failed row whose event is no longer applied is not revivable even if it was not voided', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  const real = w.ctx.provider(w.company);
  w.ctx.provider = () => wrap(real, { credit: async () => { throw new ProviderError('account_closed'); } });
  const r = await ev(w, 'r2b');
  await w.db.run("UPDATE event SET status='reversed' WHERE id=?", r.id);
  assert.equal(await openFailedRewards(w.ctx, w.company.id), 0);
  assert.equal((await reviveFailedRewards(w.ctx, w.company)).revived, 0);
});

const lostAnswer = (real, method, st) => ({ [method]: async (x) => { const o = await real[method](x); if (st.lose) { st.lose = false; throw new ProviderError('timeout'); } return o; } });

test('R3a: a debit whose answer was lost and an appeal won before the retry is handed back', async () => {
  const w = await world({ settings: { penalty_credit_loss: true } }); const real = w.ctx.provider(w.company);
  await entitle(w, 100);
  const st = { lose: true };
  w.ctx.provider = () => wrap(real, lostAnswer(real, 'debit', st));
  const c = await proposePenalty(w.ctx, w.company, w.admin, { person_id: w.people.a.id, effect: 'credits', amount: 20, reason: 'r' });
  await approvePenalty(w.ctx, w.company, w.people.hr, c.id);
  w.clock.t += 4 * DAY; await tickPenalties(w.ctx, w.company);
  assert.equal(await provBal(w), 80, 'the debit landed');
  await appealPenalty(w.ctx, w.company, w.people.a, c.id);
  await decideAppeal(w.ctx, w.company, w.people.hr, c.id, true, 'ok');
  for (let i = 0; i < 3; i++) await tickPenalties(w.ctx, w.company);
  assert.equal(await provBal(w), 100);
});

test('R3b: the retry of a lost-answer debit replays the same amount even when the cap room has changed', async () => {
  const w = await world({ settings: { penalty_credit_loss: true } }); const real = w.ctx.provider(w.company);
  await entitle(w, 100);
  const st = { lose: true };
  w.ctx.provider = () => wrap(real, lostAnswer(real, 'debit', st));
  const mk = async () => { const c = await proposePenalty(w.ctx, w.company, w.admin, { person_id: w.people.a.id, effect: 'credits', amount: 20, reason: 'r' }); await approvePenalty(w.ctx, w.company, w.people.hr, c.id); return c.id; };
  const c1 = await mk(), c2 = await mk();
  w.clock.t += 4 * DAY;
  await tickPenalties(w.ctx, w.company); await tickPenalties(w.ctx, w.company);
  const a1 = (await w.db.first('SELECT applied_credits a FROM penalty_case WHERE id=?', c1)).a;
  assert.equal(a1, 20, 'C1 is recorded with what the provider took');
  assert.ok((await w.db.first('SELECT applied_credits a FROM penalty_case WHERE id=?', c2)).a <= 20);
});

test('R3c: a debit the provider cannot take (insufficient_credits) applies the case without credits and says why', async () => {
  const w = await world({ settings: { penalty_credit_loss: true } }); const real = w.ctx.provider(w.company);
  await entitle(w, 100);
  w.ctx.provider = () => wrap(real, { debit: async () => { throw new ProviderError('insufficient_credits'); } });
  const c = await proposePenalty(w.ctx, w.company, w.admin, { person_id: w.people.a.id, effect: 'credits', amount: 20, reason: 'r' });
  await approvePenalty(w.ctx, w.company, w.people.hr, c.id);
  w.clock.t += 4 * DAY; await tickPenalties(w.ctx, w.company);
  assert.equal((await w.db.first('SELECT state FROM penalty_case WHERE id=?', c.id)).state, 'applied');
  const line = await w.db.first("SELECT data FROM audit WHERE action='penalty.apply'");
  assert.equal(JSON.parse(line.data).nodebit, 'insufficient_credits');
});

test('R4: a reverse whose answer was lost is finished before the row counts as paid; a regained entitlement is paid', async () => {
  const w = await world(); const real = w.ctx.provider(w.company);
  await entitle(w, 40);
  const st = { lose: true };
  w.ctx.provider = () => wrap(real, lostAnswer(real, 'reverse', st));
  await entitle(w, 0).catch(() => {});
  assert.equal(await provBal(w), 0, 'the reverse landed at the provider');
  await entitle(w, 40);
  assert.equal(await provBal(w), 40, 'paid again, not stuck underpaid');
  assert.equal((await w.db.first("SELECT COALESCE(SUM(amount),0) s FROM reward WHERE group_key='tier:t1:W1' AND reversed=0 AND state IN ('queued','sent')")).s, 40);
});

test('R6: a failed budget commit never leaves the season on a released hold', async () => {
  const w = await world({ budget: 100 }); const real = w.ctx.provider(w.company);
  let released = 0;
  w.ctx.provider = () => wrap(real, { releaseHold: async (x) => { released++; return real.releaseHold(x); } });
  const before = (await w.db.first('SELECT hold_id FROM season WHERE id=?', w.season)).hold_id;
  const orig = w.db.batch.bind(w.db);
  w.db.batch = async (stmts) => { if (stmts.some(([, ...p]) => p.includes('season.budget'))) throw new Error('audit chain is busy'); return orig(stmts); };
  await assert.rejects(setup.raiseBudget(w.ctx, w.company, w.admin, w.season, 150), /busy/);
  assert.equal(released, 0, 'the old hold is still the season hold');
  assert.equal((await w.db.first('SELECT hold_id FROM season WHERE id=?', w.season)).hold_id, before);
  w.db.batch = orig;
  await setup.raiseBudget(w.ctx, w.company, w.admin, w.season, 150);
  assert.equal(released, 1);
});

test('R6b: closeSeason records the close before the hold goes back', async () => {
  const w = await world({ budget: 100 }); const real = w.ctx.provider(w.company);
  let released = 0;
  w.ctx.provider = () => wrap(real, { releaseHold: async (x) => { released++; return real.releaseHold(x); } });
  const orig = w.db.batch.bind(w.db);
  w.db.batch = async (stmts) => { if (stmts.some(([, ...p]) => p.includes('season.close'))) throw new Error('audit chain is busy'); return orig(stmts); };
  await assert.rejects(setup.closeSeason(w.ctx, w.company, w.admin, w.season), /busy/);
  assert.equal(released, 0);
  w.db.batch = orig;
  const out = await setup.closeSeason(w.ctx, w.company, w.admin, w.season);
  assert.equal(released, 1); assert.ok(!out.hold_pending);
});

test('R7: a row that can never be sent does not starve newer queued rows', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  const real = w.ctx.provider(w.company);
  const aRef = await accountRef(w.ctx, w.company, w.people.a);
  let down = true;
  w.ctx.provider = () => wrap(real, { credit: async (x) => { if (down || x.accountRef === aRef) throw new ProviderError(down ? 'provider_down' : 'misconfigured'); return real.credit(x); } });
  await ev(w, 'r7a');
  w.clock.t += 1000;
  await submitEvent(w.ctx, w.company, SYSTEM, { person_id: w.people.b.id, event_type: 'game', stage: 'completed', ext_id: 'r7b', source: 'api', occurred_at: w.clock.t });
  down = false;
  await retryQueued(w.ctx, w.company, 1); await retryQueued(w.ctx, w.company, 1);
  assert.equal((await w.db.first('SELECT state FROM reward WHERE person_id=?', w.people.b.id)).state, 'sent');
});

test('R8: a revived reward whose season is closed (after the late window) is voided, not left waiting', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  const real = w.ctx.provider(w.company);
  w.ctx.provider = () => wrap(real, { credit: async () => { throw new ProviderError('account_closed'); } });
  await ev(w, 'r8');
  await setup.closeSeason(w.ctx, w.company, w.admin, w.season);
  w.clock.t += 200 * DAY;
  w.ctx.provider = () => real;
  await reviveFailedRewards(w.ctx, w.company); await releaseWaiting(w.ctx, w.company);
  const row = await w.db.first("SELECT state FROM reward WHERE kind='event' AND person_id=?", w.people.a.id);
  assert.equal(row.state, 'void');
  assert.equal(await provBal(w), 0);
});
