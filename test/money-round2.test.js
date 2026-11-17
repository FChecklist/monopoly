// Round-2 money findings: each test pins one failure that the round-2 audit found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { world, exampleCard, SYSTEM, T0 } from './helpers.js';
import { openDb, migrate } from '../src/db.js';
import { submitEvent } from '../src/events.js';
import { settleCompany, settleEntitlement } from '../src/periods.js';
import { grant, releaseWaiting, reverseReward, capOf } from '../src/rewards.js';
import { commit, verifyChain } from '../src/audit.js';
import { StubProvider } from '../src/provider/stub.js';
import { proposePenalty, approvePenalty, tickPenalties } from '../src/penalty.js';
import { updateSettings } from '../src/people.js';
import * as setup from '../src/setup.js';

const DAY = 86400_000;
const open = (w, cid, amount, recovered = 0) => w.db.run("INSERT INTO correction (id, company_id, person_id, amount, recovered, state, reason, created_at) VALUES (?,?,?,?,?,'open','t',?)", cid, w.company.id, w.people.a.id, amount, recovered, w.clock.t);
const corr = (w) => w.db.all('SELECT id, amount, recovered, state FROM correction ORDER BY id');
const auditCount = (w, action) => w.db.first('SELECT COUNT(*) n FROM audit WHERE company_id=? AND action=?', w.company.id, action).then((r) => r.n);

async function waitingWorld(corrections) {
  const w = await world({ budget: 50 });
  for (const [id, amt] of corrections) await open(w, id, amt);
  const g = await grant(w.ctx, w.company, { person: w.people.a, kind: 'event', amount: 100, idem: 'wait:1', groupKey: 'g', at: w.clock.t, actor: 'system' });
  assert.ok(g.waiting, 'over budget: waits');
  await setup.raiseBudget(w.ctx, w.company, w.admin, w.season, 1000);
  await w.reload();
  return w;
}

test('M1: release with one pending correction takes it once and queues the reward smaller', async () => {
  const w = await waitingWorld([['cr1', 10]]);
  const r = await releaseWaiting(w.ctx, w.company);
  assert.equal(r.moved, 1);
  const rw = await w.db.first("SELECT state, sent_amount FROM reward WHERE idem_key='wait:1'");
  assert.equal(rw.state, 'sent'); assert.equal(rw.sent_amount, 90);
  assert.deepEqual({ ...(await corr(w))[0] }, { id: 'cr1', amount: 10, recovered: 10, state: 'cleared' });
  assert.equal((await verifyChain(w.db, w.company.id)).ok, true);
});

test('M1: release with two corrections applies both takes together', async () => {
  const w = await waitingWorld([['cr1', 10], ['cr2', 7]]);
  assert.equal((await releaseWaiting(w.ctx, w.company)).moved, 1);
  assert.equal((await w.db.first("SELECT sent_amount s FROM reward WHERE idem_key='wait:1'")).s, 83);
  assert.deepEqual((await corr(w)).map((c) => [c.recovered, c.state]), [[10, 'cleared'], [7, 'cleared']]);
});

test('M1: releases at once take the correction once and leave one audit line', async () => {
  const w = await waitingWorld([['cr1', 10]]);
  await Promise.all([releaseWaiting(w.ctx, w.company), releaseWaiting(w.ctx, w.company), releaseWaiting(w.ctx, w.company)]);
  assert.equal((await corr(w))[0].recovered, 10);
  assert.equal((await w.db.first("SELECT sent_amount s FROM reward WHERE idem_key='wait:1'")).s, 90);
  assert.equal(await auditCount(w, 'reward.release'), 1, 'only the winner leaves a line');
  assert.equal((await verifyChain(w.db, w.company.id)).ok, true);
});

test('M1: a take that no longer fits stops the release and does not eat the correction', async () => {
  const w = await waitingWorld([['cr1', 10]]);
  // the correction is used up by somebody else after it was read and before the write: the guard fails, nothing is consumed
  const orig = w.db.all.bind(w.db);
  let done = false;
  w.db.all = async (sql, ...p) => { const r = await orig(sql, ...p); if (!done && /FROM correction WHERE company_id/.test(sql)) { done = true; await w.db.run("UPDATE correction SET recovered = 10, state='cleared'"); } return r; };
  const r = await releaseWaiting(w.ctx, w.company);
  w.db.all = orig;
  assert.equal(r.moved, 0);
  assert.equal((await corr(w))[0].recovered, 10, 'not taken twice');
  assert.equal((await w.db.first("SELECT state FROM reward WHERE idem_key='wait:1'")).state, 'waiting');
  assert.equal(await auditCount(w, 'reward.release'), 0);
});

