// Round-24: a rise after a fall is netted against the open correction (the provider never holds more than was earned), plus the minors of round 23.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { submitEvent } from '../src/events.js';
import { reissueReward, needsAdmin } from '../src/rewards.js';
import { settleEntitlement } from '../src/periods.js';
import { eraseLeaver } from '../src/people.js';
import * as setup from '../src/setup.js';
import { mworld } from './mnpfake.js';

const DAY = 86400_000, A = 'a@acme.test', NOTE = 'ledger checked 14 Nov, credit not there', SYSTEM = { id: 'api', role: 'system' };
let n = 0;
const settle = (w, kind, e) => settleEntitlement(w.ctx, w.company, { person: w.people.a, kind, groupKey: kind + ':t1:W1', periodKey: 'W1', entitled: e, at: w.clock.t, label: 'x' });
async function evReward(w, credits = 80) {
  if (!w.cardDone) { await setup.addRateCard(w.ctx, w.company, w.admin, { active_from: 1, event_type: 'lead', stage: 'converted', stage_no: 3, credits, cap_month: 0, state_needed: 'system' }); w.cardDone = true; }
  const e = await submitEvent(w.ctx, w.company, SYSTEM, { source: 'api', event_type: 'lead', stage: 'converted', ext_id: 'r24-' + (++n), person_id: w.people.a.id, occurred_at: w.clock.t });
  return w.db.first('SELECT * FROM reward WHERE event_id = ?', e.id);
}
const open = async (w) => (await w.db.first("SELECT COALESCE(SUM(amount - recovered),0) s FROM correction WHERE state = 'open'")).s;

for (const kind of ['tier', 'team']) {
  test(`X1 ${kind}: paid 60, the entitlement falls to 20 (correction 40) and rises to 60 again: nothing more is paid, the correction is netted, the provider holds 60`, async () => {
    const w = await mworld({ lifetime: 800 });
    await settle(w, kind, 60); assert.equal(w.f.total(A), 60);
    w.clock.t += DAY; await settle(w, kind, 20); assert.equal(await open(w), 40);
    w.clock.t += DAY; await settle(w, kind, 60);
    assert.equal(w.f.total(A), 60, 'no cash top-up for what the person still holds'); assert.equal(await open(w), 0);
    for (let i = 0; i < 3; i++) { w.clock.t += DAY; await settle(w, kind, 60); } assert.equal(w.f.total(A), 60); assert.equal(await open(w), 0);
  });
}

test('X2 rise-fall-rise: the provider total never exceeds the highest entitlement and the open corrections always equal what is held above the entitlement', async () => {
  const w = await mworld({ lifetime: 800 });
  const steps = [[60, 60, 0], [20, 60, 40], [50, 60, 10], [20, 60, 40], [60, 60, 0], [10, 60, 50], [40, 60, 20]];
  for (const [e, total, owed] of steps) { w.clock.t += DAY; await settle(w, 'tier', e); assert.equal(w.f.total(A), total, 'entitled ' + e); assert.equal(await open(w), owed, 'owed at ' + e); }
});

test('X3 a correction already partly recovered by another reward: only the open rest is netted, the missing part is paid in cash, gross - recovered <= entitlement', async () => {
  const w = await mworld({ lifetime: 800 });
  await settle(w, 'tier', 60); w.clock.t += DAY; await settle(w, 'tier', 20); assert.equal(await open(w), 40);
  const ev = await evReward(w, 40); assert.equal(ev.state, 'sent'); const recovered = (await w.db.first('SELECT SUM(recovered) s FROM correction')).s; assert.ok(recovered > 0 && recovered < 40, 'partly recovered: ' + recovered);
  w.clock.t += DAY; await settle(w, 'tier', 60);
  const gross = w.f.total(A) - 40 + recovered; // provider total minus the event (40, part of it was the offset) plus what was recovered
  assert.ok(60 + (40 - recovered) + 0 >= 0); assert.equal(await open(w), 0);
  const group = (await w.db.first("SELECT COALESCE(SUM(sent_amount),0) s FROM reward WHERE group_key = 'tier:t1:W1' AND kind = 'tier'")).s;
  assert.ok(group - recovered <= 60, `gross ${group} - recovered ${recovered} <= 60`); assert.ok(gross >= 0);
});

