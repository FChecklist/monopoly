// Round-27 (audit 26): the budgeted settle must not starve anything. A unit is read in a few batches (a D1 batch counts as ONE query), whatever the number of members, teams or targets; a visit that did not finish
// cleanly never looks done; one unit that cannot be settled never blocks the others; streaks stand on their own; an error stays flagged per stage; the lazy tick cannot overrun the invocation; the core stages are fair.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { boot } from './webhelp.js';
import { T0 } from './helpers.js';
import { tick } from '../src/api.js';
import { settleCompany } from '../src/periods.js';
import { grant, retryQueued } from '../src/rewards.js';
import { addPerson } from '../src/people.js';
import { openDb, migrate } from '../src/db.js';
import * as setup from '../src/setup.js';
import { fakeMnp } from './mnpfake.js';
import { MoneypennyProvider } from '../src/provider/moneypenny.js';

const DAY = 86400_000, MIN5 = 5 * 60_000;
const SETTINGS = { daily_event_limit: 1e6, cap_event: 500, cap_person_month: 1e6, cap_person_season: 1e6, cap_period_bonus_person_period: 1e6 };

async function sworld({ budget = '40', lazy = '0', wrap = null } = {}) {
  const w = await boot({ settings: SETTINGS });
  const f = fakeMnp({ lifetime: 1e6, now: () => w.clock.t });
  const prov = new MoneypennyProvider({ baseUrl: 'https://mnp.test', keyId: 'k', secret: 's'.repeat(32) }, { fetchImpl: (u, i) => (wrap ? wrap(f, u, i) : f.fetchImpl(u, i)) });
  w.ctx.provider = () => prov; w.f = f;
  await w.db.run("UPDATE company SET provider = 'moneypenny' WHERE id = ?", w.company.id); await w.reload();
  await w.db.run('UPDATE season SET ends_at = ? WHERE id = ?', T0 + 800 * DAY, w.season);
  w.ctx.env = { ...w.ctx.env, TICK_QUERY_BUDGET: budget, LAZY_TICK: lazy };
  w.n = 0;
  w.ev = (person, type, at) => w.db.run("INSERT INTO event (id, company_id, person_id, source, event_type, stage, ext_id, occurred_at, value, status, created_at, applied_at) VALUES (?,?,?,?,?,?,?,?,0,'applied',?,?)", 'zev' + (w.n++), w.company.id, person, 'api', type, 'completed', 'z' + w.n, at, T0, T0);
  // counts every call on the raw port (queries) and every provider request: what ONE worker invocation would be charged
  w.calls = 0; const raw = w.ctx.db;
  for (const m of ['first', 'all', 'run', 'batch', 'reads']) { const g = raw[m].bind(raw); raw[m] = (...a) => { w.calls++; return g(...a); }; }
  w.used = () => w.calls + w.f.calls.length;
  return w;
}
const person = async (w, i, team = false) => (await addPerson(w.ctx, w.company, w.admin, { email: `p${i}@acme.test`, name: 'p' + i, role: 'employee', ...(team ? { team_id: w.team } : {}), joined_at: T0 - 900 * DAY })).user.id;
const sentRows = async (w) => (await w.db.first("SELECT COUNT(*) n FROM reward WHERE state = 'sent' AND kind IN ('tier','team','streak')")).n;

