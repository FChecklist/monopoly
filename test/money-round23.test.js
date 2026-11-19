// Round-23: a partly granted PERIOD row stays listed (delivered, not amount, is what counts) through repeated settles, the lists are paged and the overview only counts,
// events of a reversed event are not listed, a voided event is listed for 30 days from the VOID, the re-issue amount must be a whole number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitEvent } from '../src/events.js';
import { retryQueued, reissueReward, needsAdmin } from '../src/rewards.js';
import { settleEntitlement } from '../src/periods.js';
import * as setup from '../src/setup.js';
import { fakeMnp } from './mnpfake.js';
import { boot } from './webhelp.js';
import { MoneypennyProvider } from '../src/provider/moneypenny.js';

const DAY = 86400_000, A = 'a@acme.test', NOTE = 'ledger checked 14 Nov, credit not there', SYSTEM = { id: 'api', role: 'system' };
let n = 0;
async function bworld(lifetime) {
  const w = await boot({ settings: { daily_event_limit: 1000, cap_event: 500, cap_person_month: 1e6, cap_person_season: 1e6, cap_period_bonus_person_period: 1e6 } });
  const f = fakeMnp({ lifetime, now: () => w.clock.t });
  w.ctx.provider = () => new MoneypennyProvider({ baseUrl: 'https://mnp.test', keyId: 'k', secret: 's'.repeat(32) }, { fetchImpl: f.fetchImpl });
  w.ctx.env = { ...w.ctx.env, FUTURE_OPS: undefined }; w.f = f;
  await w.db.run("UPDATE company SET provider = 'moneypenny' WHERE id = ?", w.company.id); await w.reload();
  await w.login('admin'); return w;
}
async function evReward(w, credits = 80, person = 'a') {
  if (!w.cardDone) { await setup.addRateCard(w.ctx, w.company, w.admin, { active_from: 1, event_type: 'lead', stage: 'converted', stage_no: 3, credits, cap_month: 0, state_needed: 'system' }); w.cardDone = true; }
  const e = await submitEvent(w.ctx, w.company, SYSTEM, { source: 'api', event_type: 'lead', stage: 'converted', ext_id: 'r23-' + (++n), person_id: w.people[person].id, occurred_at: w.clock.t });
  return w.db.first('SELECT * FROM reward WHERE event_id = ?', e.id);
}
const settle = (w, kind, e, person = 'a') => settleEntitlement(w.ctx, w.company, { person: w.people[person], kind, groupKey: kind + ':t1:W1', periodKey: 'W1', entitled: e, at: w.clock.t, label: 'x' });
const overview = async (w) => { await w.login('admin'); return (await w.call('admin', 'GET', '/api/admin/overview')).json; };

for (const kind of ['tier', 'team']) {
  test(`W1 ${kind}: entitled 60, the provider granted 12: listed with 48 owed through repeated settles and ticks, never topped up, counted and alerted; a late raise keeps it listed`, async () => {
    const w = await bworld(12);
    const o = await settle(w, kind, 60); assert.equal(w.f.total(A), 12);
    const row = await w.db.first('SELECT * FROM reward WHERE kind = ?', kind); assert.deepEqual([row.state, row.last_error, row.sent_amount], ['sent', 'partial_grant', 12]);
    w.f.lifetime = 800;
    for (let i = 0; i < 5; i++) { w.clock.t += DAY; await settle(w, kind, 60); await retryQueued(w.ctx, w.company); }
    const d = await needsAdmin(w.ctx, w.company);
    assert.equal(d.groups.length, 1); assert.equal(d.groups[0].missing, 48); assert.equal(d.groups[0].owed, 48);
    assert.equal(w.f.total(A), 12, 'no top-up, no double pay');
    const ov = await overview(w); assert.equal(ov.needs_admin, 1); assert.ok(ov.alerts.some((a) => /granted only in part/.test(a)), JSON.stringify(ov.alerts));
    await settle(w, kind, 80); assert.equal((await needsAdmin(w.ctx, w.company)).groups[0].owed, 68, 'late raise: owed = entitled - delivered');
    assert.equal(w.f.total(A), 12); assert.ok(o);
  });
}

