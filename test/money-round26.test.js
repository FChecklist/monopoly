// Round-26 (audit 25A, scale): the clock is bounded. One tick is one worker invocation and a free D1 plan allows about 50 queries, so every stage stops cleanly at a budget, a cursor makes the
// next tick carry on (newest periods first), settled groups cost almost nothing, an unfinished or failed stage is shown (never silent) and never stamps the clock as fully run.
// Also: the drop row is guarded (m1), erase scrubs free text in events/penalties/corrections (m5), idempotency keys are checked, never cut (m6), e-mail changes are counted (m4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './webhelp.js';
import { T0 } from './helpers.js';
import { tick } from '../src/api.js';
import { grant, MAX_IDEM, checkIdemKey } from '../src/rewards.js';
import { settleEntitlement } from '../src/periods.js';
import { addPerson, eraseLeaver, correctDetails } from '../src/people.js';
import { makeBudget, budgetDb, budgetLimit, BudgetReached } from '../src/budget.js';
import * as setup from '../src/setup.js';
import { fakeMnp } from './mnpfake.js';
import { MoneypennyProvider } from '../src/provider/moneypenny.js';

const DAY = 86400_000, BUDGET = 40;
const SETTINGS = { daily_event_limit: 1e6, cap_event: 500, cap_person_month: 1e6, cap_person_season: 1e6, cap_period_bonus_person_period: 1e6 };

async function sworld() {
  const w = await boot({ settings: SETTINGS });
  const f = fakeMnp({ lifetime: 100000, now: () => w.clock.t });
  w.ctx.provider = () => new MoneypennyProvider({ baseUrl: 'https://mnp.test', keyId: 'k', secret: 's'.repeat(32) }, { fetchImpl: f.fetchImpl });
  w.f = f;
  await w.db.run("UPDATE company SET provider = 'moneypenny' WHERE id = ?", w.company.id); await w.reload();
  await w.login('admin');
  return w;
}
/** P people with one completed 'game' event in each of M consecutive months; the clock afterwards is past all of them. */
async function seedScale(w, P, M) {
  await setup.addTarget(w.ctx, w.company, w.admin, { name: 'T', scope: 'person', period: 'month', event_type: 'game', stage: 'completed', tiers: [{ count: 1, bonus: 10 }], active_from: T0 - 30 * DAY });
  await w.db.run('UPDATE season SET ends_at = ? WHERE id = ?', T0 + 500 * DAY, w.season);
  const ids = []; let k = 0;
  for (let i = 0; i < P; i++) { const { user } = await addPerson(w.ctx, w.company, w.admin, { email: `p${i}@acme.test`, name: 'p' + i, role: 'employee', team_id: w.team, joined_at: T0 - 600 * DAY }); ids.push(user.id); }
  for (let m = 0; m < M; m++) for (const id of ids) await w.db.run("INSERT INTO event (id, company_id, person_id, source, event_type, stage, ext_id, occurred_at, value, status, created_at, applied_at) VALUES (?,?,?,?,?,?,?,?,0,'applied',?,?)", 'sev' + (k++), w.company.id, id, 'api', 'game', 'completed', 'x' + k, T0 - 8 * DAY + m * 31 * DAY, T0, T0);
  w.clock.t = T0 - 8 * DAY + (M - 1) * 31 * DAY + 45 * DAY;
  w.ctx.env = { ...w.ctx.env, TICK_QUERY_BUDGET: String(BUDGET) };
  return ids;
}
/** Count what one tick asks of the database (the Moneypenny adapter's calls are fetches: f.calls). */
function counter(w) {
  const c = { n: 0 }, raw = w.ctx.db;
  for (const m of ['first', 'all', 'run', 'batch']) { const f = raw[m].bind(raw); raw[m] = (...a) => { c.n++; return f(...a); }; }
  return c;
}
const ovw = async (w) => { await w.login('admin'); return (await w.call('admin', 'GET', '/api/admin/overview')).json; };
const sentTiers = async (w) => (await w.db.first("SELECT COUNT(*) n FROM reward WHERE kind = 'tier' AND state = 'sent'")).n;