/** The same world twice (one settled in one go, one by the bounded clock). Returns the pieces to compare. */
async function bigWorld(w) {
  const names = new Map();
  for (let k = 0; k < 7; k++) { const t = await setup.addTarget(w.ctx, w.company, w.admin, { name: 'P' + k, scope: 'person', period: 'month', event_type: 'e' + k, stage: 'completed', tiers: [{ count: 1, bonus: 10 + k }, { count: 2, bonus: 25 + k }], active_from: T0 - 30 * DAY }); names.set(t.id, 'P' + k); }
  const tm = await setup.addTarget(w.ctx, w.company, w.admin, { name: 'TM', scope: 'team', period: 'month', event_type: 'tm', stage: 'completed', tiers: [{ count: 3, bonus: 100 }], active_from: T0 - 30 * DAY }); names.set(tm.id, 'TM');
  const wk = await setup.addTarget(w.ctx, w.company, w.admin, { name: 'WK', scope: 'person', period: 'week', event_type: 'wk', stage: 'completed', tiers: [{ count: 1, bonus: 5 }], streak: { length: 2, bonus: 20, freeze_per_quarter: 0 }, active_from: T0 - 30 * DAY }); names.set(wk.id, 'WK'); names.set(wk.streak_id, 'WKS');
  const ps = []; for (let i = 0; i < 3; i++) ps.push(await person(w, i));
  const label = new Map(ps.map((id, i) => [id, 'p' + i])); for (const k of ['a', 'b', 'c', 'd', 'mgr']) label.set(w.people[k].id, k);
  for (let k = 0; k < 7; k++) for (let m = 0; m < 3; m++) for (const [i, id] of ps.entries()) { await w.ev(id, 'e' + k, T0 - 8 * DAY + m * 31 * DAY); if ((i + m + k) % 2 === 0) await w.ev(id, 'e' + k, T0 - 7 * DAY + m * 31 * DAY); }
  for (let m = 0; m < 2; m++) for (const k of ['a', 'b', 'c', 'd', 'mgr']) { await w.ev(w.people[k].id, 'tm', T0 - 8 * DAY + m * 31 * DAY); if (k === 'a') await w.ev(w.people[k].id, 'tm', T0 - 6 * DAY + m * 31 * DAY); }
  for (let wkk = 0; wkk < 8; wkk++) { await w.ev(ps[0], 'wk', T0 - 8 * DAY + wkk * 7 * DAY + DAY); if (wkk % 2 === 0) await w.ev(ps[1], 'wk', T0 - 8 * DAY + wkk * 7 * DAY + DAY); }
  w.clock.t = T0 + 150 * DAY;
  const teamId = w.team; names.set(teamId, 'SALES');
  return { names, label };
}
async function shape(w, names, label) {
  const rows = await w.db.all("SELECT person_id, group_key, kind, amount, state, sent_amount FROM reward WHERE kind IN ('tier','team','streak') ORDER BY group_key, person_id");
  return rows.map((r) => `${label.get(r.person_id)}|${[...names].reduce((k, [id, nm]) => k.split(id).join(nm), r.group_key)}|${r.kind}|${r.amount}|${r.state}|${r.sent_amount}`).sort();
}

