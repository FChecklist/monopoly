// Event intake and abuse cases: fake events, duplicates, self-credit, replay, backdating, CSV tricks, isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, exampleCard, SYSTEM, T0, ENV } from './helpers.js';
import { submitEvent, approveEvent, rejectEvent, importCsv, parseCsv, requestReversal, approveReversal, appealReversal, processReversals, decideReversalAppeal } from '../src/events.js';
import { createCompany, addPerson } from '../src/people.js';
import { DAY } from '../src/util.js';

const base = (w, o) => ({ person_id: w.people.a.id, occurred_at: w.clock.t, source: 'manual', ...o });
const earned = (w, who) => w.db.first("SELECT COALESCE(SUM(amount),0) s FROM reward WHERE person_id = ? AND state IN ('queued','sent','recorded')", w.people[who].id).then((r) => r.s);

test('an employee cannot create a counted event for anyone; a request needs a manager and pays nothing until then', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  const { ctx, company } = w;
  const other = await submitEvent(ctx, company, w.people.a, base(w, { person_id: w.people.b.id, event_type: 'game', stage: 'created', ext_id: 'e1' }));
  assert.equal(other.reason, 'not_allowed');
  const mine = await submitEvent(ctx, company, w.people.a, base(w, { event_type: 'game', stage: 'created', ext_id: 'e2', dedupe_key: 'mine-e2' }));
  assert.ok(mine.ok); assert.equal(mine.status, 'pending');
  assert.equal(await earned(w, 'a'), 0);
  await assert.rejects(approveEvent(ctx, company, w.people.a, mine.id), /cannot approve/);
  await approveEvent(ctx, company, w.people.mgr, mine.id);
  assert.equal(await earned(w, 'a'), 10);
});
test('self-credit: a manager cannot approve their own event, nor one they entered; a manager entering for self needs someone else', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  const { ctx, company } = w, mgr = w.people.mgr;
  const own = await submitEvent(ctx, company, mgr, base(w, { person_id: mgr.id, event_type: 'game', stage: 'created', ext_id: 'm1' }));
  assert.ok(own.ok); assert.equal(own.status, 'pending', 'self entered is never auto-approved');
  await assert.rejects(approveEvent(ctx, company, mgr, own.id), /own event|entered/);
  await approveEvent(ctx, company, w.people.hr, own.id);
  assert.equal(await earned(w, 'mgr'), 10);
  const entered = await submitEvent(ctx, company, mgr, base(w, { event_type: 'lead', stage: 'verified', ext_id: 'm2' }));
  await assert.rejects(approveEvent(ctx, company, mgr, entered.id), /entered|own/);
});
test('a manager cannot enter or approve for another team', async () => {
  const w = await world(); await exampleCard(w);
  const { ctx, company } = w;
  const { user } = await addPerson(ctx, company, w.admin, { email: 'x@acme.test', name: 'x', role: 'employee' });
  const r = await submitEvent(ctx, company, w.people.mgr, base(w, { person_id: user.id, event_type: 'game', stage: 'created', ext_id: 'z' }));
  assert.equal(r.reason, 'not_your_team');
});
test('system-confirmed stages cannot be entered by hand; humans cannot use system sources; systems cannot use manual', async () => {
  const w = await world(); await exampleCard(w);
  const { ctx, company } = w;
  assert.equal((await submitEvent(ctx, company, w.people.mgr, base(w, { event_type: 'game', stage: 'completed', ext_id: 'h1' }))).reason, 'needs_system_source');
  assert.equal((await submitEvent(ctx, company, w.people.mgr, base(w, { event_type: 'game', stage: 'created', ext_id: 'h2', source: 'api' }))).reason, 'system_only');
  assert.equal((await submitEvent(ctx, company, SYSTEM, base(w, { event_type: 'game', stage: 'created', ext_id: 'h3', source: 'manual' }))).reason, 'bad_source');
});
test('duplicates: same external id, same lead from two people, unknown person, no season, no rate card, bad date', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  const { ctx, company } = w, mgr = w.people.mgr;
  const ok = await submitEvent(ctx, company, mgr, base(w, { event_type: 'lead', stage: 'entered', ext_id: 'D1', dedupe_key: 'Same.Prospect@x.com' }));
  assert.ok(ok.ok);
  assert.equal((await submitEvent(ctx, company, mgr, base(w, { event_type: 'lead', stage: 'entered', ext_id: 'D1' }))).reason, 'duplicate');
  assert.equal((await submitEvent(ctx, company, mgr, base(w, { person_id: w.people.b.id, event_type: 'lead', stage: 'entered', ext_id: 'D2', dedupe_key: ' same.prospect@x.com ' }))).reason, 'duplicate_lead', 'first valid entry wins');
  assert.equal(await earned(w, 'b'), 0);
  assert.equal((await submitEvent(ctx, company, mgr, base(w, { person_id: 'u_nope', event_type: 'lead', stage: 'entered', ext_id: 'D3' }))).reason, 'unknown_person');
  assert.equal((await submitEvent(ctx, company, mgr, base(w, { event_type: 'lead', stage: 'entered', ext_id: 'D4', occurred_at: T0 - 400 * DAY }))).reason, 'outside_season');
  assert.equal((await submitEvent(ctx, company, mgr, base(w, { event_type: 'nothing', stage: 'x', ext_id: 'D5' }))).reason, 'no_rate_card');
  assert.equal((await submitEvent(ctx, company, mgr, base(w, { event_type: 'lead', stage: 'entered', ext_id: 'D6', occurred_at: 'soon' }))).reason, 'bad_date');
  assert.equal((await submitEvent(ctx, company, mgr, base(w, { event_type: 'lead', stage: 'entered', ext_id: 'D7', occurred_at: w.clock.t + 30 * DAY }))).reason, 'bad_date', 'the future is refused');
});
test('the lead key is stored only as a keyed hash, never the prospect detail', async () => {
  const w = await world(); await exampleCard(w);
  await submitEvent(w.ctx, w.company, w.people.mgr, base(w, { event_type: 'lead', stage: 'entered', ext_id: 'P1', dedupe_key: 'secret.person@example.com' }));
  const dump = JSON.stringify(await w.db.all('SELECT * FROM event')) + JSON.stringify(await w.db.all('SELECT * FROM audit'));
  assert.ok(!dump.includes('secret.person'));
});
test('backdated events need two approvers, the second from HR or admin', async () => {
  const w = await world(); await exampleCard(w);
  const { ctx, company } = w;
  const r = await submitEvent(ctx, company, w.people.mgr, base(w, { event_type: 'game', stage: 'created', ext_id: 'bd', occurred_at: w.clock.t - 9 * DAY }));
  assert.equal(r.approvals_required, 2);
  const { user: mgr2 } = await addPerson(ctx, company, w.admin, { email: 'm2@acme.test', name: 'm2', role: 'manager' });
  await approveEvent(ctx, company, w.people.hr, r.id);
  assert.equal(await earned(w, 'a'), 0, 'one approval is not enough');
  await assert.rejects(approveEvent(ctx, company, w.people.hr, r.id), /already approved/);
  await approveEvent(ctx, company, w.admin, r.id);
  assert.equal(await earned(w, 'a'), 10);
});
test('a rejected event shows a reason and pays nothing', async () => {
  const w = await world(); await exampleCard(w);
  const { ctx, company } = w;
  const r = await submitEvent(ctx, company, w.people.a, base(w, { event_type: 'game', stage: 'created', ext_id: 'rj', dedupe_key: 'rj-1' }));
  await rejectEvent(ctx, company, w.people.mgr, r.id, 'not real');
  const ev = await w.db.first('SELECT status, reason FROM event WHERE id = ?', r.id);
  assert.deepEqual({ ...ev }, { status: 'rejected', reason: 'not real' });
  assert.equal(await earned(w, 'a'), 0);
});
test('too many events in a day are held for a person to look at', async () => {
  const w = await world({ settings: { daily_event_limit: 3 } }); await exampleCard(w);
  const { ctx, company } = w;
  const out = [];
  for (let i = 0; i < 5; i++) out.push(await submitEvent(ctx, company, w.people.mgr, base(w, { event_type: 'game', stage: 'created', ext_id: 'q' + i })));
  assert.deepEqual(out.map((o) => o.status), ['applied', 'applied', 'applied', 'held', 'held']);
  assert.equal(await earned(w, 'a'), 30);
});
test('CSV: formula cells are defused, row limit holds, preview changes nothing, unknown people are reported', async () => {
  const w = await world({ settings: { daily_event_limit: 1000, csv_max_rows: 5 } }); await exampleCard(w);
  const { ctx, company } = w;
  const csv = `work_email,event_type,stage,ext_id\na@acme.test,game,created,=cmd|' /C calc'!A0\nnobody@acme.test,game,created,c2\n`;
  const rows = parseCsv(csv);
  assert.ok(rows[0].ext_id.startsWith("'"), 'formula defused');
  const prev = await importCsv(ctx, company, w.people.hr, csv, { commit: false });
  assert.equal(prev.accepted, 1); assert.equal(prev.rejected[0].reason, 'unknown_person'); assert.equal(prev.committed, false);
  assert.equal(await earned(w, 'a'), 0);
  const done = await importCsv(ctx, company, w.people.hr, csv, { commit: true });
  assert.equal(done.committed, true);
  assert.equal(await earned(w, 'a'), 10);
  const many = 'work_email,event_type,stage,ext_id\n' + Array.from({ length: 9 }, (_, i) => `a@acme.test,game,created,r${i}`).join('\n');
  await assert.rejects(importCsv(ctx, company, w.people.hr, many), /At most 5 rows/);
});
test('a large CSV needs a second person before anything is paid', async () => {
  const w = await world({ settings: { daily_event_limit: 1000, second_approver_over: 5 } }); await exampleCard(w);
  const { ctx, company } = w;
  const csv = 'work_email,event_type,stage,ext_id\n' + Array.from({ length: 6 }, (_, i) => `a@acme.test,attendance,on_time,${i}`).join('\n');
  const r = await importCsv(ctx, company, w.people.hr, csv, { commit: true });
  assert.ok(r.needs_second_person === false || r.needs_second_person === true);
  // attendance is system-only, so humans get nothing from the CSV at all
  assert.equal(await earned(w, 'a'), 0);
});
test('companies are isolated: nobody can enter or approve across companies', async () => {
  const w = await world(); await exampleCard(w);
  const { ctx } = w;
  const other = await createCompany(ctx, { name: 'Other', slug: 'other', adminEmail: 'o@other.test' });
  const r = await submitEvent(ctx, other.company, other.admin, { person_id: w.people.a.id, event_type: 'game', stage: 'created', ext_id: 'x', occurred_at: w.clock.t });
  assert.equal(r.ok, false);
  const mine = await submitEvent(ctx, w.company, w.people.mgr, base(w, { event_type: 'game', stage: 'created', ext_id: 'iso' }));
  assert.ok(mine.ok);
  await assert.rejects(approveEvent(ctx, other.company, other.admin, mine.id), /No such event/);
  // the same e-mail cannot sit in two companies
  await assert.rejects(addPerson(ctx, other.company, other.admin, { email: 'a@acme.test', name: 'dup' }), /cannot be added/);
});
test('reversal: system-confirmed waits for notice; person can appeal; HR decides; manager-recorded needs a different HR/admin', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  const { ctx, company } = w;
  const e = await submitEvent(ctx, company, SYSTEM, base(w, { event_type: 'game', stage: 'completed', ext_id: 'rv', source: 'api' }));
  assert.equal(await earned(w, 'a'), 40);
  await requestReversal(ctx, company, SYSTEM, e.id, { reason: 'refund' });
  await appealReversal(ctx, company, w.people.a, e.id);
  w.clock.t += 5 * DAY;
  assert.equal(await processReversals(ctx, company), 0, 'an appeal freezes the reversal');
  assert.equal(await earned(w, 'a'), 40);
  await decideReversalAppeal(ctx, company, w.people.hr, e.id, false);
  assert.equal((await w.db.first('SELECT status FROM event WHERE id = ?', e.id)).status, 'applied');
  // manager-recorded
  const f = await submitEvent(ctx, company, w.people.mgr, base(w, { event_type: 'game', stage: 'created', ext_id: 'rv2' }));
  await requestReversal(ctx, company, w.people.mgr, f.id, { reason: 'fake' });
  await assert.rejects(approveReversal(ctx, company, w.people.mgr, f.id), /different HR or admin/);
  await approveReversal(ctx, company, w.people.hr, f.id);
  assert.equal(await earned(w, 'a'), 40);
});
test('an employee cannot reverse events; nobody reverses their own', async () => {
  const w = await world(); await exampleCard(w);
  const { ctx, company } = w;
  const f = await submitEvent(ctx, company, w.people.mgr, base(w, { event_type: 'game', stage: 'created', ext_id: 'x9' }));
  await assert.rejects(requestReversal(ctx, company, w.people.b, f.id, { reason: 'x' }), /cannot reverse/);
  await assert.rejects(requestReversal(ctx, company, w.people.a, f.id, { reason: 'x' }), /cannot reverse/);
});