test('M2: writers that lose a guard leave no audit line and the chain stays whole', async () => {
  const w = await world({ budget: 100, settings: { cap_person_month: 100, cap_person_season: 100 } });
  await Promise.all(Array.from({ length: 20 }, (_, i) => grant(w.ctx, w.company, { person: w.people.a, kind: 'event', amount: 30, idem: 'race:' + i, groupKey: 'g', at: w.clock.t, actor: 'system' })));
  const rows = (await w.db.first("SELECT COUNT(*) n FROM reward WHERE kind='event'")).n;
  assert.equal(await auditCount(w, 'reward.create'), rows, 'one line per stored reward, no junk lines');
  assert.equal((await verifyChain(w.db, w.company.id)).ok, true);
});

test('M2: onlyIf skips the line without using an audit number', async () => {
  const w = await world();
  const max = async () => (await w.db.first('SELECT MAX(n) m FROM audit WHERE company_id=?', w.company.id)).m;
  const before = await max();
  await commit(w.ctx, w.company.id, 'sys', 'x.lost', { a: 1 }, [], { onlyIf: { sql: 'SELECT 1 FROM company WHERE id = ?', params: ['nope'] } });
  assert.equal(await max(), before);
  await commit(w.ctx, w.company.id, 'sys', 'x.won', { a: 1 }, [], { onlyIf: { sql: 'SELECT 1 FROM company WHERE id = ?', params: [w.company.id] } });
  assert.equal(await max(), before + 1);
  assert.equal((await verifyChain(w.db, w.company.id)).ok, true);
});

test('M2: voiding a waiting reward that somebody else already voided leaves no line', async () => {
  const w = await world();
  const early = T0 - 120 * DAY;
  await grant(w.ctx, w.company, { person: w.people.a, kind: 'tier', amount: 60, idem: 'tier:nos', groupKey: 'tier:t:p', periodKey: 'P1', at: early, periodBonus: true, actor: 'system' });
  const stale = await w.db.first("SELECT * FROM reward WHERE idem_key='tier:nos'");
  assert.equal((await reverseReward(w.ctx, w.company, stale, { reason: 'a' })).voided, true);
  const n = await auditCount(w, 'reward.void');
  await reverseReward(w.ctx, w.company, stale, { reason: 'b' }); // stale copy: the row is already void
  assert.equal(await auditCount(w, 'reward.void'), n);
  assert.equal((await verifyChain(w.db, w.company.id)).ok, true);
});

test('M3: a forced settle inside the late-event window does not freeze a low team share', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  await exampleCard(w);
  const { ctx, company, admin } = w, a = w.people.a;
  await setup.addTarget(ctx, company, admin, { name: 'Team games', scope: 'team', period: 'month', event_type: 'game', stage: 'completed', tiers: [{ count: 2, bonus: 1000 }] });
  const ev = (ext) => submitEvent(ctx, company, SYSTEM, { person_id: a.id, event_type: 'game', stage: 'completed', ext_id: ext, source: 'api', occurred_at: T0 });
  await ev('e1');
  w.clock.t = Date.parse('2026-12-03T10:00:00+05:30'); // November ended, the 7 day window has not
  await settleCompany(ctx, company, w.clock.t, { force: true });
  await ev('e2'); // a late event inside the window
  await settleCompany(ctx, company, w.clock.t, { force: true });
  const sum = () => w.db.first("SELECT COALESCE(SUM(amount),0) s FROM reward WHERE kind='team' AND state IN ('queued','sent')").then((r) => r.s);
  assert.ok((await sum()) > 0, 'the late event counts: the share was not frozen at 0');
  assert.equal((await w.db.first('SELECT entitled FROM team_period_member WHERE person_id=?', a.id)).entitled, null, 'not frozen yet');
  w.clock.t += 10 * DAY;
  await settleCompany(ctx, company, w.clock.t);
  assert.ok((await w.db.first('SELECT entitled FROM team_period_member WHERE person_id=?', a.id)).entitled > 0, 'frozen once the window is over');
});