test('Z1 300 groups (25 people x 12 months), budget 40: every tick stays within 40 db+provider calls, no stage throws, the newest periods come first, the backlog reaches 0, nobody is paid twice', async () => {
  const w = await sworld(); await seedScale(w, 25, 12); const c = counter(w);
  const first = {}; let max = 0, ticks = 0, last;
  for (; ticks < 3500; ticks++) {
    c.n = 0; const f0 = w.f.calls.length; const r = await tick(w.ctx, await w.reload()); const q = c.n + (w.f.calls.length - f0); max = Math.max(max, q); w.clock.t += 5 * 60_000;
    for (const [name, v] of Object.entries(r)) assert.ok(!v?.error, name + ' threw: ' + JSON.stringify(v));
    for (const r2 of await w.db.all("SELECT period_key p FROM reward WHERE kind = 'tier' GROUP BY period_key")) if (first[r2.p] === undefined) first[r2.p] = ticks;
    last = await w.db.first('SELECT * FROM tick_state');
    if ((await sentTiers(w)) === 300 && last.backlog === 0 && ticks > 8) break;
  }
  assert.ok(max <= BUDGET, 'a tick used ' + max + ' calls');
  assert.equal(await sentTiers(w), 300, 'all groups paid after ' + ticks + ' ticks'); assert.equal(last.backlog, 0);
  const keys = Object.keys(first).sort(); assert.equal(keys.length, 12);
  assert.ok(first[keys[11]] <= first[keys[5]] && first[keys[5]] <= first[keys[0]] && first[keys[11]] < first[keys[0]], 'newest first: ' + JSON.stringify(first));
  assert.equal(w.f.grants.length, 300, 'one payment per group at the provider'); assert.equal(w.f.grants.reduce((a, g) => a + g.amount, 0), 3000);
  const g0 = w.f.grants.length;
  for (let i = 0; i < 12; i++) { c.n = 0; const f0 = w.f.calls.length; await tick(w.ctx, await w.reload()); assert.ok(c.n + (w.f.calls.length - f0) <= BUDGET); w.clock.t += 5 * 60_000; }
  assert.equal(w.f.grants.length, g0, 'converged: nothing more is paid');
});

test('Z2 settled groups are cheap: a settle tick over 100 settled groups pays nothing, never calls the provider, writes no reward, and costs well under one query per group', async () => {
  const w = await sworld(); await seedScale(w, 10, 10); const c = counter(w);
  for (let i = 0; i < 1200; i++) { await tick(w.ctx, await w.reload()); w.clock.t += 5 * 60_000; if ((await sentTiers(w)) === 100 && (await w.db.first('SELECT backlog b FROM tick_state')).b === 0) break; }
  assert.equal(w.f.grants.length, 100);
  const rows0 = (await w.db.first('SELECT COUNT(*) n FROM reward')).n, f0 = w.f.calls.length; let q = 0, settleTicks = 0;
  for (let i = 0; i < 20; i++) { const seq = (await w.db.first('SELECT tick_seq s FROM tick_state')).s; c.n = 0; await tick(w.ctx, await w.reload()); if (seq % 2 === 1) { q += c.n; settleTicks++; } w.clock.t += 5 * 60_000; }
  assert.ok(settleTicks >= 5);
  assert.equal((await w.db.first('SELECT COUNT(*) n FROM reward')).n, rows0); assert.equal(w.f.calls.length, f0, 'no provider call for settled groups');
  assert.ok(q / settleTicks <= BUDGET, 'queries per settle tick: ' + q / settleTicks);
});

test('Z3 the budget is counted at the port (a stage cannot run past it), a budget stop is not an error, and "tick.budget_reached" is written once a day', async () => {
  const b = makeBudget(3), db = budgetDb({ first: async () => 1, all: async () => [], run: async () => ({}), batch: async () => [] }, b);
  await db.first('x'); await db.all('x'); await db.run('x'); await assert.rejects(() => db.first('x'), BudgetReached); assert.equal(b.used, 3);
  assert.equal(budgetLimit({}), 40); assert.equal(budgetLimit({ TICK_QUERY_BUDGET: '0' }), 0); assert.equal(budgetLimit({ TICK_QUERY_BUDGET: '25' }), 25);
  const w = await sworld(); await seedScale(w, 12, 4);
  for (let i = 0; i < 6; i++) { const r = await tick(w.ctx, await w.reload()); assert.ok(!Object.values(r).some((v) => v?.error)); w.clock.t += 5 * 60_000; }
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM audit WHERE action = 'tick.budget_reached'")).n, 1, 'once for the day');
  assert.ok((await w.db.first('SELECT last_tick_ok_at t FROM company')).t > 0, 'a budget stop still counts as a running clock');
  w.clock.t += 2 * DAY; for (let i = 0; i < 4; i++) { await tick(w.ctx, await w.reload()); w.clock.t += 5 * 60_000; }
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM audit WHERE action = 'tick.budget_reached'")).n, 2, 'and again the next day');
});

