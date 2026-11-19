// Round-22: a period group is listed for as long as the settle is blocked on it (one predicate for both), a chain of re-issues of one event reward works twice and three times,
// the lists have real totals, erase closes a partly granted row without touching its amounts, a closed event cannot be re-issued, the demo-only gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitEvent } from '../src/events.js';
import { retryQueued, reissueReward, needsAdmin, grant } from '../src/rewards.js';
import { settleEntitlement } from '../src/periods.js';
import { eraseLeaver } from '../src/people.js';
import { futureOn, shopOn, buyOn } from '../src/v1.js';
import * as setup from '../src/setup.js';
import { fakeMnp, mworld } from './mnpfake.js';
import { boot } from './webhelp.js';
import { MoneypennyProvider } from '../src/provider/moneypenny.js';

const DAY = 86400_000, A = 'a@acme.test', NOTE = 'ledger checked 14 Nov, credit not there', SYSTEM = { id: 'api', role: 'system' };
let n = 0;
async function evReward(w, credits = 80, person = 'a') {
  if (!w.cardDone) { await setup.addRateCard(w.ctx, w.company, w.admin, { active_from: 1, event_type: 'lead', stage: 'converted', stage_no: 3, credits, cap_month: 0, state_needed: 'system' }); w.cardDone = true; }
  const e = await submitEvent(w.ctx, w.company, SYSTEM, { source: 'api', event_type: 'lead', stage: 'converted', ext_id: 'r22-' + (++n), person_id: w.people[person].id, occurred_at: w.clock.t });
  return w.db.first('SELECT * FROM reward WHERE event_id = ?', e.id);
}
const rowOf = (w, id) => w.db.first('SELECT * FROM reward WHERE id = ?', id);
const tier = (w, e, person = 'a') => settleEntitlement(w.ctx, w.company, { person: w.people[person], kind: 'tier', groupKey: 'tier:t1:W1', periodKey: 'W1', entitled: e, at: w.clock.t, label: 'x' });
const reissue = (w, id, o = {}) => reissueReward(w.ctx, w.company, 'admin', { id, confirm: true, note: NOTE, ...o });
async function bworld(lifetime) { // an HTTP world with the real adapter against the fake
  const w = await boot({ settings: { daily_event_limit: 1000, cap_event: 500, cap_person_month: 1e6, cap_person_season: 1e6, cap_period_bonus_person_period: 1e6 } });
  const f = fakeMnp({ lifetime, now: () => w.clock.t });
  w.ctx.provider = () => new MoneypennyProvider({ baseUrl: 'https://mnp.test', keyId: 'k', secret: 's'.repeat(32) }, { fetchImpl: f.fetchImpl });
  w.ctx.env = { ...w.ctx.env, FUTURE_OPS: undefined }; w.f = f;
  await w.db.run("UPDATE company SET provider = 'moneypenny' WHERE id = ?", w.company.id); await w.reload();
  await w.login('admin'); return w;
}
const chain = (w) => w.db.all("SELECT * FROM reward WHERE idem_key LIKE '%:re%' ORDER BY created_at, rowid");

test('V1 tier 100 sent, a late event raises the entitlement to 150, the top-up row fails: the group is listed and counted; the settle never pays it; it leaves the list when nothing is owed', async () => {
  const w = await bworld(800);
  await tier(w, 100); assert.equal(w.f.total(A), 100);
  w.f.lifetime = 100; await tier(w, 150);
  const top = await w.db.first("SELECT * FROM reward WHERE kind = 'tier' AND amount = 50"); assert.equal(top.state, 'failed');
  let d = await needsAdmin(w.ctx, w.company);
  assert.equal(d.groups.length, 1, 'other rows cover 100 of the group, but the settle is blocked: it must be listed'); assert.equal(d.total, 1);
  w.f.lifetime = 800;
  for (let i = 0; i < 4; i++) { w.clock.t += DAY; const o = await tier(w, 150); assert.equal(o.blocked, 'needs_admin'); await retryQueued(w.ctx, w.company); }
  assert.equal(w.f.total(A), 100, 'never paid by itself');
  assert.equal((await needsAdmin(w.ctx, w.company)).groups.length, 1);
  await w.login('admin'); { const o = await w.call('admin', 'GET', '/api/admin/overview'); assert.equal(o.json.needs_admin, 1, o.status + JSON.stringify(o.json).slice(0, 300)); }
  await tier(w, 100); // the entitlement fell back to what was paid: nothing is owed any more
  d = await needsAdmin(w.ctx, w.company); assert.equal(d.groups.length, 0); assert.equal(d.total, 0);
});