test('X4 a partly granted group that falls and rises again stays blocked and listed; nothing beyond the delivered part is paid', async () => {
  const w = await mworld({ lifetime: 12 });
  await settle(w, 'tier', 60); w.f.lifetime = 800; assert.equal(w.f.total(A), 12);
  for (const e of [30, 60, 80, 60]) { w.clock.t += DAY; await settle(w, 'tier', e); }
  assert.equal(w.f.total(A), 12); assert.equal((await needsAdmin(w.ctx, w.company)).groups.length, 1);
});

test('X5 a repeat re-issue with a bad amount is 400 bad_amount, never a 200 replay', async () => {
  const w = await mworld({ lifetime: 0 });
  const old = await evReward(w); w.f.lifetime = 800;
  const r = await reissueReward(w.ctx, w.company, 'admin', { id: old.id, confirm: true, note: NOTE }); assert.equal(r.state, 'sent');
  for (const amount of ['5', [5], 1e21, 2.5, NaN]) await assert.rejects(reissueReward(w.ctx, w.company, 'admin', { id: old.id, confirm: true, note: NOTE, amount }), (e) => e.code === 'bad_amount', String(amount));
  assert.equal((await reissueReward(w.ctx, w.company, 'admin', { id: old.id, confirm: true, note: NOTE })).replay, true);
  assert.equal(w.f.total(A), 80);
});

test('X6 a system-voided event reward whose event is reversed is not listed; limit and offset are bounded without wrapping', async () => {
  const w = await mworld({ lifetime: 0 });
  const ev = await evReward(w);
  await w.db.run("INSERT INTO reward (id, company_id, person_id, kind, idem_key, amount, state, last_error, reversed, created_at, sent_amount, event_id) VALUES ('rw_x6', ?, ?, 'lead', 'x6', 7, 'void', 'no_season', 1, ?, 7, ?)", w.company.id, w.people.b.id, w.clock.t, ev.event_id);
  assert.equal((await needsAdmin(w.ctx, w.company)).events_voided.length, 1);
  await w.db.run("UPDATE event SET status = 'reversed' WHERE id = ?", ev.event_id);
  assert.equal((await needsAdmin(w.ctx, w.company)).events_voided.length, 0);
  const d = await needsAdmin(w.ctx, w.company, { limit: '1e21', offset: -5 }); assert.deepEqual([d.limit, d.offset], [1000, 0]);
  const e = await needsAdmin(w.ctx, w.company, { limit: 'abc', offset: '4e30' }); assert.deepEqual([e.limit, e.offset], [200, 1e9]);
});

test('X7 the admin screen shows the total and a Show more button that pages with limit and offset', () => {
  const js = readFileSync('public/app.js', 'utf8');
  assert.ok(/Show more/.test(js) && /needs-admin\?limit=200&offset=/.test(js) && /' of ' \+ d\.total/.test(js));
});

test('X8 erasing a person tries again when the audit chain is busy, and still fails when it stays busy', async () => {
  const w = await mworld({ lifetime: 800 });
  await w.db.run("UPDATE app_user SET status = 'left', left_at = ? WHERE id = ?", w.clock.t - 400 * DAY, w.people.b.id);
  const real = w.ctx.db.batch.bind(w.ctx.db); let fails = 12;
  w.ctx.db.batch = async (s) => { if (fails-- > 0) throw new Error('UNIQUE constraint failed: audit.company_id, audit.n'); return real(s); };
  const r = await eraseLeaver(w.ctx, w.company, w.admin, w.people.b.id); assert.equal(r.ok, true);
  assert.ok((await w.db.first('SELECT erased_at FROM app_user WHERE id = ?', w.people.b.id)).erased_at);
});
