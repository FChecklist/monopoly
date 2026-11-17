// Round-5 money findings: each test pins one failure that the round-5 audit found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, exampleCard, SYSTEM, T0 } from './helpers.js';
import { submitEvent, requestReversal, approveReversal, appealReversal, decideReversalAppeal, processReversals } from '../src/events.js';
import { settleCompany, settleEntitlement } from '../src/periods.js';
import { grant, releaseWaiting } from '../src/rewards.js';
import { ProviderError } from '../src/provider/errors.js';
import { StubProvider } from '../src/provider/stub.js';
import { proposePenalty, approvePenalty, appealPenalty, decideAppeal } from '../src/penalty.js';
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

test('J1: a waiting row (insufficient_budget) voided by a reversal does not block the regained tier', async () => {
  const w = await world();
  const a = w.people.a;
  const real = new StubProvider(w.db, w.company.id);
  let first = true;
  w.ctx.provider = () => wrap(real, { credit: async (x) => { if (first) { first = false; throw new ProviderError('insufficient_budget', 'no'); } return real.credit(x); } });
  const args = { person: a, kind: 'tier', groupKey: 'tier:t1:PJ', periodKey: 'PJ', at: w.clock.t, label: 't' };
  await settleEntitlement(w.ctx, w.company, { ...args, entitled: 100 });
  assert.equal((await w.db.first("SELECT state, last_error FROM reward WHERE group_key='tier:t1:PJ'")).state, 'waiting');
  await settleEntitlement(w.ctx, w.company, { ...args, entitled: 0 }); // tier lost: voided by the reversal
  const v = await w.db.first("SELECT state, last_error FROM reward WHERE group_key='tier:t1:PJ'");
  assert.equal(v.state, 'void'); assert.equal(v.last_error, null, 'a reversal void carries no system reason');
  const out = await settleEntitlement(w.ctx, w.company, { ...args, entitled: 100 }); // regained
  assert.equal(out.paid, 100, 'paid, not replayed as void_before');
  await settleEntitlement(w.ctx, w.company, { ...args, entitled: 100 });
  assert.equal(await count(w, "group_key='tier:t1:PJ' AND state IN ('queued','sent','waiting')"), 1, 'exactly once');
});

test('J1: a system void (no_season) still makes no new rows at later ticks, and a reversal void is told apart', async () => {
  const w = await world();
  const at = T0 + 350 * DAY;
  const args = { person: w.people.a, kind: 'tier', groupKey: 'tier:t1:PS', periodKey: 'PS', at, label: 't', entitled: 100 };
  await settleEntitlement(w.ctx, w.company, args);
  w.clock.t = at + 30 * DAY;
  await releaseWaiting(w.ctx, w.company);
  const rows = await count(w, "group_key='tier:t1:PS'");
  for (let i = 0; i < 3; i++) { await releaseWaiting(w.ctx, w.company); await settleEntitlement(w.ctx, w.company, args); }
  assert.equal(await count(w, "group_key='tier:t1:PS' AND state='void' AND last_error='no_season'"), 1);
  assert.equal(await count(w, "group_key='tier:t1:PS'"), rows);
});

/** A system-kind reversal that the person has appealed. */
async function appealed(ext) {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  await exampleCard(w);
  const r = await submitEvent(w.ctx, w.company, SYSTEM, { person_id: w.people.a.id, event_type: 'game', stage: 'completed', ext_id: ext, source: 'api', occurred_at: T0 });
  await requestReversal(w.ctx, w.company, w.people.mgr, r.id, { reason: 'fake', kind: 'fake' });
  await appealReversal(w.ctx, w.company, w.people.a, r.id);
  return { w, r };
}

test('J2: a denial that lost the race to an uphold does not put the event back to applied', async () => {
  const { w, r } = await appealed('j2');
  const undo = beforeBatch(w, /status='applied', reversal_kind=NULL/, () => w.db.run("UPDATE event SET status='reversed', reversal_appeal=0 WHERE id=?", r.id));
  await assert.rejects(decideReversalAppeal(w.ctx, w.company, w.people.admin, r.id, false), /already/);
  undo();
  assert.equal((await w.db.first('SELECT status FROM event WHERE id=?', r.id)).status, 'reversed');
  assert.equal(await auditCount(w, 'event.reversal_denied'), 0);
});

