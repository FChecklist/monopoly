// Round-7 money findings: each test pins one failure that the round-7 audit found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, exampleCard, SYSTEM, T0 } from './helpers.js';
import { submitEvent } from '../src/events.js';
import { settleCompany, clearBlocked } from '../src/periods.js';
import { grant, reverseReward, accountRef } from '../src/rewards.js';
import { ProviderError } from '../src/provider/errors.js';
import { StubProvider } from '../src/provider/stub.js';
import { proposePenalty, approvePenalty, appealPenalty, decideAppeal, tickPenalties } from '../src/penalty.js';
import * as setup from '../src/setup.js';

const DAY = 86400_000;
const wrap = (real, over) => new Proxy(real, { get: (t, k) => (k in over ? over[k] : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
const count = (w, where) => w.db.first(`SELECT COUNT(*) n FROM reward WHERE ${where}`).then((r) => r.n);
const auditCount = (w, action) => w.db.first('SELECT COUNT(*) n FROM audit WHERE company_id=? AND action=?', w.company.id, action).then((r) => r.n);
function beforeBatch(w, re, fn) {
  const orig = w.db.batch.bind(w.db);
  let done = false;
  w.db.batch = async (stmts) => { if (!done && stmts.some(([sql]) => re.test(sql))) { done = true; await fn(); } return orig(stmts); };
  return () => { w.db.batch = orig; };
}

/** One person with a paid tier bonus of 100 for a closed week. */
async function paidTier() {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  await exampleCard(w);
  const { ctx, company, admin } = w;
  await setup.addTarget(ctx, company, admin, { name: 'Weekly', scope: 'person', period: 'week', event_type: 'game', stage: 'completed', tiers: [{ count: 1, bonus: 100 }], active_from: T0 - 40 * DAY });
  await submitEvent(ctx, company, SYSTEM, { person_id: w.people.a.id, event_type: 'game', stage: 'completed', ext_id: 'r7', source: 'api', occurred_at: T0 });
  w.clock.t = T0 + 20 * DAY;
  return w;
}
const settle = (w) => settleCompany(w.ctx, w.company, w.clock.t, { force: true });
/** Make the season lookup inside grant() raise while st.on is true (a pay entry failing). */
function failPay(w, st, mk) {
  const first = w.db.first.bind(w.db);
  w.db.first = (sql, ...p) => (st.on && /FROM season WHERE company_id = \? AND status = 'published'/.test(sql) ? Promise.reject(mk()) : first(sql, ...p));
}

test('L1a: a due reversal is never blocked by a config error: it runs once the config is fixed', async () => {
  const w = await paidTier();
  const real = new StubProvider(w.db, w.company.id);
  const st = { broken: false };
  w.ctx.provider = () => wrap(real, { capabilities: async () => { if (st.broken) throw new ProviderError('unsupported', 'misconfigured'); return real.capabilities(); } });
  await settle(w);
  assert.equal(await count(w, "kind='tier' AND state='sent'"), 1);
  await w.db.run("UPDATE event SET status='reversed' WHERE ext_id='r7'");
  st.broken = true;
  for (let i = 0; i < 3; i++) { const rep = await settle(w); assert.equal(rep.errors ?? 0, 0, 'surfaces as pending, not an error'); }
  assert.equal(await auditCount(w, 'period.settle_blocked'), 0, 'no marker for a reversal');
  assert.equal(await count(w, "kind='tier' AND reversed=1"), 0, 'still pending');
  st.broken = false;
  const rep = await settle(w);
  assert.equal(rep.reversed, 100);
  assert.equal(await count(w, "kind='tier' AND reversed=1"), 1);
});

test('L1a2: a non-config permanent error on a reversal entry is also never blocked, and does not stop others', async () => {
  const w = await paidTier();
  await settle(w);
  await w.db.run("UPDATE event SET status='reversed' WHERE ext_id='r7'");
  const real = new StubProvider(w.db, w.company.id);
  const st = { on: true };
  w.ctx.provider = () => wrap(real, { reverse: async (x) => { if (st.on) throw new ProviderError('rate_limited', 'slow'); return real.reverse(x); } });
  for (let i = 0; i < 3; i++) assert.equal((await settle(w)).errors, 1);
  assert.equal(await auditCount(w, 'period.settle_blocked'), 0);
  st.on = false;
  assert.equal((await settle(w)).reversed, 100);
});

test('L1d: reverseReward turns a provider()/capabilities() error into a pending result, not a throw', async () => {
  const w = await world();
  const g = await grant(w.ctx, w.company, { person: w.people.a, kind: 'tier', amount: 50, idem: 'l1d', groupKey: 'tier:t:p', periodKey: 'p', at: w.clock.t, periodBonus: true });
  assert.equal(g.reward.state, 'sent');
  const real = new StubProvider(w.db, w.company.id);
  w.ctx.provider = () => wrap(real, { capabilities: async () => { throw new ProviderError('unsupported', 'x'); } });
  const o = await reverseReward(w.ctx, w.company, g.reward, { reason: 'tier_lost' });
  assert.equal(o.pending, true); assert.equal(o.skipped, true);
  assert.equal((await w.db.first('SELECT reversed FROM reward WHERE id=?', g.reward.id)).reversed, 0);
  w.ctx.provider = () => { throw new ProviderError('unsupported', 'no provider'); };
  assert.equal((await reverseReward(w.ctx, w.company, g.reward, { reason: 'tier_lost' })).pending, true);
});

test('L1b/L2: a permanent account error blocks a pay entry once, a standing block writes no settle line, and it expires after 24h', async () => {
  const w = await paidTier();
  const st = { on: true };
  failPay(w, st, () => new ProviderError('account_closed', 'closed'));
  const r1 = await settle(w);
  assert.equal(r1.errors, 1); assert.equal(r1.blocked, 1); assert.equal(r1.newly_blocked, 1);
  assert.equal(await auditCount(w, 'period.settle_blocked'), 1);
  assert.equal(await auditCount(w, 'settle'), 1, 'the tick that blocked it is a change');
  const r2 = await settle(w); await settle(w);
  assert.equal(r2.blocked, 1, 'the admin-visible count');
  assert.equal(await auditCount(w, 'period.settle_blocked'), 1);
  assert.equal(await auditCount(w, 'settle'), 1, 'an unchanged standing block writes no line');
  st.on = false;
  w.clock.t += 23 * 3600_000;
  assert.equal((await settle(w)).paid, 0, 'still blocked inside 24h');
  w.clock.t += 2 * 3600_000;
  const r3 = await settle(w);
  assert.equal(r3.paid, 100); assert.equal(r3.unblocked, 1);
  assert.equal(await auditCount(w, 'period.settle_unblocked'), 1);
  assert.equal(await auditCount(w, 'settle'), 2, 'unblocking is a change');
  const r4 = await settle(w);
  assert.equal(r4.blocked ?? 0, 0); assert.equal(await count(w, "kind='tier' AND state='sent'"), 1);
});

test('L1e: clearBlocked lifts every block at once and is idempotent', async () => {
  const w = await paidTier();
  const st = { on: true };
  failPay(w, st, () => new ProviderError('bad_request', 'bad'));
  await settle(w);
  assert.equal((await settle(w)).blocked, 1);
  st.on = false;
  assert.equal((await settle(w)).paid, 0);
  assert.deepEqual(await clearBlocked(w.ctx, w.company), { cleared: 1 });
  assert.deepEqual(await clearBlocked(w.ctx, w.company), { cleared: 0 });
  assert.equal((await settle(w)).paid, 100, 'paid at the next close without waiting a day');
});

test('L1c: a configuration or provider-state error on a pay entry is retried and never writes a block', async () => {
  const w = await paidTier();
  const st = { on: true };
  for (const code of ['unsupported', 'bad_config', 'unauthorized', 'rate_limited']) {
    failPay(w, st, () => new ProviderError(code, code));
    assert.equal((await settle(w)).errors, 1);
  }
  assert.equal(await auditCount(w, 'period.settle_blocked'), 0);
  st.on = false;
  assert.equal((await settle(w)).paid, 100);
});

/** A reversed case with 40 credits that must be handed back. */
async function reversedCase(w) {
  const c = await proposePenalty(w.ctx, w.company, w.people.mgr, { person_id: w.people.a.id, effect: 'steps_back', amount: 2, reason: 'test' });
  await approvePenalty(w.ctx, w.company, w.people.hr, c.id);
  await w.db.run("UPDATE penalty_case SET state='reversed', applied_at=?, applied_credits=40 WHERE id=?", w.clock.t, c.id);
  return c;
}

test('L3: grant reports paid 0 when the row ends failed, and a failed hand-back is retried under a new key until sent', async () => {
  const w = await world();
  const real = new StubProvider(w.db, w.company.id);
  const st = { bad: true };
  w.ctx.provider = () => wrap(real, { credit: async (x) => { if (st.bad) throw new ProviderError('account_closed', 'closed'); return real.credit(x); } });
  const g = await grant(w.ctx, w.company, { person: w.people.b, kind: 'penalty_return', amount: 7, idem: 'l3g', groupKey: 'penrev', at: w.clock.t, bypassCaps: true });
  assert.equal(g.paid, 0); assert.equal(g.reason, 'account_closed'); assert.equal(g.reward.state, 'failed');
  const c = await reversedCase(w);
  const out = await tickPenalties(w.ctx, w.company);
  assert.equal(out.repaired, 0, 'not handed back');
  assert.equal(await count(w, `idem_key='penrev:${c.id}' AND state='failed'`), 1);
  assert.ok((await auditCount(w, 'penalty.handback_failed')) >= 1);
  await tickPenalties(w.ctx, w.company);
  assert.equal(await count(w, `idem_key LIKE 'penrev:${c.id}%' AND state='failed'`), 2, 'a new try each tick');
  st.bad = false;
  assert.equal((await tickPenalties(w.ctx, w.company)).repaired, 1);
  assert.equal(await count(w, `idem_key LIKE 'penrev:${c.id}%' AND state='sent' AND amount=40`), 1);
  assert.equal((await tickPenalties(w.ctx, w.company)).repaired, 0, 'done: no more tries');
  assert.equal(await count(w, `idem_key LIKE 'penrev:${c.id}%' AND state='sent'`), 1);
});

test('L3: a hand-back that keeps failing stops after the retry bound', async () => {
  const w = await world();
  const real = new StubProvider(w.db, w.company.id);
  w.ctx.provider = () => wrap(real, { credit: async () => { throw new ProviderError('account_closed', 'closed'); } });
  const c = await reversedCase(w);
  for (let i = 0; i < 9; i++) await tickPenalties(w.ctx, w.company);
  assert.equal(await count(w, `idem_key LIKE 'penrev:${c.id}%'`), 5);
});

test('L4: debit -> appeal -> restore -> upheld -> debit is a real second debit with its own key', async () => {
  const w = await world({ settings: { penalty_credit_loss: true } });
  const person = w.people.a;
  await grant(w.ctx, w.company, { person, kind: 'event', amount: 1000, idem: 'l4earn', at: w.clock.t, bypassCaps: true });
  const ref = await accountRef(w.ctx, w.company, person);
  const bal = async () => (await w.db.first('SELECT balance FROM stub_account WHERE ref = ?', ref)).balance;
  assert.equal(await bal(), 1000);
  const c = await proposePenalty(w.ctx, w.company, w.people.mgr, { person_id: person.id, effect: 'credits', amount: 100, reason: 'test' });
  await approvePenalty(w.ctx, w.company, w.people.hr, c.id);
  w.clock.t += 4 * DAY;
  const undo = beforeBatch(w, /penalty_case SET state='applied'/, () => appealPenalty(w.ctx, w.company, person, c.id));
  await tickPenalties(w.ctx, w.company);
  undo();
  let row = await w.db.first('SELECT state, applied_credits FROM penalty_case WHERE id=?', c.id);
  assert.equal(row.state, 'appealed'); assert.equal(row.applied_credits, 0);
  assert.equal(await bal(), 1000, 'the first debit was handed back');
  assert.equal(await auditCount(w, 'penalty.restore'), 1);
  await decideAppeal(w.ctx, w.company, w.people.hr, c.id, false, 'stays');
  row = await w.db.first('SELECT state, applied_credits FROM penalty_case WHERE id=?', c.id);
  assert.equal(row.state, 'upheld'); assert.equal(row.applied_credits, 100);
  assert.equal(await bal(), 900, 'credits really taken the second time');
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM stub_entry WHERE kind LIKE 'debit:penalty%'")).n, 2);
});