test('V2 a top-up row the SYSTEM voided (no season) blocks the settle and is listed; a later live row that replaces it unlists the group', async () => {
  const w = await mworld({ lifetime: 800 });
  await tier(w, 100);
  await w.db.run("INSERT INTO reward (id, company_id, person_id, kind, group_key, idem_key, amount, state, last_error, reversed, created_at, sent_amount) VALUES ('rw_v22', ?, ?, 'tier', 'tier:t1:W1', 'v22', 50, 'void', 'season_closed', 1, ?, 50)", w.company.id, w.people.a.id, w.clock.t + 10);
  w.clock.t += 20;
  const o = await tier(w, 150); assert.equal(o.blocked, 'needs_admin'); assert.equal(w.f.total(A), 100);
  assert.equal((await needsAdmin(w.ctx, w.company)).groups.length, 1);
  await w.db.run("INSERT INTO reward (id, company_id, person_id, kind, group_key, idem_key, amount, state, reversed, created_at, sent_amount) VALUES ('rw_l22', ?, ?, 'tier', 'tier:t1:W1', 'l22', 50, 'sent', 0, ?, 50)", w.company.id, w.people.a.id, w.clock.t + 1);
  w.clock.t += 5; await tier(w, 150);
  assert.equal((await needsAdmin(w.ctx, w.company)).groups.length, 0, 'replaced by a live row and nothing owed');
});

test('V3 re-issuing a failed re-issue works twice and three times (the closed_partial sibling of the chain is not "other rewards")', async () => {
  const w = await mworld({ lifetime: 28 });
  const old = await evReward(w, 40); assert.deepEqual([old.state, old.sent_amount, old.last_error], ['sent', 28, 'partial_grant']);
  const a = await reissue(w, old.id); assert.equal(a.state, 'failed', 'the cap is still there: the 12 fails');
  const b = await reissue(w, a.new_reward); assert.equal(b.state, 'failed');
  w.f.lifetime = 800;
  const c = await reissue(w, b.new_reward); assert.equal(c.state, 'sent');
  assert.equal(w.f.total(A), 40, 'exactly the 40 of the event, once');
  assert.equal((await chain(w)).length, 3);
  for (let i = 0; i < 4; i++) { w.clock.t += DAY; await retryQueued(w.ctx, w.company); } assert.equal(w.f.total(A), 40);
});

test('V4 a partial re-issue at the exact edge of the season budget works (the close counts what it frees); with 1 credit less budget nothing changes', async () => {
  const w = await mworld({ lifetime: 28 });
  const old = await evReward(w, 40); assert.equal(old.last_error, 'partial_grant'); w.f.lifetime = 800;
  const funded = (await w.db.first("SELECT COALESCE(SUM(amount),0) s FROM reward WHERE company_id = ? AND season_id IS NOT NULL AND amount > 0 AND state IN ('queued','sent')", w.company.id)).s;
  await w.db.run('UPDATE season SET budget = ? WHERE company_id = ?', funded - 1, w.company.id);
  await assert.rejects(reissue(w, old.id), (e) => e.code === 'reissue_not_payable');
  assert.deepEqual([(await rowOf(w, old.id)).last_error, w.f.total(A)], ['partial_grant', 28]);
  await w.db.run('UPDATE season SET budget = ? WHERE company_id = ?', funded, w.company.id);
  const r = await reissue(w, old.id); assert.equal(r.state, 'sent'); assert.equal(w.f.total(A), 40);
});

test('V5 an event that is being reversed or was reversed cannot be re-issued (409 event_closed), the old row is untouched', async () => {
  for (const status of ['reversal_pending', 'reversed']) {
    const w = await mworld({ lifetime: 0 });
    const old = await evReward(w); assert.equal(old.state, 'failed'); w.f.lifetime = 800;
    await w.db.run('UPDATE event SET status = ? WHERE id = ?', status, old.event_id);
    await assert.rejects(reissue(w, old.id), (e) => e.code === 'event_closed');
    assert.deepEqual([(await rowOf(w, old.id)).state, w.f.total(A), (await chain(w)).length], ['failed', 0, 0]);
  }
});