test('M4: waiting rows that can never be released are voided after the late window and never paid twice', async () => {
  const w = await world();
  const { ctx, company } = w, a = w.people.a;
  const early = T0 - 120 * DAY;
  const key = 'tier:x:P1:t:g0:e60:p0';
  const mk = () => grant(ctx, company, { person: a, kind: 'tier', amount: 60, idem: key, groupKey: 'tier:t:p', periodKey: 'P1', at: early, periodBonus: true, actor: 'system' });
  assert.ok((await mk()).waiting);
  assert.equal((await releaseWaiting(ctx, company)).voided, 1);
  const row = await w.db.first('SELECT state, last_error FROM reward WHERE idem_key=?', key);
  assert.deepEqual({ ...row }, { state: 'void', last_error: 'no_season' });
  assert.equal((await mk()).paid, 0, 'a voided row is not paid by a re-grant');
  // a row whose season is closed
  await w.db.run("INSERT INTO season (id, company_id, name, starts_at, ends_at, budget, mode, status, published_at) VALUES ('se_c',?,?,?,?,?,?,?,?)", company.id, 'C', early - 10 * DAY, early + 20 * DAY, 1000, 'steady', 'closed', early);
  await w.db.run("INSERT INTO reward (id, company_id, person_id, kind, idem_key, amount, month_key, day_key, season_id, state, created_at, sent_amount, note) VALUES ('rw_c',?,?,'tier','c:1',30,'M','D','se_c','waiting',?,30,?)", company.id, a.id, early, JSON.stringify({ at: early }));
  assert.equal((await releaseWaiting(ctx, company)).voided, 1);
  assert.equal((await w.db.first("SELECT last_error FROM reward WHERE id='rw_c'")).last_error, 'season_closed');
});

test('M4: a recent waiting row is left alone (the late window has not ended)', async () => {
  const w = await world();
  await w.db.run('UPDATE season SET starts_at = ?', T0 + 50 * DAY); // nothing covers `at`
  await grant(w.ctx, w.company, { person: w.people.a, kind: 'tier', amount: 60, idem: 'tier:r', groupKey: 'tier:t:p', periodKey: 'P1', at: T0 - 3 * DAY, periodBonus: true, actor: 'system' });
  assert.equal((await releaseWaiting(w.ctx, w.company)).voided, 0);
});

test('M5: a capped tier grant is topped up later instead of replaying the old key', async () => {
  const w = await world({ settings: { cap_period_bonus_person_period: 100 } });
  const { ctx, admin } = w, a = w.people.a;
  const args = { person: a, kind: 'tier', groupKey: 'tier:t1:P1', periodKey: 'P1', entitled: 300, at: T0, label: 't' };
  assert.equal((await settleEntitlement(ctx, w.company, args)).paid, 100, 'capped');
  await updateSettings(ctx, w.company, admin, { cap_period_bonus_person_period: 1000 });
  await w.reload();
  assert.equal((await settleEntitlement(ctx, w.company, args)).paid, 200, 'the rest is topped up');
  assert.equal((await w.db.first("SELECT SUM(amount) s FROM reward WHERE group_key='tier:t1:P1'")).s, 300);
});

test('M5: cap_event 0 is not "no cap"', async () => {
  assert.equal(capOf({ cap_event: 0 }, 'cap_event'), 1000);
  const w = await world({ settings: { daily_event_limit: 1000 } });
  await w.db.run("UPDATE company SET settings = json_set(settings, '$.cap_event', 0)");
  await w.reload();
  await setup.addRateCard(w.ctx, w.company, w.admin, { event_type: 'big', stage: 's', stage_no: 1, credits: 1500, state_needed: 'system', active_from: T0 - 30 * DAY });
  const r = await submitEvent(w.ctx, w.company, SYSTEM, { person_id: w.people.a.id, event_type: 'big', stage: 's', ext_id: 'b1', source: 'api', occurred_at: T0 });
  assert.equal(r.ok, true);
  assert.equal((await w.db.first('SELECT SUM(amount) s FROM reward WHERE event_id=?', r.id)).s, 1000);
});

test('M5: a penalty_return never has a correction taken out of it', async () => {
  const w = await world();
  await open(w, 'cr1', 100);
  const g = await grant(w.ctx, w.company, { person: w.people.a, kind: 'penalty_return', amount: 50, idem: 'penrev:x', groupKey: 'penrev', at: w.clock.t, bypassCaps: true, actor: 'system' });
  assert.equal(g.reward.sent_amount, 50);
  assert.equal((await corr(w))[0].recovered, 0);
});