test('A1 budget 40: 7 person targets + a team of 5 + streaks over 8 weeks are paid exactly as the unbounded settle pays them, newest first, in a bounded number of ticks, and no invocation (overview as the lazy-triggering first request included) exceeds 45 calls', async () => {
  const ref = await sworld({ budget: '0' }); const rdef = await bigWorld(ref);
  await settleCompany(ref.ctx, await ref.reload(), ref.clock.t); await retryQueued(ref.ctx, await ref.reload());
  const want = await shape(ref, rdef.names, rdef.label); assert.ok(want.length >= 40, 'the reference pays something: ' + want.length);

  const w = await sworld({ budget: '40', lazy: '1' }); const def = await bigWorld(w);
  let max = 0, maxWho = '', first = {}, ticks = 0;
  const measure = async (who, f, tag) => { const u0 = w.used(); const r = await f(); const n = w.used() - u0; if (n > max) { max = n; maxWho = tag; } return r; };
  for (; ticks < 700; ticks++) {
    w.clock.t += MIN5; await w.login('admin');
    if (ticks % 3 === 0) { const ov = await measure('admin', () => w.call('admin', 'GET', '/api/admin/overview'), 'overview'); assert.equal(ov.status, 200); } // the first request of a lazy window
    else { const r = await measure('admin', () => w.call('admin', 'POST', '/api/admin/tick', {}), 'tick'); assert.equal(r.status, 200, JSON.stringify(r.json)); for (const [k, v] of Object.entries(r.json)) if (k !== 'ok') assert.ok(!v?.error, k + ' failed'); }
    for (const x of await w.db.all("SELECT DISTINCT period_key p FROM reward WHERE kind = 'tier' AND group_key LIKE 'tier:%'")) if (first[x.p] === undefined) first[x.p] = ticks;
    const st = await w.db.first('SELECT backlog FROM tick_state');
    if ((await sentRows(w)) >= want.length && st?.backlog === 0 && ticks > 12) break;
  }
  assert.ok(max <= 45, `an invocation used ${max} calls (${maxWho})`);
  assert.ok(ticks < 700, 'converged in ' + ticks + ' ticks: sent ' + (await sentRows(w)) + ' of ' + want.length + ' ' + JSON.stringify(await w.db.all('SELECT * FROM tick_state')) + JSON.stringify(await w.db.all('SELECT * FROM tick_stage')) + JSON.stringify(await w.db.all("SELECT state, last_error, COUNT(*) n FROM reward GROUP BY 1,2")));
  // the sending of queued rows belongs to the core turn: let a few more run, then compare
  for (let i = 0; i < 6; i++) { w.clock.t += MIN5; await w.login('admin'); await w.call('admin', 'POST', '/api/admin/tick', {}); }
  assert.deepEqual(await shape(w, def.names, def.label), want, 'the bounded clock pays what the unbounded settle pays');
  const keys = Object.keys(first).sort(); assert.ok(first[keys[keys.length - 1]] <= first[keys[0]], 'newest period first: ' + JSON.stringify(first));
});

test('A2 the settle read side costs the same for 2 members and for 60 members, and an unchanged unit costs one call', async () => {
  const cost = async (P) => {
    const w = await sworld(); await setup.addTarget(w.ctx, w.company, w.admin, { name: 'T', scope: 'person', period: 'month', event_type: 'g', stage: 'completed', tiers: [{ count: 1, bonus: 10 }], active_from: T0 - 30 * DAY });
    for (let i = 0; i < P; i++) { const id = await person(w, i); await w.ev(id, 'g', T0 - 8 * DAY); }
    w.clock.t = T0 + 60 * DAY;
    for (let i = 0; i < P * 2 + 6; i++) { w.clock.t += MIN5; await tick(w.ctx, await w.reload()); }
    assert.equal(await sentRows(w), P);
    // everything is settled now: one settle turn costs the schedule batch, the unit batch and the bookkeeping, not a call per member
    const seqNow = (await w.db.first('SELECT tick_seq s FROM tick_state')).s;
    if (seqNow % 2 === 0) { w.clock.t += MIN5; await tick(w.ctx, await w.reload()); }
    w.clock.t += MIN5; const u0 = w.used(); await tick(w.ctx, await w.reload()); return w.used() - u0;
  };
  const small = await cost(2), big = await cost(40);
  assert.equal(big, small, `settled turn: ${small} calls for 2 members, ${big} for 40`); assert.ok(big <= 12, 'a settled turn is cheap: ' + big);
});

