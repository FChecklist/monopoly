// Round-6 money findings: each test pins one failure that the round-6 audit found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, exampleCard, SYSTEM, T0 } from './helpers.js';
import { submitEvent, requestReversal, approveReversal, appealReversal, decideReversalAppeal } from '../src/events.js';
import { settleCompany, settleEntitlement } from '../src/periods.js';
import { ProviderError } from '../src/provider/errors.js';
import { StubProvider } from '../src/provider/stub.js';
import { proposePenalty, approvePenalty, appealPenalty, decideAppeal, tickPenalties, restoreDebit } from '../src/penalty.js';
import { ensureBoard } from '../src/board.js';
import { commit, verifyChain } from '../src/audit.js';
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
function beforeRun(w, re, fn) {
  const orig = w.db.run.bind(w.db);
  let done = false;
  w.db.run = async (sql, ...p) => { if (!done && re.test(sql)) { done = true; await fn(); } return orig(sql, ...p); };
  return () => { w.db.run = orig; };
}

/** A penalty case that is approved and sitting in `state`, with the given applied fields. */
async function penaltyCase(w, effect = 'steps_back', amount = 2) {
  const c = await proposePenalty(w.ctx, w.company, w.people.mgr, { person_id: w.people.a.id, effect, amount, reason: 'test' });
  await approvePenalty(w.ctx, w.company, w.people.hr, c.id);
  return c;
}

test('K1: a reversal whose hand-back never ran (crash after the commit) is repaired by the tick, once', async () => {
  const w = await world();
  const c = await penaltyCase(w);
  // Only the commit half of reversePenalty: state reversed, credits debited, no penrev: reward.
  await w.db.run("UPDATE penalty_case SET state='reversed', applied_at=?, applied_credits=40 WHERE id=?", w.clock.t, c.id);
  assert.equal(await count(w, `idem_key='penrev:${c.id}'`), 0);
  const out = await tickPenalties(w.ctx, w.company);
  assert.equal(out.repaired, 1);
  assert.equal(await count(w, `idem_key='penrev:${c.id}' AND kind='penalty_return' AND amount=40`), 1);
  await tickPenalties(w.ctx, w.company);
  assert.equal(await count(w, `idem_key='penrev:${c.id}'`), 1, 'idempotent: paid back once');
});

test('K1: a hand-back that comes back busy is logged by code and retried at the next tick', async () => {
  const w = await world();
  const c = await penaltyCase(w);
  await w.db.run("UPDATE penalty_case SET state='applied', applied_at=?, applied_credits=40 WHERE id=?", w.clock.t, c.id);
  await appealPenalty(w.ctx, w.company, w.people.a, c.id);
  const orig = w.db.batch.bind(w.db);
  w.db.batch = async (stmts) => { if (stmts.some(([sql]) => /INSERT INTO reward/.test(sql))) throw new Error('audit chain is busy'); return orig(stmts); };
  const res = await decideAppeal(w.ctx, w.company, w.people.hr, c.id, true, 'ok');
  assert.equal(res.state, 'reversed');
  assert.equal(await count(w, `idem_key='penrev:${c.id}'`), 0, 'nothing handed back yet');
  assert.ok((await auditCount(w, 'penalty.handback_failed')) >= 1, 'the failure is recorded by code');
  w.db.batch = orig;
  const out = await tickPenalties(w.ctx, w.company);
  assert.equal(out.repaired, 1);
  assert.equal(await count(w, `idem_key='penrev:${c.id}' AND amount=40`), 1);
});

/** A manager-recorded reversal on one applied event. */
async function pendingReversal(ext, { appeal = false } = {}) {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  await exampleCard(w);
  const r = await submitEvent(w.ctx, w.company, SYSTEM, { person_id: w.people.a.id, event_type: 'game', stage: 'completed', ext_id: ext, source: 'api', occurred_at: T0 });
  await requestReversal(w.ctx, w.company, w.people.mgr, r.id, { reason: 'fake', kind: 'fake' });
  if (appeal) await appealReversal(w.ctx, w.company, w.people.a, r.id);
  return { w, r };
}

