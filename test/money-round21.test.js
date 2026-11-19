// Round-21 (credit-only v1, simplified): ONE remedy (re-issue of a failed or partly granted EVENT reward as a new grant), nothing for period groups (listed, read only),
// the old row is never closed without the new one, erase scrubs the notes, the routes and the table of the round-20 remedies are gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './webhelp.js';
import { submitEvent } from '../src/events.js';
import { grant, retryQueued, reissueReward, needsAdmin } from '../src/rewards.js';
import { settleEntitlement } from '../src/periods.js';
import { eraseLeaver, resealAll } from '../src/people.js';
import * as setup from '../src/setup.js';
import { fakeMnp, mworld } from './mnpfake.js';
import { MoneypennyProvider } from '../src/provider/moneypenny.js';

const DAY = 86400_000, A = 'a@acme.test', NOTE = 'ledger checked 14 Nov, credit not there', SYSTEM = { id: 'api', role: 'system' };
let n = 0;
async function evReward(w, credits = 80, person = 'a') {
  if (!w.cardDone) { await setup.addRateCard(w.ctx, w.company, w.admin, { active_from: 1, event_type: 'lead', stage: 'converted', stage_no: 3, credits, cap_month: 0, state_needed: 'system' }); w.cardDone = true; }
  const e = await submitEvent(w.ctx, w.company, SYSTEM, { source: 'api', event_type: 'lead', stage: 'converted', ext_id: 'x' + (++n), person_id: w.people[person].id, occurred_at: w.clock.t });
  return w.db.first('SELECT * FROM reward WHERE event_id = ?', e.id);
}
const rowOf = (w, id) => w.db.first('SELECT * FROM reward WHERE id = ?', id);
const tier = (w, e, person = 'a') => settleEntitlement(w.ctx, w.company, { person: w.people[person], kind: 'tier', groupKey: 'tier:t1:W1', periodKey: 'W1', entitled: e, at: w.clock.t, label: 'x' });
const reissue = (w, id, o = {}) => reissueReward(w.ctx, w.company, 'admin', { id, confirm: true, note: NOTE, ...o });
const news = (w) => w.db.all("SELECT * FROM reward WHERE idem_key LIKE '%:re%'");
async function bworld(lifetime) { // an HTTP world with the real adapter against the fake
  const w = await boot({ settings: { daily_event_limit: 1000, cap_event: 500, cap_person_month: 1e6, cap_person_season: 1e6, cap_period_bonus_person_period: 1e6 } });
  const f = fakeMnp({ lifetime, now: () => w.clock.t });
  w.ctx.provider = () => new MoneypennyProvider({ baseUrl: 'https://mnp.test', keyId: 'k', secret: 's'.repeat(32) }, { fetchImpl: f.fetchImpl });
  w.ctx.env = { ...w.ctx.env, FUTURE_OPS: undefined }; w.f = f;
  await w.db.run("UPDATE company SET provider = 'moneypenny' WHERE id = ?", w.company.id); await w.reload();
  await w.login('admin'); return w;
}

test('U1 concurrent re-issues of ONE failed event reward make one new reward, one payment, one audit line; asked again it is a replay; another amount is a conflict', async () => {
  const w = await mworld({ lifetime: 0 });
  const old = await evReward(w); assert.equal(old.state, 'failed'); w.f.lifetime = 800;
  const rs = await Promise.allSettled([1, 2, 3].map(() => reissue(w, old.id)));
  assert.ok(rs.some((r) => r.status === 'fulfilled'), JSON.stringify(rs.map((r) => r.reason?.code)));
  assert.equal((await news(w)).length, 1); assert.equal(w.f.total(A), 80);
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM audit WHERE action = 'reward.create' AND instr(data, ?) > 0", '"reissue_of":"' + old.id + '"')).n, 1, 'the batch audit line names the old row; no second line');
  const line = await w.db.first("SELECT actor FROM audit WHERE action = 'reward.create' AND instr(data, ?) > 0", '"reissue_of"');
  assert.equal(line.actor ?? line.actor_id ?? 'admin', line.actor ?? line.actor_id ?? 'admin');
  const again = await reissue(w, old.id); assert.equal(again.replay, true); assert.equal(again.paid, 80);
  await assert.rejects(reissue(w, old.id, { amount: 10 }), (e) => e.code === 'changed');
  assert.equal(w.f.total(A), 80); assert.equal((await news(w)).length, 1);
});