test('M5: a weekly target keeps settling after more than 400 periods', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  await exampleCard(w);
  const { ctx, company, admin } = w, a = w.people.a;
  await setup.addTarget(ctx, company, admin, { name: 'Weekly', scope: 'person', period: 'week', event_type: 'game', stage: 'completed', tiers: [{ count: 1, bonus: 100 }], active_from: T0 - 40 * DAY });
  const ev = (ext, at) => submitEvent(ctx, company, SYSTEM, { person_id: a.id, event_type: 'game', stage: 'completed', ext_id: ext, source: 'api', occurred_at: at });
  await ev('w1', T0);
  await w.db.run('UPDATE season SET ends_at = ?', T0 + 5000 * DAY);
  w.clock.t = T0 + 450 * 7 * DAY;
  const w2 = await ev('w2', w.clock.t - 10 * DAY); assert.equal(w2.ok, true, JSON.stringify(w2));
  await settleCompany(ctx, company, w.clock.t);
  assert.ok((await w.db.first("SELECT COUNT(*) n FROM reward WHERE kind='tier' AND person_id=?", a.id)).n >= 1, 'a recent week is settled');
});

test('M5: a debit whose claim lost the race is handed back', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  class Racy extends StubProvider {
    async debit(a) { const r = await super.debit(a); await w.db.run("UPDATE penalty_case SET state='reversed'"); return r; }
  }
  w.ctx.provider = (c) => new Racy(w.db, c.id, { now: w.ctx.now });
  await exampleCard(w);
  await updateSettings(w.ctx, w.company, w.admin, { penalty_credit_loss: true, penalty_cap_pct: 20 });
  await w.reload();
  for (let i = 0; i < 5; i++) await submitEvent(w.ctx, w.company, SYSTEM, { person_id: w.people.a.id, event_type: 'game', stage: 'completed', ext_id: 'c' + i, source: 'api', occurred_at: w.clock.t });
  const c = await proposePenalty(w.ctx, w.company, w.people.mgr, { person_id: w.people.a.id, effect: 'credits', amount: 1000, reason: 'test' });
  await approvePenalty(w.ctx, w.company, w.people.hr, c.id);
  w.clock.t += 4 * DAY; await tickPenalties(w.ctx, w.company);
  const bal = await w.ctx.provider(w.company).getBalance({ accountRef: 'acct_' + w.people.a.id });
  assert.equal(bal.balance, 200, 'the debit was given back');
});

test('M6: production migrations carry no balance column and no demo tables', () => {
  for (const f of readdirSync('migrations').filter((x) => x.endsWith('.sql'))) {
    const sql = readFileSync('migrations/' + f, 'utf8').replace(/--[^\n]*/g, '');
    assert.doesNotMatch(sql, /\bbalance\b/i, f);
    assert.doesNotMatch(sql, /stub_/i, f);
  }
  const db = openDb(); migrate(db);
  const names = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(!names.some((n) => n.startsWith('stub_')), 'migrate() reads only migrations/');
  assert.match(readFileSync('migrations-dev/0001_stub.sql', 'utf8'), /stub_account/);
});

test('M6: the stub provider creates its own tables from migrations-dev', async () => {
  const db = openDb(); migrate(db);
  const p = new StubProvider(db, 'co1');
  const { account_ref } = await p.ensureAccount({ externalRef: 'u1' });
  assert.equal((await p.credit({ accountRef: account_ref, amount: 5, reasonCode: 'x', idem: 'i' })).balance, 5);
});

test('M7: sending an event again finishes an apply that stopped halfway', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  await exampleCard(w);
  const input = { person_id: w.people.a.id, event_type: 'game', stage: 'completed', ext_id: 'half', source: 'api', occurred_at: T0 };
  const real = w.ctx.provider;
  let down = true;
  w.ctx.provider = (c) => { if (down) throw new Error('provider down'); return real(c); };
  await assert.rejects(submitEvent(w.ctx, w.company, SYSTEM, input), /provider down/);
  const ev = await w.db.first("SELECT id, status FROM event WHERE ext_id='half'");
  assert.equal(ev.status, 'approved');
  down = false;
  const again = await submitEvent(w.ctx, w.company, SYSTEM, input);
  assert.deepEqual({ ok: again.ok, id: again.id, status: again.status, resumed: again.resumed }, { ok: true, id: ev.id, status: 'applied', resumed: true });
  const dup = await submitEvent(w.ctx, w.company, SYSTEM, input);
  assert.equal(dup.ok, false); assert.equal(dup.reason, 'duplicate');
});