test('K2 race A: an uphold that lost to a denial reverses nothing and leaves the event applied', async () => {
  const { w, r } = await pendingReversal('k2a', { appeal: true });
  const undo = beforeRun(w, /reversal_due=\?, reversal_appeal=0/, () => w.db.run("UPDATE event SET status='applied', reversal_kind=NULL, reversal_due=NULL, reversal_appeal=0 WHERE id=?", r.id));
  await assert.rejects(decideReversalAppeal(w.ctx, w.company, w.people.admin, r.id, true), /changed/);
  undo();
  assert.equal((await w.db.first('SELECT status FROM event WHERE id=?', r.id)).status, 'applied');
  assert.equal(await count(w, "kind='reversal'"), 0);
  assert.equal(await count(w, "event_id IS NOT NULL AND kind='event' AND reversed=1"), 0, 'rewards untouched');
});

test('K2 race B: a manager approval cannot override an appeal that landed after its check', async () => {
  const { w, r } = await pendingReversal('k2b');
  const undo = beforeRun(w, /reversal_due=\?, reversal_appeal=0/, () => w.db.run('UPDATE event SET reversal_appeal = 1 WHERE id=?', r.id));
  await assert.rejects(approveReversal(w.ctx, w.company, w.people.hr, r.id), /changed/);
  undo();
  const ev = await w.db.first('SELECT status, reversal_appeal, reversal_due FROM event WHERE id=?', r.id);
  assert.equal(ev.status, 'reversal_pending'); assert.equal(ev.reversal_appeal, 1); assert.equal(ev.reversal_due, null);
  assert.equal(await count(w, "kind='reversal'"), 0);
  // the appeal can still be upheld afterwards, and then it does go through
  const done = await decideReversalAppeal(w.ctx, w.company, w.people.admin, r.id, true);
  assert.equal(done.status, 'reversed');
});

test('K3: restoreDebit does not hand back twice when the winner is a reversed case with recorded credits', async () => {
  const w = await world();
  const c = await penaltyCase(w);
  await w.db.run("UPDATE penalty_case SET state='reversed', applied_at=?, applied_credits=30 WHERE id=?", w.clock.t, c.id);
  const real = new StubProvider(w.db, w.company.id);
  const calls = [];
  w.ctx.provider = () => wrap(real, { credit: async (x) => { calls.push(x.reasonCode); return real.credit(x); } });
  await restoreDebit(w.ctx, w.company, c.id, 30);
  assert.deepEqual(calls, [], 'the penrev: path owns this hand-back');
  await w.db.run("UPDATE penalty_case SET state='reversed', applied_credits=0 WHERE id=?", c.id);
  await restoreDebit(w.ctx, w.company, c.id, 30);
  assert.deepEqual(calls, ['penalty_restore'], 'an unrecorded debit is still restored');
});

test('K4: a tick does not apply a case that was appealed a moment earlier', async () => {
  const w = await world();
  const b = await ensureBoard(w.ctx, w.company, w.people.a.id);
  await w.db.run('UPDATE board_state SET position = 5 WHERE person_id = ?', w.people.a.id);
  const c = await penaltyCase(w, 'steps_back', 2);
  w.clock.t += 4 * DAY;
  const undo = beforeBatch(w, /penalty_case SET state='applied'/, () => appealPenalty(w.ctx, w.company, w.people.a, c.id));
  const out = await tickPenalties(w.ctx, w.company);
  undo();
  const row = await w.db.first('SELECT state, applied_at FROM penalty_case WHERE id=?', c.id);
  assert.equal(row.state, 'appealed'); assert.equal(row.applied_at, null);
  assert.equal(out.applied, 0);
  assert.equal((await w.db.first('SELECT position FROM board_state WHERE person_id=?', w.people.a.id)).position, 5);
  assert.ok(b);
});

test('K5: an appeal made in the notice window and then upheld is applied', async () => {
  const w = await world();
  await ensureBoard(w.ctx, w.company, w.people.a.id);
  await w.db.run('UPDATE board_state SET position = 5 WHERE person_id = ?', w.people.a.id);
  const c = await penaltyCase(w, 'steps_back', 2);
  await appealPenalty(w.ctx, w.company, w.people.a, c.id);
  const res = await decideAppeal(w.ctx, w.company, w.people.hr, c.id, false, 'stays');
  assert.equal(res.state, 'upheld');
  const row = await w.db.first('SELECT state, applied_at, applied_steps FROM penalty_case WHERE id=?', c.id);
  assert.equal(row.state, 'upheld'); assert.ok(row.applied_at); assert.equal(row.applied_steps, 2);
  assert.equal((await w.db.first('SELECT position FROM board_state WHERE person_id=?', w.people.a.id)).position, 3);
  await tickPenalties(w.ctx, w.company); // never twice
  assert.equal((await w.db.first('SELECT position FROM board_state WHERE person_id=?', w.people.a.id)).position, 3);
});