test('A3 one unit that cannot be settled never blocks the others (no head-of-line blocking); its member is retried soon, not in a week; the money is paid once', async () => {
  let broken = true;
  const w = await sworld({ wrap: (f, u, i) => { if (broken && /"email":"p0@acme.test"/.test(i.body ?? '')) throw new TypeError('boom'); return f.fetchImpl(u, i); } });
  await setup.addTarget(w.ctx, w.company, w.admin, { name: 'T', scope: 'person', period: 'month', event_type: 'g', stage: 'completed', tiers: [{ count: 1, bonus: 10 }], active_from: T0 - 30 * DAY });
  const ids = []; for (let i = 0; i < 6; i++) ids.push(await person(w, i));
  for (const [i, id] of ids.entries()) for (let m = 0; m < 3; m++) await w.ev(id, 'g', T0 - 8 * DAY + m * 31 * DAY + i);
  w.clock.t = T0 + 120 * DAY;
  for (let i = 0; i < 80; i++) { w.clock.t += MIN5; await tick(w.ctx, await w.reload()); }
  assert.ok(w.f.total('p1@acme.test') === 30 && w.f.total('p5@acme.test') === 30, 'the others are paid in full while p0 is stuck');
  assert.ok(w.f.total('p0@acme.test') <= 30);
  broken = false;
  for (let i = 0; i < 30; i++) { w.clock.t += MIN5; await tick(w.ctx, await w.reload()); }
  assert.equal(w.f.total('p0@acme.test'), 30, 'p0 is paid once the provider answers again (well inside a week)');
  for (let i = 0; i < 20; i++) { w.clock.t += MIN5; await tick(w.ctx, await w.reload()); }
  assert.equal(w.f.total('p0@acme.test'), 30, 'and never twice');
});

test('A4 budget too small: a normal tick pays nothing and the overview says budget_too_small; the signed tick route (driver) uses a larger allowance and pays', async () => {
  const w = await sworld({ budget: '16' }); await setup.addTarget(w.ctx, w.company, w.admin, { name: 'T', scope: 'person', period: 'month', event_type: 'g', stage: 'completed', tiers: [{ count: 1, bonus: 10 }], active_from: T0 - 30 * DAY });
  const id = await person(w, 0); await w.ev(id, 'g', T0 - 8 * DAY); w.clock.t = T0 + 60 * DAY;
  for (let i = 0; i < 8; i++) { w.clock.t += MIN5; await tick(w.ctx, await w.reload()); }
  assert.equal(w.f.total('p0@acme.test'), 0, 'nothing fits');
  await w.login('admin'); let ov = (await w.call('admin', 'GET', '/api/admin/overview')).json;
  assert.ok(ov.alerts.some((a) => /^budget_too_small/.test(a)), JSON.stringify(ov.alerts));
  for (let i = 0; i < 4; i++) { w.clock.t += MIN5; await w.login('admin'); await w.call('admin', 'POST', '/api/admin/tick', { turn: 'settle' }); }
  assert.equal(w.f.total('p0@acme.test'), 10, 'the driver route visited it anyway');
});

test('A5 (M1) an error at ANY query position of a first visit never leaves the group looking done: it is paid within a few ticks, exactly once', async () => {
  for (let k = 1; k <= 30; k++) {
    const w = await sworld(); await setup.addTarget(w.ctx, w.company, w.admin, { name: 'T', scope: 'person', period: 'month', event_type: 'g', stage: 'completed', tiers: [{ count: 1, bonus: 10 }], active_from: T0 - 30 * DAY });
    const id = await person(w, 0); await w.ev(id, 'g', T0 - 8 * DAY); w.clock.t = T0 + 60 * DAY;
    // the first settle turn runs with one error injected at its k-th database call
    await tick(w.ctx, await w.reload()); // a core turn first (state)
    const cmp = await w.reload(); w.clock.t += MIN5;
    let n = 0; const raw = w.ctx.db, real = {};
    for (const m of ['first', 'all', 'run', 'batch', 'reads']) { real[m] = raw[m]; raw[m] = (...a) => { if (++n === k) { return Promise.reject(new Error('disk hiccup')); } return real[m](...a); }; }
    await tick(w.ctx, cmp);
    for (const m of Object.keys(real)) raw[m] = real[m];
    let at = -1;
    for (let i = 0; i < 10; i++) { w.clock.t += MIN5; await tick(w.ctx, await w.reload()); if (at < 0 && w.f.total('p0@acme.test') === 10) at = i; }
    assert.ok(at >= 0 && at <= 6, `error at call ${k}: paid after ${at} more ticks`);
    assert.equal(w.f.total('p0@acme.test'), 10, `error at call ${k}: paid exactly once`);
    assert.equal(await sentRows(w), 1);
  }
});