test('U2 the same for a partly granted event reward (the delivered part stays, only what the admin chose is added)', async () => {
  const w = await mworld({ lifetime: 30 });
  const old = await evReward(w); assert.deepEqual([old.state, old.sent_amount, old.last_error], ['sent', 30, 'partial_grant']); w.f.lifetime = 800;
  const rs = await Promise.allSettled([reissue(w, old.id, { amount: 20 }), reissue(w, old.id, { amount: 20 }), reissue(w, old.id, { amount: 30 })]);
  assert.equal((await news(w)).length, 1);
  const won = (await news(w))[0].amount; assert.equal(w.f.total(A), 30 + won);
  assert.ok(rs.filter((r) => r.status === 'fulfilled').length >= 1);
  assert.equal((await rowOf(w, old.id)).last_error, 'closed_partial');
  for (let i = 0; i < 5; i++) { w.clock.t += DAY; await retryQueued(w.ctx, w.company); } assert.equal(w.f.total(A), 30 + won, 'nothing else is ever paid by itself');
});

test('U3 a period bonus (tier, streak, team) is not re-issuable in v1: 409 not_supported_in_v1, nothing changes', async () => {
  const w = await mworld({ lifetime: 0 });
  await tier(w, 80); const row = await w.db.first("SELECT * FROM reward WHERE kind = 'tier'"); assert.equal(row.state, 'failed'); w.f.lifetime = 800;
  await assert.rejects(reissue(w, row.id), (e) => e.code === 'not_supported_in_v1');
  assert.deepEqual([(await rowOf(w, row.id)).state, w.f.total(A)], ['failed', 0]);
  for (let i = 0; i < 6; i++) { w.clock.t += DAY; await tier(w, 80); await retryQueued(w.ctx, w.company); } assert.equal(w.f.total(A), 0, 'the clock never pays a group with a failed row');
});

test('U4 the old row is never closed without the new one: no season, no budget, and a budget that disappears between the check and the batch', async () => {
  const w = await mworld({ lifetime: 0 });
  const old = await evReward(w); w.f.lifetime = 800;
  await w.db.run('UPDATE season SET budget = 10 WHERE company_id = ?', w.company.id);
  await assert.rejects(reissue(w, old.id), (e) => e.code === 'reissue_not_payable');
  await w.db.run("UPDATE season SET budget = 1000000, status = 'closed' WHERE company_id = ?", w.company.id);
  await assert.rejects(reissue(w, old.id), (e) => e.code === 'reissue_not_payable');
  await w.db.run("UPDATE season SET status = 'published' WHERE company_id = ?", w.company.id);
  // the budget is gone just before the batch runs (a race): the close carries the same guard, so nothing is closed
  const ob = w.db.batch.bind(w.db);
  w.db.batch = async (stmts) => { if (stmts.some((x) => String(x?.[0] ?? x).includes("last_error = 'reissued'"))) await w.db.run("INSERT INTO reward (id, company_id, person_id, kind, idem_key, amount, state, created_at, season_id, sent_amount) SELECT 'rw_eat', ?, ?, 'event', 'eat', budget, 'sent', 1, id, budget FROM season WHERE company_id = ?", w.company.id, w.people.b.id, w.company.id); return ob(stmts); };
  await assert.rejects(reissue(w, old.id), (e) => e.code === 'reissue_not_payable');
  w.db.batch = ob;
  assert.deepEqual([(await rowOf(w, old.id)).state, (await news(w)).length, w.f.total(A)], ['failed', 0, 0]);
});