test('K5: an upheld case that was not applied at once is applied by the tick', async () => {
  const w = await world();
  await ensureBoard(w.ctx, w.company, w.people.a.id);
  await w.db.run('UPDATE board_state SET position = 5 WHERE person_id = ?', w.people.a.id);
  const c = await penaltyCase(w, 'steps_back', 2);
  await w.db.run("UPDATE penalty_case SET state='upheld' WHERE id=?", c.id);
  const out = await tickPenalties(w.ctx, w.company);
  assert.equal(out.applied, 1);
  assert.equal((await w.db.first('SELECT position FROM board_state WHERE person_id=?', w.people.a.id)).position, 3);
});

test('K6: paid and the reversal count come from one statement, so the settle key is one consistent snapshot', async () => {
  const w = await world();
  const seen = [];
  const first = w.db.first.bind(w.db);
  w.db.first = (sql, ...p) => { seen.push(String(sql)); return first(sql, ...p); };
  await settleEntitlement(w.ctx, w.company, { person: w.people.a, kind: 'tier', groupKey: 'tier:t1:PK6', periodKey: 'PK6', at: w.clock.t, label: 't', entitled: 50 });
  w.db.first = first;
  assert.ok(seen.some((q) => /reversed=1 AND kind != 'reversal'/.test(q) && /COALESCE\(SUM\(amount\),0\)/.test(q)), 'one query reads both');
  assert.ok(!seen.some((q) => /^\s*SELECT COUNT\(\*\) n FROM reward WHERE company_id=\? AND person_id=\? AND group_key=\? AND reversed=1/.test(q)), 'no separate gen read');
});

test('K7: a config error on a due reversal is never recorded as a block; the reversal is retried at every close (round 7 rule)', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  await exampleCard(w);
  const { ctx, company, admin } = w;
  await setup.addTarget(ctx, company, admin, { name: 'Weekly', scope: 'person', period: 'week', event_type: 'game', stage: 'completed', tiers: [{ count: 1, bonus: 100 }], active_from: T0 - 40 * DAY });
  const real = new StubProvider(w.db, w.company.id);
  const st = { broken: false, caps: 0 };
  ctx.provider = () => wrap(real, { capabilities: async () => { if (st.broken) { st.caps++; throw new ProviderError('bad_config', 'broken'); } return real.capabilities(); } });
  await submitEvent(ctx, company, SYSTEM, { person_id: w.people.a.id, event_type: 'game', stage: 'completed', ext_id: 'k7', source: 'api', occurred_at: T0 });
  w.clock.t = T0 + 20 * DAY;
  await settleCompany(ctx, company, w.clock.t, { force: true });
  await w.db.run("UPDATE event SET status='reversed' WHERE ext_id='k7'");
  st.broken = true;
  const rep = await settleCompany(ctx, company, w.clock.t, { force: true });
  assert.equal(rep.errors ?? 0, 0, 'pending, not an error');
  assert.equal(await auditCount(w, 'period.settle_blocked'), 0);
  const calls = st.caps;
  await settleCompany(ctx, company, w.clock.t, { force: true });
  assert.ok(st.caps > calls, 'retried at the next close');
});

test('K8: the audit commit backs off and retries past a burst of busy numbers, keeping the chain intact', async () => {
  const w = await world();
  const orig = w.db.batch.bind(w.db);
  let fails = 8;
  w.db.batch = async (stmts) => { if (stmts.some(([sql]) => /INSERT INTO audit/.test(sql)) && fails-- > 0) throw new Error('UNIQUE constraint failed: audit.company_id, audit.n'); return orig(stmts); };
  await commit(w.ctx, w.company.id, 'system', 'test.k8', { x: 1 }, []);
  w.db.batch = orig;
  assert.equal(await auditCount(w, 'test.k8'), 1);
  assert.equal((await verifyChain(w.db, w.company.id)).ok, true);
});

test('K9: a close that changes nothing writes no settle line', async () => {
  const w = await world();
  await settleCompany(w.ctx, w.company, w.clock.t, { force: true });
  await settleCompany(w.ctx, w.company, w.clock.t, { force: true });
  assert.equal(await auditCount(w, 'settle'), 0);
});
