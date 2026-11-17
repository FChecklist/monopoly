// Round-1 security findings that live in events, penalties and the board: S1, S4, S6, S9, S11 (and the reversal appeal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, exampleCard, SYSTEM, T0 } from './helpers.js';
import { submitEvent, applyEvent, resumeApproved, requestReversal, appealReversal, decideReversalAppeal } from '../src/events.js';
import { proposePenalty, approvePenalty, appealPenalty, decideAppeal } from '../src/penalty.js';
import { enterLane, finishLaneTask, offerSwap, answerSwap } from '../src/board.js';
import { addPerson } from '../src/people.js';
import * as setup from '../src/setup.js';

const gameDone = (w, who, ext, extra = {}) => submitEvent(w.ctx, w.company, SYSTEM, { person_id: who.id, event_type: 'game', stage: 'completed', ext_id: ext, source: 'api', occurred_at: w.clock.t, ...extra });
const ruleFor = async (w, effect = 'steps_back') => {
  const r = await setup.addPenaltyRule(w.ctx, w.company, w.admin, { event_type: 'game', effect, amount: 1 });
  await setup.publishPenaltyRule(w.ctx, w.company, w.admin, r.id);
  return r.id;
};
const cases = (w) => w.db.first('SELECT COUNT(*) n FROM penalty_case').then((r) => r.n);
const auditData = (w, action) => w.db.all('SELECT data FROM audit WHERE action = ?', action).then((rows) => rows.map((r) => r.data).join('\n'));

test('S1: a person who never acknowledged the rules does not stop the event, the batch or the tick', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  await ruleFor(w);
  await w.db.run("DELETE FROM consent WHERE user_id = ? AND kind = 'penalty_rules'", w.people.a.id);
  const r = await gameDone(w, w.people.a, 'S1');
  assert.ok(r.ok); assert.equal(r.status, 'applied', 'the event is applied, not stuck as approved');
  assert.equal(await cases(w), 0, 'no notice, no proposal');
  assert.equal((await w.db.first("SELECT COALESCE(SUM(amount),0) s FROM reward WHERE person_id = ?", w.people.a.id)).s, 40);
});

test('S1: one bad approved event cannot stall the others in the tick', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  const r = await gameDone(w, w.people.a, 'S1b');
  await w.db.run("UPDATE event SET status = 'approved', applied_at = NULL WHERE id = ?", r.id);
  await w.db.run("INSERT INTO event (id, company_id, person_id, source, event_type, stage, ext_id, occurred_at, status, rate_card_id, season_id, created_at) VALUES ('ev_bad',?,?,'api','game','completed','BAD',?,'approved','missing',?,?)", w.company.id, w.people.b.id, T0, w.season, T0);
  const n = await resumeApproved(w.ctx, w.company);
  assert.equal(n, 1);
  assert.equal((await w.db.first('SELECT status FROM event WHERE id = ?', r.id)).status, 'applied');
});

test('S1/13: applying the same event again proposes its penalty once per rule', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  await ruleFor(w);
  const r = await gameDone(w, w.people.a, 'S1c');
  assert.equal(await cases(w), 1);
  await applyEvent(w.ctx, w.company, r.id); await applyEvent(w.ctx, w.company, r.id);
  assert.equal(await cases(w), 1);
});

test('S9: an acknowledgement given before the rule was published does not count', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  w.clock.t = T0 + 5 * 86400_000;
  await ruleFor(w);
  await w.db.run("UPDATE consent SET at = ? WHERE user_id = ? AND kind = 'penalty_rules'", T0, w.people.a.id);
  await gameDone(w, w.people.a, 'S9a');
  assert.equal(await cases(w), 0);
  await w.db.run("UPDATE consent SET at = ? WHERE user_id = ? AND kind = 'penalty_rules'", w.clock.t + 1, w.people.a.id);
  w.clock.t += 5;
  await gameDone(w, w.people.a, 'S9b');
  assert.equal(await cases(w), 1);
});

const appealed = async (w, proposer = w.people.mgr) => {
  const c = await proposePenalty(w.ctx, w.company, proposer, { person_id: w.people.a.id, effect: 'steps_back', amount: 1, reason: 'Late report' });
  await approvePenalty(w.ctx, w.company, w.admin, c.id);
  await appealPenalty(w.ctx, w.company, w.people.a, c.id);
  return c.id;
};
test('S6: a level 1 appeal is decided by the person\'s own manager or HR, not by any manager', async () => {
  const w = await world();
  const { user: other } = await addPerson(w.ctx, w.company, w.admin, { email: 'm2@acme.test', name: 'm2', role: 'manager' });
  const id = await appealed(w, w.people.hr);
  await assert.rejects(decideAppeal(w.ctx, w.company, other, id, true, 'x'), /different reviewer/);
  await assert.rejects(decideAppeal(w.ctx, w.company, w.admin, id, true, 'x'), /different reviewer/, 'admin is level 3');
  const out = await decideAppeal(w.ctx, w.company, w.people.mgr, id, false, 'upheld');
  assert.equal(out.state, 'upheld');
});