test('J3: an appeal landing after the reversal ran freezes no corrections', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  await exampleCard(w);
  const r = await submitEvent(w.ctx, w.company, SYSTEM, { person_id: w.people.a.id, event_type: 'game', stage: 'completed', ext_id: 'j3', source: 'api', occurred_at: T0 });
  await requestReversal(w.ctx, w.company, w.people.mgr, r.id, { reason: 'fake', kind: 'fake' });
  await w.db.run("INSERT INTO correction (id, company_id, person_id, amount, recovered, state, reason, event_id, created_at) VALUES ('crj3',?,?,30,0,'open','t',?,?)", w.company.id, w.people.a.id, r.id, T0);
  const undo = beforeBatch(w, /reversal_appeal = 1 WHERE/, () => w.db.run("UPDATE event SET status='reversed' WHERE id=?", r.id));
  await assert.rejects(appealReversal(w.ctx, w.company, w.people.a, r.id), /already/);
  undo();
  assert.equal((await w.db.first("SELECT state FROM correction WHERE id='crj3'")).state, 'open');
  assert.equal(await auditCount(w, 'event.reversal_appeal'), 0);
});

test('J4: a retriable error half way leaves the reversal due, so the tick retries and a denial cannot restore it', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  await exampleCard(w);
  const real = new StubProvider(w.db, w.company.id);
  const st = { down: false };
  w.ctx.provider = () => wrap(real, { reverse: async (x) => { if (st.down) throw new ProviderError('provider_down', 'down'); return real.reverse(x); } });
  const r = await submitEvent(w.ctx, w.company, SYSTEM, { person_id: w.people.a.id, event_type: 'game', stage: 'completed', ext_id: 'j4', source: 'api', occurred_at: T0 });
  await requestReversal(w.ctx, w.company, w.people.mgr, r.id, { reason: 'fake', kind: 'fake' });
  st.down = true;
  await assert.rejects(approveReversal(w.ctx, w.company, w.people.hr, r.id), ProviderError);
  const ev = await w.db.first('SELECT status, reversal_due, reversal_appeal FROM event WHERE id=?', r.id);
  assert.equal(ev.status, 'reversal_pending'); assert.ok(ev.reversal_due !== null, 'marked as started'); assert.equal(ev.reversal_appeal, 0);
  await assert.rejects(decideReversalAppeal(w.ctx, w.company, w.people.admin, r.id, false), /No appeal/);
  st.down = false;
  assert.equal(await processReversals(w.ctx, w.company), 1);
  assert.equal((await w.db.first('SELECT status FROM event WHERE id=?', r.id)).status, 'reversed');
});

test('J5: reversing a penalty with a stale applied_at changes nothing', async () => {
  const w = await world();
  const c = await proposePenalty(w.ctx, w.company, w.people.mgr, { person_id: w.people.a.id, effect: 'steps_back', amount: 2, reason: 'test' });
  await approvePenalty(w.ctx, w.company, w.people.hr, c.id);
  await appealPenalty(w.ctx, w.company, w.people.a, c.id);
  const undo = beforeBatch(w, /penalty_case SET state='reversed'/, () => w.db.run("UPDATE penalty_case SET applied_at = ?, state='appealed' WHERE id = ?", w.clock.t, c.id));
  const out = await decideAppeal(w.ctx, w.company, w.people.hr, c.id, true, 'ok');
  undo();
  assert.equal(out.state, 'appealed');
  assert.equal((await w.db.first('SELECT state FROM penalty_case WHERE id=?', c.id)).state, 'appealed');
  assert.equal(await auditCount(w, 'penalty.reverse'), 0);
});

test('J6: a retriable provider error on one person does not stop the close', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  await exampleCard(w);
  const { ctx, company, admin } = w;
  await setup.addTarget(ctx, company, admin, { name: 'Weekly', scope: 'person', period: 'week', event_type: 'game', stage: 'completed', tiers: [{ count: 1, bonus: 100 }], active_from: T0 - 40 * DAY });
  const real = new StubProvider(w.db, w.company.id);
  const st = { down: false };
  ctx.provider = () => wrap(real, { reverse: async (x) => { if (st.down) throw new ProviderError('provider_down', 'down'); return real.reverse(x); } });
  const ev = (who, ext) => submitEvent(ctx, company, SYSTEM, { person_id: who.id, event_type: 'game', stage: 'completed', ext_id: ext, source: 'api', occurred_at: T0 });
  await ev(w.people.a, 'j6a'); await ev(w.people.b, 'j6b');
  w.clock.t = T0 + 20 * DAY;
  await settleCompany(ctx, company, w.clock.t, { force: true });
  assert.equal(await count(w, "kind='tier' AND state='sent'"), 2);
  await w.db.run("UPDATE event SET status='reversed' WHERE ext_id IN ('j6a','j6b')");
  st.down = true;
  const rep = await settleCompany(ctx, company, w.clock.t, { force: true });
  assert.equal(rep.errors, 2, 'both entries were tried, the run was not aborted');
  st.down = false;
  await settleCompany(ctx, company, w.clock.t, { force: true });
  assert.equal(await count(w, "kind='tier' AND reversed=1"), 2, 'the next close finishes it');
});