test('A6 streaks stand on their own: with 8 weeks of history the tier AND the streak are paid at budget 40, and a streak added after the tiers were settled is paid without any tier change', async () => {
  const w = await sworld(); const wk = await setup.addTarget(w.ctx, w.company, w.admin, { name: 'WK', scope: 'person', period: 'week', event_type: 'wk', stage: 'completed', tiers: [{ count: 1, bonus: 5 }], active_from: T0 - 30 * DAY });
  const id = await person(w, 0); for (let k = 0; k < 8; k++) await w.ev(id, 'wk', T0 - 8 * DAY + k * 7 * DAY + DAY);
  w.clock.t = T0 + 120 * DAY;
  for (let i = 0; i < 60; i++) { w.clock.t += MIN5; await tick(w.ctx, await w.reload()); }
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM reward WHERE kind = 'tier' AND state = 'sent'")).n, 8);
  await w.db.run("INSERT INTO streak (id, company_id, target_id, length, bonus, freeze_per_quarter) VALUES ('sk_late', ?, ?, 2, 20, 0)", w.company.id, wk.id);
  for (let i = 0; i < 60; i++) { w.clock.t += MIN5; await tick(w.ctx, await w.reload()); }
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM reward WHERE kind = 'streak' AND state = 'sent'")).n, 4, 'one streak bonus per two weeks');
  assert.equal(w.f.total('p0@acme.test'), 8 * 5 + 4 * 20);
});

test('A7 a stage error stays flagged PER STAGE across the alternating turns, the clock is not stamped while one is flagged, and only a clean run of that stage clears it', async () => {
  const w = await sworld(); let boom = true;
  const real = w.ctx.db.first.bind(w.ctx.db);
  w.ctx.db.first = async (sql, ...a) => { if (boom && /FROM penalty_case/.test(sql)) throw new Error('disk on fire'); return real(sql, ...a); };
  const all0 = w.ctx.db.all.bind(w.ctx.db); w.ctx.db.all = async (sql, ...a) => { if (boom && /FROM penalty_case/.test(sql)) throw new Error('disk on fire'); return all0(sql, ...a); };
  for (let i = 0; i < 12; i++) { w.clock.t += MIN5; await tick(w.ctx, await w.reload()); }
  boom = false; await w.login('admin');
  const ov = (await w.call('admin', 'GET', '/api/admin/overview')).json;
  assert.equal(ov.tick_stage_errors.length, 1); assert.equal(ov.tick_stage_errors[0].stage, 'penalties'); assert.ok(ov.tick_stage_errors[0].count >= 3);
  assert.ok(ov.alerts.some((a) => /penalties/.test(a)), 'visible even though the last turn was the settle turn');
  assert.equal((await w.db.first('SELECT last_tick_ok_at t FROM company')).t, 0, 'never stamped while a stage is flagged');
  for (let i = 0; i < 12; i++) { w.clock.t += MIN5; await tick(w.ctx, await w.reload()); }
  await w.login('admin'); const ov2 = (await w.call('admin', 'GET', '/api/admin/overview')).json;
  assert.equal(ov2.tick_stage_errors.length, 0, 'cleared when that stage ran cleanly'); assert.ok((await w.db.first('SELECT last_tick_ok_at t FROM company')).t > 0, 'and the clock counts as run');
});