test('V6 the lists have no limit and the overview counts the real total, voided events included (read only)', async () => {
  const w = await bworld(0);
  const old = await evReward(w);
  for (let i = 0; i < 130; i++) await w.db.run("INSERT INTO reward (id, company_id, person_id, kind, idem_key, amount, state, last_error, reversed, created_at, sent_amount, event_id) VALUES (?, ?, ?, 'lead', ?, 5, 'failed', 'cap_reached', 0, ?, 0, ?)", 'rw_m' + i, w.company.id, w.people.b.id, 'm' + i, w.clock.t + i, old.event_id);
  await w.db.run("INSERT INTO reward (id, company_id, person_id, kind, idem_key, amount, state, last_error, reversed, created_at, sent_amount, event_id) VALUES ('rw_ve', ?, ?, 'lead', 've', 7, 'void', 'no_season', 1, ?, 7, ?)", w.company.id, w.people.c.id, w.clock.t, old.event_id);
  await w.db.run("INSERT INTO reward (id, company_id, person_id, kind, idem_key, amount, state, last_error, reversed, created_at, sent_amount, event_id) VALUES ('rw_vo', ?, ?, 'lead', 'vo', 7, 'void', 'no_season', 1, ?, 7, ?)", w.company.id, w.people.c.id, w.clock.t - 40 * DAY, old.event_id);
  const d = await needsAdmin(w.ctx, w.company);
  assert.equal(d.events.length, 131); assert.deepEqual(d.events_voided.map((x) => x.id), ['rw_ve'], 'only the last 30 days'); assert.equal(d.total, 132);
  const ov = (await w.call('admin', 'GET', '/api/admin/overview')).json;
  assert.equal(ov.needs_admin, 132); assert.equal(ov.rewards_voided_silent, 0, 'voided events are listed, not silent; the old one is outside the window');
  assert.equal((await w.call('admin', 'GET', '/api/admin/needs-admin')).json.events.length, 131);
});

test('V7 erasing a person closes a partly granted row (amounts, state and the maybe_landed marker stay), scrubs every note, and a re-issue refuses', async () => {
  const w = await mworld({ lifetime: 30 });
  const old = await evReward(w, 80); assert.deepEqual([old.state, old.sent_amount, old.last_error], ['sent', 30, 'partial_grant']);
  await w.db.run("UPDATE reward SET note = json_set(note, '$.ledger_note', 'secret ledger words', '$.note', 'admin said so') WHERE id = ?", old.id);
  await w.db.run("UPDATE app_user SET status = 'left', left_at = ? WHERE id = ?", w.clock.t - 400 * DAY, w.people.a.id);
  await eraseLeaver(w.ctx, w.company, w.admin, w.people.a.id);
  await retryQueued(w.ctx, w.company);
  const r = await rowOf(w, old.id), nt = JSON.parse(r.note);
  assert.deepEqual([r.state, r.amount, r.sent_amount, r.last_error], ['sent', 80, 30, 'voided_erased']);
  assert.ok(nt.maybe_landed === true && !nt.acct && !nt.ledger_note && !nt.note && !r.note.includes('secret'), r.note);
  await assert.rejects(reissue(w, old.id), (e) => e.code === 'not_reissuable' || e.code === 'person_erased');
  assert.equal((await needsAdmin(w.ctx, w.company)).events.length, 0);
});

test('V8 the unconfirmed-duplicate alert says: check the ledger, record it by hand if it landed, re-issue only if it did not; a failed period bonus has its own alert', async () => {
  const w = await bworld(800);
  await w.db.run("INSERT INTO reward (id, company_id, person_id, kind, idem_key, amount, state, last_error, reversed, created_at, sent_amount) VALUES ('rw_du', ?, ?, 'lead', 'du', 9, 'failed', 'duplicate_unconfirmed', 0, ?, 0)", w.company.id, w.people.a.id, w.clock.t);
  await w.db.run("INSERT INTO reward (id, company_id, person_id, kind, group_key, idem_key, amount, state, last_error, reversed, created_at, sent_amount) VALUES ('rw_fp', ?, ?, 'tier', 'tier:t1:W1', 'fp', 9, 'failed', 'cap_reached', 0, ?, 0)", w.company.id, w.people.b.id, w.clock.t);
  const ov = (await w.call('admin', 'GET', '/api/admin/overview')).json;
  assert.ok(ov.alerts.some((a) => /ledger/.test(a) && /by hand/.test(a) && /did NOT land/.test(a)), JSON.stringify(ov.alerts));
  assert.ok(ov.alerts.some((a) => /period bonus/.test(a) && /blocked/.test(a)));
});

test('V9 shop and buy need the demo provider: a non-live Moneypenny company with FUTURE_OPS=1 cannot reach them', () => {
  const env = { FUTURE_OPS: '1' };
  assert.equal(futureOn(env, { live: 0, provider: 'stub' }), true);
  assert.equal(futureOn(env, { live: 0, provider: 'moneypenny' }), false);
  assert.equal(shopOn(env, { live: 0, provider: 'moneypenny' }), false); assert.equal(buyOn(env, { live: 0, provider: 'moneypenny' }), false);
  assert.equal(futureOn(env, { live: 1, provider: 'stub' }), false); assert.equal(futureOn({}, { live: 0, provider: 'stub' }), false);
});