test('Z4 the overview shows the backlog while groups wait, and an alert when it persists; both go away when the clock has caught up', async () => {
  const w = await sworld(); await seedScale(w, 12, 4);
  await tick(w.ctx, await w.reload()); w.clock.t += 5 * 60_000; await tick(w.ctx, await w.reload());
  let ov = (await ovw(w));
  assert.ok(ov.tick_backlog > 0, 'groups are waiting: ' + JSON.stringify(ov).slice(0, 300)); assert.ok(!ov.alerts.some((a) => /clock is behind/.test(a)), 'not yet persistent');
  await w.db.run('UPDATE tick_state SET backlog_ticks = 6');
  ov = (await ovw(w)); assert.ok(ov.alerts.some((a) => /clock is behind/.test(a)));
  for (let i = 0; i < 300; i++) { w.clock.t += 5 * 60_000; await tick(w.ctx, await w.reload()); if ((await w.db.first('SELECT backlog b FROM tick_state')).b === 0 && (await sentTiers(w)) === 48) break; }
  ov = (await ovw(w)); assert.equal(ov.tick_backlog, 0); assert.ok(!ov.alerts.some((a) => /clock is behind/.test(a)));
});

test('Z5 a stage that throws raises an overview alert (stage name and time), does not stamp the clock as fully run, and the other stages still ran; a good tick clears it', async () => {
  const w = await sworld(); w.ctx.env = { ...w.ctx.env, TICK_QUERY_BUDGET: '0' };
  await tick(w.ctx, await w.reload()); const ok0 = (await w.db.first('SELECT last_tick_ok_at t FROM company')).t; assert.ok(ok0 > 0);
  const real = w.ctx.db.first.bind(w.ctx.db); let boom = true;
  w.ctx.db.first = async (sql, ...a) => { if (boom && /FROM penalty_case/.test(sql)) throw new Error('disk on fire'); return real(sql, ...a); };
  w.ctx.db.all = ((all) => async (sql, ...a) => { if (boom && /FROM penalty_case/.test(sql)) throw new Error('disk on fire'); return all(sql, ...a); })(w.ctx.db.all.bind(w.ctx.db));
  w.clock.t += 10 * 60_000; const r = await tick(w.ctx, await w.reload());
  assert.equal(r.penalties.error, 'internal'); assert.ok(r.settled && !r.settled.error, 'later stages still ran');
  assert.equal((await w.db.first('SELECT last_tick_ok_at t FROM company')).t, ok0, 'not stamped');
  boom = false; const ov = (await ovw(w)); boom = true;
  assert.equal(ov.tick_stage_error.stage, 'penalties'); assert.ok(ov.tick_stage_error.at > 0); assert.ok(ov.alerts.some((a) => /penalties/.test(a)));
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM audit WHERE action = 'tick.stage_error'")).n, 1);
  w.clock.t += 5 * 60_000; await tick(w.ctx, await w.reload()); assert.equal((await w.db.first("SELECT COUNT(*) n FROM audit WHERE action = 'tick.stage_error'")).n, 1, 'one line a day per stage');
  boom = false; w.clock.t += 5 * 60_000; await tick(w.ctx, await w.reload());
  assert.ok((await w.db.first('SELECT last_tick_ok_at t FROM company')).t > ok0); assert.equal((await ovw(w)).tick_stage_error, null);
});