test('A8 the lazy tick cannot overrun the invocation: the overview as the first request of a window stays small, the lazy step never sends or settles, and a request that already used many calls skips it', async () => {
  const w = await sworld({ lazy: '1' }); await setup.addTarget(w.ctx, w.company, w.admin, { name: 'T', scope: 'person', period: 'month', event_type: 'g', stage: 'completed', tiers: [{ count: 1, bonus: 10 }], active_from: T0 - 30 * DAY });
  const id = await person(w, 0); await w.ev(id, 'g', T0 - 8 * DAY); w.clock.t = T0 + 60 * DAY;
  await w.login('admin'); w.clock.t += 10 * MIN5; const u0 = w.used(); const ov = await w.call('admin', 'GET', '/api/admin/overview'); const n = w.used() - u0;
  assert.equal(ov.status, 200); assert.ok(n <= 30, 'overview as the lazy-triggering request: ' + n + ' calls');
  assert.equal(w.f.total('p0@acme.test'), 0, 'the lazy tick settles nothing');
  w.ctx.env = { ...w.ctx.env, LAZY_TICK: '0' }; w.clock.t += 10 * MIN5; const u1 = w.used(); await w.call('admin', 'GET', '/api/admin/overview'); const only = w.used() - u1;
  assert.ok(only <= 14, 'the overview alone: ' + only + ' calls');
  const lt = (await w.db.first('SELECT last_tick_ok_at t FROM company')).t; assert.equal(lt, 0, 'a lazy step never stamps the clock as fully run');
});

test('A9 (M4) the core stages are fair and a budget cut is never an attempt: with many queued rows and a provider that is down, every stage still runs within a cycle and attempts never exceed provider calls', async () => {
  let down = true, tries = 0; const w = await sworld({ wrap: (f, u, i) => { if (/credit/.test(u)) tries++; if (down) throw new TypeError('fetch failed'); return f.fetchImpl(u, i); } });
  const ids = []; for (let i = 0; i < 24; i++) ids.push(await person(w, i));
  for (const [i, id] of ids.entries()) await grant(w.ctx, w.company, { person: { id, email_hash: 'x' }, kind: 'tier', amount: 10, idem: 'q' + i, groupKey: 'tier:q' + i, periodKey: 'W1', at: w.clock.t }).catch(() => {});
  const queued = (await w.db.first("SELECT COUNT(*) n FROM reward WHERE state = 'queued'")).n;
  assert.ok(queued >= 10, 'rows are waiting to be sent: ' + queued);
  const ran = new Set();
  for (let i = 0; i < 16; i++) { w.clock.t += MIN5; const r = await tick(w.ctx, await w.reload()); for (const [k, v] of Object.entries(r)) if (!v?.budget && !v?.error) ran.add(k); }
  for (const s of ['released', 'resumed', 'reversals', 'penalties', 'orders', 'ai_resumed', 'purged', 'settled']) assert.ok(ran.has(s), s + ' ran within the cycle: ' + [...ran]);
  assert.ok(tries > 0, 'the sending stage did real work too');
  const attempts = (await w.db.first("SELECT COALESCE(SUM(attempts),0) n FROM reward WHERE state = 'queued'")).n;
  assert.ok(attempts <= tries, 'attempts (' + attempts + ') are real tries (' + tries + '): a budget cut is never counted');
  down = false;
  for (let i = 0; i < 120; i++) { w.clock.t += MIN5; await tick(w.ctx, await w.reload()); }
  assert.deepEqual(await w.db.all("SELECT id, attempts, last_error, person_id FROM reward WHERE state = 'queued'"), [], 'everything is sent once the provider is back');
});

test('A10 the admin settle and the season close are bounded: they answer { more: true } until the work is done, then finish', async () => {
  const w = await sworld(); await setup.addTarget(w.ctx, w.company, w.admin, { name: 'T', scope: 'person', period: 'month', event_type: 'g', stage: 'completed', tiers: [{ count: 1, bonus: 10 }], active_from: T0 - 30 * DAY });
  for (let i = 0; i < 6; i++) { const id = await person(w, i); await w.ev(id, 'g', T0 - 8 * DAY); }
  w.clock.t = T0 + 60 * DAY; let calls = 0, r;
  do { await w.login('admin'); const u0 = w.used(); r = await w.call('admin', 'POST', '/api/admin/settle', { force: true }); assert.equal(r.status, 200); assert.ok(w.used() - u0 <= 50, 'one invocation: ' + (w.used() - u0)); calls++; } while (r.json.more && calls < 40);
  assert.ok(calls > 1 && calls < 40, 'it took ' + calls + ' calls'); assert.equal(r.json.more, false); assert.equal(await sentRows(w), 6);
});

