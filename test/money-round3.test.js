// Round-3 money findings: each test pins one failure that the round-3 audit found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, exampleCard, SYSTEM, T0 } from './helpers.js';
import { submitEvent, requestReversal, processReversals } from '../src/events.js';
import { settleCompany, settleEntitlement } from '../src/periods.js';
import { grant, releaseWaiting, reverseReward, retryQueued, sendReward } from '../src/rewards.js';
import { verifyChain } from '../src/audit.js';
import { ProviderError } from '../src/provider/errors.js';
import { StubProvider } from '../src/provider/stub.js';
import { proposePenalty, approvePenalty, tickPenalties } from '../src/penalty.js';
import * as setup from '../src/setup.js';

const DAY = 86400_000;
const auditCount = (w, action) => w.db.first('SELECT COUNT(*) n FROM audit WHERE company_id=? AND action=?', w.company.id, action).then((r) => r.n);
const wrap = (real, over) => new Proxy(real, { get: (t, k) => (k in over ? over[k] : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
const balance = async (w, person) => (await new StubProvider(w.db, w.company.id).getBalance({ accountRef: 'acct_' + person.id })).balance;
/** Run `fn` once, right before the first batch whose SQL matches `re` (a competing writer wins the race). */
function beforeBatch(w, re, fn) {
  const orig = w.db.batch.bind(w.db);
  let done = false;
  w.db.batch = async (stmts) => { if (!done && stmts.some(([sql]) => re.test(sql))) { done = true; await fn(); } return orig(stmts); };
  return () => { w.db.batch = orig; };
}

test('F1: a reversal does not finish while a credit may still go out; the late credit is then reversed', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  await exampleCard(w);
  const real = new StubProvider(w.db, w.company.id);
  const state = { down: true };
  w.ctx.provider = () => wrap(real, { credit: async (x) => { if (state.down) throw new ProviderError('provider_down', 'down'); return real.credit(x); } });
  const r = await submitEvent(w.ctx, w.company, SYSTEM, { person_id: w.people.a.id, event_type: 'game', stage: 'completed', ext_id: 'f1', source: 'api', occurred_at: T0 });
  assert.equal(r.ok, true);
  const rw = await w.db.first("SELECT * FROM reward WHERE event_id=? AND kind='event'", r.id);
  assert.equal(rw.state, 'queued'); assert.ok(rw.attempts > 0);
  await requestReversal(w.ctx, w.company, SYSTEM, r.id, { reason: 'refund', kind: 'refund' });
  w.clock.t += 4 * DAY;
  assert.equal(await processReversals(w.ctx, w.company), 0, 'not finished');
  assert.equal((await w.db.first('SELECT status FROM event WHERE id=?', r.id)).status, 'reversal_pending');
  state.down = false; // provider is back: the queued credit goes out ...
  await retryQueued(w.ctx, w.company);
  assert.equal(await balance(w, w.people.a), 40);
  assert.equal(await processReversals(w.ctx, w.company), 1); // ... and the next tick takes it back
  assert.equal((await w.db.first('SELECT status FROM event WHERE id=?', r.id)).status, 'reversed');
  assert.equal(await balance(w, w.people.a), 0, 'nothing is paid for a reversed event');
  await retryQueued(w.ctx, w.company);
  assert.equal(await balance(w, w.people.a), 0);
});

test('F2: a queued row voided between the read and the attempt mark is never sent', async () => {
  const w = await world({ budget: 10 });
  const a = w.people.a;
  const g = await grant(w.ctx, w.company, { person: a, kind: 'event', amount: 100, idem: 'f2:1', groupKey: 'g', at: w.clock.t, actor: 'system' });
  assert.ok(g.waiting);
  await w.db.run("UPDATE reward SET state='queued' WHERE idem_key='f2:1'"); // a queued row nobody has offered yet (attempts = 0)
  const stale = await w.db.first("SELECT * FROM reward WHERE idem_key='f2:1'");
  assert.equal(stale.attempts, 0);
  let credits = 0;
  const real = new StubProvider(w.db, w.company.id);
  w.ctx.provider = () => wrap(real, { credit: async (x) => { credits++; return real.credit(x); } });
  // the void lands exactly between sendReward's read and its attempt mark
  const orig = w.db.run.bind(w.db);
  let fired = false;
  w.db.run = async (sql, ...p) => {
    if (!fired && /attempts = attempts \+ 1/.test(sql)) { fired = true; const fresh = await w.db.first("SELECT * FROM reward WHERE idem_key='f2:1'"); const o = await reverseReward(w.ctx, w.company, fresh, { reason: 'x' }); assert.equal(o.voided, true); }
    return orig(sql, ...p);
  };
  const out = await sendReward(w.ctx, w.company, stale);
  w.db.run = orig;
  assert.equal(out.state, 'void');
  assert.equal(credits, 0, 'the provider is never called for a void row');
  assert.equal((await w.db.first("SELECT attempts a FROM reward WHERE idem_key='f2:1'")).a, 0);
});

test('F3: a tier bonus that waited, was voided, lost and regained at the same amount is paid once', async () => {
  const w = await world({ budget: 50 });
  const a = w.people.a;
  const args = { person: a, kind: 'tier', groupKey: 'tier:t1:P1', periodKey: 'P1', at: T0, label: 't' };
  await settleEntitlement(w.ctx, w.company, { ...args, entitled: 100 });
  assert.equal((await w.db.first("SELECT state FROM reward WHERE group_key='tier:t1:P1'")).state, 'waiting');
  await settleEntitlement(w.ctx, w.company, { ...args, entitled: 0 }); // tier lost: the waiting row is voided, no reversal row
  assert.equal((await w.db.first("SELECT state FROM reward WHERE group_key='tier:t1:P1' AND amount>0")).state, 'void');
  await setup.raiseBudget(w.ctx, w.company, w.admin, w.season, 1000);
  await w.reload();
  const out = await settleEntitlement(w.ctx, w.company, { ...args, entitled: 100 }); // tier regained
  assert.equal(out.paid, 100, 'the bonus is paid, not replayed as void_before');
  const live = await w.db.all("SELECT state, amount FROM reward WHERE group_key='tier:t1:P1' AND state IN ('queued','sent','waiting')");
  assert.deepEqual(live.map((r) => [r.state, r.amount]), [['sent', 100]]);
  await settleEntitlement(w.ctx, w.company, { ...args, entitled: 100 });
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM reward WHERE group_key='tier:t1:P1' AND state IN ('queued','sent','waiting')")).n, 1, 'and only once');
});

test('F4: a reward sent back to waiting gives its corrections back; the release takes them once', async () => {
  const w = await world();
  const a = w.people.a;
  await w.db.run("INSERT INTO correction (id, company_id, person_id, amount, recovered, state, reason, created_at) VALUES ('cr1',?,?,30,0,'open','t',?)", w.company.id, a.id, w.clock.t);
  const real = new StubProvider(w.db, w.company.id);
  let first = true;
  w.ctx.provider = () => wrap(real, { credit: async (x) => { if (first) { first = false; throw new ProviderError('insufficient_budget', 'no'); } return real.credit(x); } });
  const g = await grant(w.ctx, w.company, { person: a, kind: 'event', amount: 100, idem: 'f4:1', groupKey: 'g', at: w.clock.t, actor: 'system' });
  assert.equal(g.reward.state, 'waiting');
  const mid = await w.db.first("SELECT id, amount, recovered, state FROM correction WHERE id='cr1'");
  assert.deepEqual({ ...mid }, { id: 'cr1', amount: 30, recovered: 0, state: 'open' }, 'the take went back with the row');
  const r = await releaseWaiting(w.ctx, w.company);
  assert.equal(r.moved, 1);
  const rw = await w.db.first("SELECT state, sent_amount FROM reward WHERE idem_key='f4:1'");
  assert.deepEqual({ ...rw }, { state: 'sent', sent_amount: 70 });
  const c = await w.db.first("SELECT recovered, state FROM correction WHERE id='cr1'");
  assert.deepEqual({ ...c }, { recovered: 30, state: 'cleared' });
  assert.equal((await verifyChain(w.db, w.company.id)).ok, true);
});

test('F5: streak rewards older than the 400-period window are kept, not settled to zero', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  await exampleCard(w);
  const { ctx, company, admin } = w, a = w.people.a;
  await setup.addTarget(ctx, company, admin, { name: 'Weekly', scope: 'person', period: 'week', event_type: 'game', stage: 'completed', tiers: [{ count: 1, bonus: 100 }], streak: { length: 2, bonus: 50 }, active_from: T0 - 40 * DAY });
  const ev = (ext, at) => submitEvent(ctx, company, SYSTEM, { person_id: a.id, event_type: 'game', stage: 'completed', ext_id: ext, source: 'api', occurred_at: at });
  w.clock.t = T0 + 9 * DAY;
  await w.db.run('UPDATE season SET ends_at = ?', T0 + 9000 * DAY);
  assert.equal((await ev('s1', T0)).ok, true);
  assert.equal((await ev('s2', T0 + 7 * DAY)).ok, true);
  await settleCompany(ctx, company, w.clock.t + 30 * DAY, { force: true });
  const streak = () => w.db.first("SELECT COUNT(*) n, COALESCE(SUM(reversed),0) r FROM reward WHERE kind='streak' AND person_id=?", a.id);
  assert.equal((await streak()).n, 1, 'the old streak was paid');
  w.clock.t = T0 + 450 * 7 * DAY; // far later, with a fast synthetic clock
  assert.equal((await ev('s3', w.clock.t - 3 * DAY)).ok, true);
  await settleCompany(ctx, company, w.clock.t);
  const st = await streak();
  assert.equal(st.r, 0, 'not reversed');
  assert.equal(await w.db.first("SELECT COUNT(*) n FROM reward WHERE kind='reversal' AND person_id=?", a.id).then((r) => r.n), 0);
});

test('F6: penalty.apply that lost the race writes no audit line', async () => {
  const w = await world();
  const c = await proposePenalty(w.ctx, w.company, w.people.mgr, { person_id: w.people.a.id, effect: 'steps_back', amount: 2, reason: 'test' });
  await approvePenalty(w.ctx, w.company, w.people.hr, c.id);
  w.clock.t += 4 * DAY;
  const undo = beforeBatch(w, /penalty_case SET state='applied'/, () => w.db.run("UPDATE penalty_case SET state='reversed'"));
  const out = await tickPenalties(w.ctx, w.company);
  undo();
  assert.equal(out.applied, 0);
  assert.equal(await auditCount(w, 'penalty.apply'), 0);
  assert.equal((await verifyChain(w.db, w.company.id)).ok, true);
});

test('F6: requestReversal that lost the race writes no audit line', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  await exampleCard(w);
  const r = await submitEvent(w.ctx, w.company, SYSTEM, { person_id: w.people.a.id, event_type: 'game', stage: 'completed', ext_id: 'f6', source: 'api', occurred_at: T0 });
  assert.equal(r.status, 'applied');
  const undo = beforeBatch(w, /status='reversal_pending'/, () => w.db.run("UPDATE event SET status='reversed' WHERE id=?", r.id));
  await requestReversal(w.ctx, w.company, SYSTEM, r.id, { reason: 'refund', kind: 'refund' });
  undo();
  assert.equal(await auditCount(w, 'event.reversal_request'), 0);
  assert.equal((await verifyChain(w.db, w.company.id)).ok, true);
});