test('Z6 (m1) several drops at once book ONE reversal and ONE correction', async () => {
  const w = await sworld(); const A = w.people.a;
  const settle = (e) => settleEntitlement(w.ctx, w.company, { person: A, kind: 'tier', groupKey: 'tier:t1:W1', periodKey: 'W1', entitled: e, at: w.clock.t, label: 'x' });
  await settle(60); w.clock.t += DAY;
  await Promise.all([settle(20), settle(20), settle(20)]);
  const rv = await w.db.all("SELECT amount FROM reward WHERE group_key = 'tier:t1:W1' AND kind = 'reversal'");
  assert.equal(rv.length, 1); assert.equal(rv[0].amount, -40);
  assert.equal((await w.db.first('SELECT COUNT(*) n FROM correction WHERE person_id = ?', A.id)).n, 1);
  assert.equal(w.f.total('a@acme.test'), 60);
});

test('Z7 (m5) erase also scrubs free text: event ext_id/notes, correction reasons (ids, amounts, states stay)', async () => {
  const w = await sworld(); const P = w.people.b;
  await w.db.run("INSERT INTO event (id, company_id, person_id, source, event_type, stage, ext_id, occurred_at, value, status, created_at, applied_at, meta, reason, reversal_reason) VALUES ('ev_z7', ?, ?, 'api', 'game', 'completed', 'ref bob smith 555-1234', 5, 0, 'applied', 5, 5, '{\"note\":\"bob smith called\"}', 'asked by bob smith', 'bob smith left')", w.company.id, P.id);
  await w.db.run("INSERT INTO correction (id, company_id, person_id, amount, state, reason, created_at) VALUES ('cr_z7', ?, ?, 25, 'open', 'bob smith took too much', 5)", w.company.id, P.id);
  await w.db.run("UPDATE app_user SET status = 'left', left_at = ? WHERE id = ?", w.clock.t - 400 * DAY, P.id);
  await eraseLeaver(w.ctx, w.company, w.admin, P.id);
  const ev = await w.db.first("SELECT * FROM event WHERE id = 'ev_z7'");
  assert.equal(ev.ext_id, 'erased:ev_z7'); assert.equal(ev.status, 'applied'); assert.ok(!JSON.stringify(ev).includes('bob smith') && !JSON.stringify(ev).includes('555-1234'));
  const cr = await w.db.first("SELECT * FROM correction WHERE id = 'cr_z7'"); assert.equal(cr.amount, 25); assert.equal(cr.state, 'open'); assert.ok(!JSON.stringify(cr).includes('bob smith'));
});

test('Z8 (m6) an idempotency key longer than 120 characters is refused where it is made, never cut; 120 is fine', async () => {
  const w = await sworld();
  assert.equal(MAX_IDEM, 120); assert.equal(checkIdemKey('k'.repeat(120)).length, 120);
  assert.throws(() => checkIdemKey('k'.repeat(121)), /idempotency key/); assert.throws(() => checkIdemKey(''), /idempotency key/);
  await assert.rejects(() => grant(w.ctx, w.company, { person: w.people.a, kind: 'tier', amount: 10, idem: 'k'.repeat(121), groupKey: 'tier:z8', periodKey: 'W1', at: w.clock.t }), /idempotency key/);
  assert.equal((await w.db.first('SELECT COUNT(*) n FROM reward WHERE group_key = ?', 'tier:z8')).n, 0, 'nothing written');
  assert.ok(await grant(w.ctx, w.company, { person: w.people.a, kind: 'tier', amount: 10, idem: 'k'.repeat(120), groupKey: 'tier:z8', periodKey: 'W1', at: w.clock.t }));
});

test('Z9 (m4) an e-mail change writes an audit line and the overview counts recent e-mail changes (a name change does not count)', async () => {
  const w = await sworld(); const a = w.people.a;
  assert.equal((await ovw(w)).recent_email_changes, 0);
  await correctDetails(w.ctx, w.company, w.admin, a.id, { name: 'Alice B' });
  assert.equal((await ovw(w)).recent_email_changes, 0);
  await correctDetails(w.ctx, w.company, w.admin, a.id, { email: 'alice.new@acme.test' });
  const ln = await w.db.first("SELECT data FROM audit WHERE action = 'person.correct' ORDER BY at DESC, rowid DESC LIMIT 1"); assert.ok(JSON.parse(ln.data).fields.includes('email'));
  assert.equal((await ovw(w)).recent_email_changes, 1);
});