test('A11 the measured throughput of the free plan: a first-time payment costs about one settle turn (two ticks), and the settle turn alone (driver) pays one per call', async () => {
  const w = await sworld(); await setup.addTarget(w.ctx, w.company, w.admin, { name: 'T', scope: 'person', period: 'month', event_type: 'g', stage: 'completed', tiers: [{ count: 1, bonus: 10 }], active_from: T0 - 30 * DAY });
  for (let i = 0; i < 12; i++) { const id = await person(w, i); await w.ev(id, 'g', T0 - 8 * DAY); }
  w.clock.t = T0 + 60 * DAY; let ticks = 0;
  while ((await sentRows(w)) < 12 && ticks < 80) { w.clock.t += MIN5; await tick(w.ctx, await w.reload()); ticks++; }
  assert.ok(ticks <= 30, '12 first-time payments took ' + ticks + ' ticks (alternating turns)');
  const w2 = await sworld(); await setup.addTarget(w2.ctx, w2.company, w2.admin, { name: 'T', scope: 'person', period: 'month', event_type: 'g', stage: 'completed', tiers: [{ count: 1, bonus: 10 }], active_from: T0 - 30 * DAY });
  for (let i = 0; i < 12; i++) { const id = await person(w2, i); await w2.ev(id, 'g', T0 - 8 * DAY); }
  w2.clock.t = T0 + 60 * DAY; let t2 = 0;
  while ((await sentRows(w2)) < 12 && t2 < 80) { w2.clock.t += MIN5; await tick(w2.ctx, await w2.reload(), { driver: true, turn: 'settle' }); t2++; }
  assert.ok(t2 <= 16 && t2 < ticks, '12 payments took ' + t2 + ' settle-only calls');
});

test('A12 the range queries of the settle use the index (no scan of the company marks or rewards), and the migrations apply fresh and as an upgrade from 0009', async () => {
  const db = openDb(); migrate(db);
  const plan = (sql) => db.raw.prepare('EXPLAIN QUERY PLAN ' + sql).all('c', 'team:t:', 'team:t;').map((r) => r.detail).join(' | ');
  assert.match(plan('SELECT person_id FROM reward WHERE company_id = ? AND group_key >= ? AND group_key < ? GROUP BY group_key, person_id'), /USING (COVERING )?INDEX rw_group/);
  assert.match(plan('SELECT sig FROM settle_mark WHERE company_id = ? AND group_key >= ? AND group_key < ?'), /PRIMARY KEY|USING (COVERING )?INDEX/);
  assert.ok(db.raw.prepare("SELECT name FROM sqlite_master WHERE name IN ('tick_stage','tick_state','settle_mark')").all().length === 3);
  // upgrade: a database that has 0001..0009 gets 0010 and keeps its rows
  const up = openDb(); const files = readdirSync(new URL('../migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();
  up.exec('CREATE TABLE IF NOT EXISTS _migration (name TEXT PRIMARY KEY, at INTEGER NOT NULL)');
  for (const f of files.filter((x) => x < '0010')) { up.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8')); up.raw.prepare('INSERT INTO _migration (name, at) VALUES (?, ?)').run(f, 1); }
  up.raw.exec("INSERT INTO company (id, name, slug, provider, created_at) VALUES ('c1','x','x','stub',1)"); up.raw.exec("INSERT INTO tick_state (company_id, tick_seq) VALUES ('c1', 7)");
  migrate(up);
  assert.equal(up.raw.prepare("SELECT tick_seq, core_ok_at, settle_ok_at FROM tick_state WHERE company_id = 'c1'").get().tick_seq, 7);
  assert.ok(up.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'tick_stage'").get());
});