test('S6: a lane task is cleared only by the manager of that person\'s team or the admin', async () => {
  const w = await world();
  const { user: other } = await addPerson(w.ctx, w.company, w.admin, { email: 'm3@acme.test', name: 'm3', role: 'manager' });
  await enterLane(w.ctx, w.company, w.people.a.id, 'Talk to Ravi about the invoice', 'system');
  const t = (await w.db.first("SELECT id FROM lane_task WHERE person_id = ?", w.people.a.id)).id;
  await assert.rejects(finishLaneTask(w.ctx, w.company, t, other.id), /manager of this person/);
  await assert.rejects(finishLaneTask(w.ctx, w.company, t, w.people.hr.id), /manager of this person/);
  await assert.rejects(finishLaneTask(w.ctx, w.company, t, w.people.a.id), /manager of this person/);
  await finishLaneTask(w.ctx, w.company, t, w.people.mgr.id);
  assert.equal((await w.db.first('SELECT state FROM lane_task WHERE id = ?', t)).state, 'done');
});

test('S6: the person concerned cannot decide the appeal of their own reversal', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  const hr = w.people.hr;
  const r = await gameDone(w, hr, 'S6c');
  await requestReversal(w.ctx, w.company, SYSTEM, r.id, { reason: 'cancelled' });
  await appealReversal(w.ctx, w.company, hr, r.id);
  await assert.rejects(decideReversalAppeal(w.ctx, w.company, hr, r.id, true), /never the person/);
  const out = await decideReversalAppeal(w.ctx, w.company, w.admin, r.id, false);
  assert.equal(out.status, 'applied');
});

test('S4: the immutable audit holds ids and codes, never free text', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  await enterLane(w.ctx, w.company, w.people.a.id, 'Talk to Ravi about the SECRETTEXT invoice', 'system');
  const r = await submitEvent(w.ctx, w.company, SYSTEM, { person_id: w.people.a.id, event_type: 'game', stage: 'completed', ext_id: 'CRM-LEAD-SECRETEXT', source: 'api', occurred_at: w.clock.t });
  assert.ok(r.ok);
  const id = await appealed(w);
  await decideAppeal(w.ctx, w.company, w.people.hr, id, true, 'Rohit was unwell SECRETNOTE');
  assert.ok(!/SECRET/.test(await auditData(w, 'lane.enter')), 'lane.enter');
  assert.ok(!/SECRET/i.test(await auditData(w, 'event.submit')), 'event.submit');
  assert.ok(!/SECRET/.test(await auditData(w, 'penalty.reverse')), 'penalty.reverse');
  assert.match(await auditData(w, 'penalty.reverse'), /appeal_won/);
});

test('S11: an employee request cannot take the id a real event will use, and stage 1 needs the prospect key', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  const mine = await submitEvent(w.ctx, w.company, w.people.a, { person_id: w.people.a.id, event_type: 'game', stage: 'created', ext_id: 'G-1', dedupe_key: 'k-g1', source: 'manual', occurred_at: w.clock.t });
  assert.ok(mine.ok);
  const real = await submitEvent(w.ctx, w.company, w.people.mgr, { person_id: w.people.b.id, event_type: 'game', stage: 'created', ext_id: 'G-1', dedupe_key: 'k-g1b', source: 'manual', occurred_at: w.clock.t });
  assert.ok(real.ok, 'the real event is not blocked as a duplicate: ' + real.reason);
  const nokey = await submitEvent(w.ctx, w.company, w.people.a, { person_id: w.people.a.id, event_type: 'game', stage: 'created', ext_id: 'G-2', source: 'manual', occurred_at: w.clock.t });
  assert.equal(nokey.reason, 'dedupe_key_required');
});

test('S11: swaps respect holders, targets and levels, and a clash is a clean 409, not a 500', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  const { ctx, company, admin } = w, a = w.people.a, b = w.people.b;
  const d1 = (await setup.addDesk(ctx, company, admin, { square_idx: 1, name: 'D1' })).id;
  const d2 = (await setup.addDesk(ctx, company, admin, { square_idx: 2, name: 'D2' })).id;
  const own = (desk, who, level = 1) => w.db.run('INSERT INTO desk_owner (desk_id, owner_key, person_id, level, claimed_at) VALUES (?,?,?,?,?)', desk, who.id, who.id, level, T0);
  await own(d1, a); await own(d2, b); await own(d1, b); // b already holds d1 too
  await assert.rejects(offerSwap(ctx, company, a, { toPersonId: b.id, deskFrom: d1, deskTo: 'nope' }), (e) => e.status === 409);
  const o = await offerSwap(ctx, company, a, { toPersonId: b.id, deskFrom: d1, deskTo: d2 });
  await assert.rejects(answerSwap(ctx, company, b, o.id, true), (e) => e.status === 409 && e.code === 'already_held');
  // a desk tied to a target needs the target met by the new holder
  const t = await setup.addTarget(ctx, company, admin, { name: 'T', scope: 'person', period: 'month', event_type: 'game', stage: 'completed', tiers: [{ count: 1, bonus: 10 }] });
  const d3 = (await setup.addDesk(ctx, company, admin, { square_idx: 4, name: 'D3', target_id: t.id })).id;
  const d4 = (await setup.addDesk(ctx, company, admin, { square_idx: 5, name: 'D4' })).id;
  await own(d3, a); await own(d4, b);
  const o2 = await offerSwap(ctx, company, a, { toPersonId: b.id, deskFrom: d3, deskTo: d4 });
  await assert.rejects(answerSwap(ctx, company, b, o2.id, true), (e) => e.status === 409 && e.code === 'target_not_met');
});