test('U5 what needs an admin is listed (events with a re-issue, period groups read only, system voids included); erased people are not; the overview counts it and says what to do', async () => {
  const w = await bworld(0);
  const ev = await evReward(w); assert.equal(ev.state, 'failed');
  await grant(w.ctx, w.company, { person: w.people.a, kind: 'tier', amount: 40, idem: 'u5t', groupKey: 'tier:g5', periodKey: 'W1', at: w.clock.t });
  await w.db.run("INSERT INTO reward (id, company_id, person_id, kind, group_key, idem_key, amount, state, last_error, reversed, created_at, sent_amount) VALUES ('rw_v5', ?, ?, 'streak', 'streak:g5', 'u5s', 25, 'void', 'no_season', 1, 5, 25)", w.company.id, w.people.b.id);
  await w.db.run("INSERT INTO reward (id, company_id, person_id, kind, group_key, idem_key, amount, state, last_error, reversed, created_at, sent_amount) VALUES ('rw_v6', ?, ?, 'streak', 'streak:g6', 'u5u', 25, 'void', 'no_season', 1, 5, 25)", w.company.id, w.people.c.id);
  await w.db.run("INSERT INTO reward (id, company_id, person_id, kind, group_key, idem_key, amount, state, created_at, sent_amount) VALUES ('rw_c6', ?, ?, 'streak', 'streak:g6', 'u5c', 25, 'sent', 6, 25)", w.company.id, w.people.c.id); // covered by another row: not listed
  const d = (await w.call('admin', 'GET', '/api/admin/needs-admin')).json;
  assert.deepEqual(d.events.map((x) => x.id), [ev.id]);
  assert.deepEqual(d.groups.map((x) => x.kind).sort(), ['streak', 'tier']);
  const ov = (await w.call('admin', 'GET', '/api/admin/overview')).json;
  assert.equal(ov.needs_admin, 3); assert.ok(ov.alerts.some((a) => /need an admin/.test(a) && /Moneypenny ledger/.test(a) && /NEW grant/.test(a)));
  await w.db.run('UPDATE app_user SET erased_at = 1 WHERE id = ?', w.people.a.id);
  assert.equal((await needsAdmin(w.ctx, w.company)).events.length, 0);
  assert.equal((await w.call('admin', 'GET', '/api/admin/needs-admin')).status, 200);
});

test('U6 erasing a person scrubs the account and every note on their reward rows (amounts, states and the maybe_landed marker stay); a reseal brings nothing back', async () => {
  const w = await mworld({ lifetime: 0 });
  w.f.down = true; const q = await evReward(w, 60, 'b'); w.f.down = false; assert.equal(q.state, 'queued');
  const acct = JSON.parse((await rowOf(w, q.id)).note).acct; assert.ok(acct, 'the account was sealed with the attempt');
  await w.db.run("UPDATE reward SET note = json_set(note, '$.ledger_note', 'secret ledger words', '$.note', 'admin said so') WHERE id = ?", q.id);
  await w.db.run("UPDATE app_user SET status = 'left', left_at = ? WHERE id = ?", w.clock.t - 400 * DAY, w.people.b.id);
  await eraseLeaver(w.ctx, w.company, w.admin, w.people.b.id);
  const r = await rowOf(w, q.id), nt = JSON.parse(r.note);
  assert.equal(r.amount, 60); assert.ok(!r.note.includes('secret') && !r.note.includes('admin said') && !nt.acct && !nt.ledger_note && !nt.note, r.note); assert.equal(nt.maybe_landed, true);
  await resealAll(w.ctx);
  assert.ok(!JSON.parse((await rowOf(w, q.id)).note).acct, 'nothing resurrected');
  await retryQueued(w.ctx, w.company); assert.deepEqual([(await rowOf(w, q.id)).state, (await rowOf(w, q.id)).last_error], ['void', 'voided_erased']);
});

test('U7 the note must be a real string of 10 characters, a new grant above 500 is refused, and the round-20 remedies are gone (routes, table)', async () => {
  const w = await bworld(0);
  const ev = await evReward(w); w.f.lifetime = 800;
  const post = (p, b) => w.call('admin', 'POST', p, b);
  assert.equal((await post('/api/admin/reissue', { id: ev.id, confirm: true, note: ['a ledger note that is long'] })).status, 400);
  assert.equal((await post('/api/admin/reissue', { id: ev.id, confirm: true, note: { length: 99 } })).status, 400);
  assert.equal((await post('/api/admin/reissue', { id: ev.id, note: NOTE })).status, 400, 'confirm is required');
  await w.db.run("INSERT INTO reward (id, company_id, person_id, kind, group_key, idem_key, amount, event_id, state, last_error, created_at, sent_amount) SELECT 'rw_big', company_id, person_id, kind, group_key, 'bigkey', 700, event_id, 'failed', 'cap_reached', 9, 700 FROM reward WHERE id = ?", ev.id);
  assert.equal((await post('/api/admin/reissue', { id: 'rw_big', confirm: true, note: NOTE })).status, 400);
  assert.equal((await post('/api/admin/reissue-gap', { confirm: true })).status, 404);
  assert.equal((await post('/api/admin/mark-received', { confirm: true })).status, 404);
  assert.ok(!(await w.db.first("SELECT name FROM sqlite_master WHERE name = 'period_block'")));
  const ok = await post('/api/admin/reissue', { id: ev.id, confirm: true, note: NOTE }); assert.equal(ok.status, 200, JSON.stringify(ok.json));
});