test('W2 a group leaves the list only when what was delivered covers the entitlement (the entitlement fell back to it)', async () => {
  const w = await bworld(12);
  await settle(w, 'tier', 60); assert.equal((await needsAdmin(w.ctx, w.company)).groups.length, 1);
  await settle(w, 'tier', 30); assert.equal((await needsAdmin(w.ctx, w.company)).groups[0].owed, 18);
  await settle(w, 'tier', 12);
  assert.equal((await needsAdmin(w.ctx, w.company)).groups.length, 0); assert.equal(w.f.total(A), 12);
});

test('W3 failed or partial event rows of an event being reversed or reversed are not listed (the overview can reach 0)', async () => {
  const w = await bworld(0);
  const old = await evReward(w); assert.equal(old.state, 'failed'); assert.equal((await needsAdmin(w.ctx, w.company)).total, 1);
  await w.db.run("UPDATE event SET status = 'reversal_pending' WHERE id = ?", old.event_id);
  assert.equal((await needsAdmin(w.ctx, w.company)).total, 0); assert.equal((await overview(w)).needs_admin, 0);
});

test('W4 a voided event reward is listed for 30 days from the VOID, not from its creation', async () => {
  const w = await bworld(0);
  const ev = await evReward(w); const base = "INSERT INTO reward (id, company_id, person_id, kind, idem_key, amount, state, last_error, reversed, created_at, sent_amount, event_id, note) VALUES (?, ?, ?, 'lead', ?, 7, 'void', 'no_season', 1, ?, 7, ?, ?)";
  await w.db.run(base, 'rw_old_create', w.company.id, w.people.b.id, 'k1', w.clock.t - 90 * DAY, ev.event_id, JSON.stringify({ voided_at: w.clock.t - DAY }));
  await w.db.run(base, 'rw_old_void', w.company.id, w.people.c.id, 'k2', w.clock.t - DAY, ev.event_id, JSON.stringify({ voided_at: w.clock.t - 40 * DAY }));
  assert.deepEqual((await needsAdmin(w.ctx, w.company)).events_voided.map((x) => x.id), ['rw_old_create']);
});

test('W5 the re-issue amount must be a whole number of credits: strings, 1e21, 2.5 and NaN are 400 bad_amount', async () => {
  const w = await bworld(0);
  const old = await evReward(w); w.f.lifetime = 800;
  for (const amount of ['10', 1e21, 2.5, NaN, true, {}]) await assert.rejects(reissueReward(w.ctx, w.company, 'admin', { id: old.id, confirm: true, note: NOTE, amount }), (e) => e.code === 'bad_amount', String(amount));
  assert.equal((await w.db.first("SELECT state FROM reward WHERE id = ?", old.id)).state, 'failed'); assert.equal(w.f.total(A), 0);
});

test('W6 the overview only counts; the list is paged with the real total; the index exists', async () => {
  const w = await bworld(0);
  const old = await evReward(w);
  for (let i = 0; i < 250; i++) await w.db.run("INSERT INTO reward (id, company_id, person_id, kind, idem_key, amount, state, last_error, reversed, created_at, sent_amount, event_id) VALUES (?, ?, ?, 'lead', ?, 5, 'failed', 'cap_reached', 0, ?, 0, ?)", 'rw_p' + i, w.company.id, w.people.b.id, 'p' + i, w.clock.t + i, old.event_id);
  const ov = await overview(w); assert.equal(ov.needs_admin, 251); assert.ok(!('events' in ov) && !('needs_admin_rows' in ov));
  const page1 = (await w.call('admin', 'GET', '/api/admin/needs-admin')).json;
  assert.equal(page1.events.length, 200); assert.equal(page1.total, 251); assert.equal(page1.totals.events, 251);
  const page2 = (await w.call('admin', 'GET', '/api/admin/needs-admin?limit=100&offset=200')).json;
  assert.equal(page2.events.length, 51); assert.equal(page2.offset, 200);
  assert.ok(await w.db.first("SELECT 1 x FROM sqlite_master WHERE type = 'index' AND name = 'rw_company_state'"));
});
