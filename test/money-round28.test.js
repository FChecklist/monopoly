// Round 28 (audit 27): the free-plan invariants on EVERY route (50 D1 queries per invocation, 5 million rows read per day) and a driver whose daily read volume is bounded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crawlWorld } from './crawlworld.js';
import { keyCall } from './webhelp.js';
import { T0 } from './helpers.js';
import { createKey } from '../src/setup.js';
import { grant } from '../src/rewards.js';
import { judge, retryInfo, capsOf, COLD_MIN_PER_DAY } from '../src/settle_bounded.js';
import { batchGate, invocationLimit } from '../src/budget.js';

const DAY = 86400_000;

test('B1 event intake: one event costs a bounded number of calls, a batch is cut at the invocation budget (207, next_index), the caller sends the rest, every event is entered exactly once and whole', async () => {
  const w = await crawlWorld({ people: 30, months: 1 });
  const key = await createKey(w.ctx, w.company, w.admin, { scope: 'event_write' });
  const mk = (i) => ({ person_id: w.ids[i % 30], event_type: 'lead', stage: 'entered', ext_id: 'B1-' + i, occurred_at: w.clock.t - 1000 - i });
  let b = w.calls; let r = await keyCall(w, key, 'POST', '/api/ingest/events', { events: [mk(0)] });
  assert.equal(r.status, 200); assert.equal(r.json.results[0].ok, true);
  const one = w.calls - b; assert.ok(one <= 34, 'one event used ' + one + ' calls (was 46)');
  let next = 1, rounds = 0; const all = Array.from({ length: 100 }, (_, i) => mk(i));
  while (next < 100 && rounds++ < 100) {
    b = w.calls; r = await keyCall(w, key, 'POST', '/api/ingest/events', { events: all.slice(next) });
    const used = w.calls - b; assert.ok(used <= 50, `a call used ${used}`);
    if (r.json.deferred) { assert.equal(r.status, 207); assert.equal(r.json.next_index, r.json.processed); assert.ok(r.json.max_per_call >= 1); } else assert.equal(r.status, 200);
    assert.equal(r.json.results.length, r.json.processed); assert.ok(r.json.results.every((x) => x.ok), JSON.stringify(r.json.results.find((x) => !x.ok)));
    next += r.json.processed;
  }
  assert.equal(next, 100);
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM event WHERE ext_id LIKE 'B1-%'")).n, 100);
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM event WHERE ext_id LIKE 'B1-%' AND status = 'approved'")).n, 0, 'no event is left half done');
  r = await keyCall(w, key, 'POST', '/api/ingest/events', { events: all.slice(0, 2) });
  assert.ok(r.json.results.every((x) => x.ok === false && x.reason === 'duplicate'), 'sending a part again only reports duplicates');
});

test('B2 CSV import: a commit answers {more, next_row} when the invocation is used up; the UI loop sends from_row and every row is entered once', async () => {
  const w = await crawlWorld({ people: 40, months: 1 });
  await w.login('admin');
  const csv = 'work_email,event_type,stage,ext_id\n' + Array.from({ length: 40 }, (_, i) => `p${i}@acme.test,lead,entered,csv-${i}`).join('\n');
  let b = w.calls; const prev = await w.call('admin', 'POST', '/api/events/csv', { csv, commit: false });
  assert.equal(prev.json.accepted, 40); assert.ok(w.calls - b <= 8, 'a preview of 40 rows used ' + (w.calls - b) + ' calls');
  let from = 0, calls = 0, done = 0;
  for (;;) {
    await w.login('admin'); b = w.calls;
    const r = await w.call('admin', 'POST', '/api/events/csv', { csv, commit: true, ...(from ? { from_row: from } : {}) });
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.ok(w.calls - b <= 50, 'csv call used ' + (w.calls - b));
    done += r.json.results.length; calls++;
    if (!r.json.more) break;
    assert.ok(r.json.next_row > from); from = r.json.next_row;
    assert.ok(calls < 60);
  }
  assert.ok(calls > 1, 'a 40-row file does not fit one free-plan invocation');
  assert.equal(done, 40); assert.equal((await w.db.first("SELECT COUNT(*) n FROM event WHERE ext_id LIKE 'csv-%'")).n, 40);
});

test('C the lazy clock runs only before the light reads in its whitelist and not before a heavy route', async () => {
  const w = await crawlWorld({ people: 10, months: 1 });
  w.clock.t += 30 * 60_000; await w.login('admin'); await w.login('mgr');
  const last = async () => (await w.db.first('SELECT last_tick_at t FROM company')).t;
  const t0 = await last();
  await w.call('mgr', 'GET', '/api/events'); await w.call('mgr', 'GET', '/api/team/contributions');
  await w.call('admin', 'POST', '/api/events', { person_id: w.ids[0], event_type: 'lead', stage: 'entered', ext_id: 'c-1' });
  assert.equal(await last(), t0, 'a heavy route never starts the clock');
  await w.call('admin', 'GET', '/api/admin/overview');
  assert.ok((await last()) > t0, 'the overview may');
});

test('D lists are pages: events, people, contributions, team board return at most one page with next_offset, at 38 and 200 people, in few calls', async () => {
  for (const people of [38, 200]) {
    const w = await crawlWorld({ people, months: 3, teams: 1 });
    await w.db.run("UPDATE app_user SET team_id = ? WHERE role = 'employee'", w.team);
    for (const [who, path] of [['hr', '/api/events'], ['admin', '/api/events'], ['mgr', '/api/team/board'], ['mgr', '/api/team/contributions'], ['admin', '/api/people'], ['mgr', '/api/people'], ['admin', '/api/admin/targets']]) {
      await w.login(who); const b = w.calls;
      const r = await w.call(who, 'GET', path);
      const used = w.calls - b;
      assert.equal(r.status, 200, path + ' ' + r.status);
      assert.ok(used <= 30, `${path} as ${who} at ${people} people: ${used} calls`);
      const list = r.json.events ?? r.json.people ?? r.json.contributions ?? r.json.tokens;
      if (list && r.json.next_offset !== undefined) { assert.ok(list.length <= 100, path + ' page size'); if (people >= 200) assert.ok(r.json.next_offset !== null, path + ' says there is more'); }
    }
  }
});

test('A1 a company day: 144 driver runs, 60 people x 12 months x 7 targets: bounded rows, every call within 50, hot groups paid, runs end when only cold work is left', async () => {
  const w = await crawlWorld({ people: 60, months: 12, payFrom: T0 - 70 * DAY, coldTargets: 6 });
  const key = await createKey(w.ctx, w.company, w.admin, { scope: 'event_write' });
  const stats = w.ctx.db.stats;
  const call = async (turn) => { const b = w.calls; const r = await keyCall(w, key, 'POST', '/api/ingest/tick', { turn }); assert.equal(r.status, 200, r.text); assert.ok(w.calls - b <= 50, 'a tick call used ' + (w.calls - b)); return r.json; };
  const r0 = stats.rowsRead, w0 = stats.rowsWritten; let inv = 0; const perRun = [];
  for (let run = 0; run < 144; run++) {
    const a = stats.rowsRead; let n = 0;
    for (let i = 0; i < 20; i++) { const j = await call('core'); n++; if (!Object.entries(j).some(([, v]) => v && typeof v === 'object' && v.budget)) break; }
    for (let i = 0; i < 60; i++) { const j = await call('settle'); n++; if (!(j.backlog ?? 0)) break; }
    inv += n; perRun.push([n, stats.rowsRead - a]); w.clock.t += 600_000;
  }
  const read = stats.rowsRead - r0, written = stats.rowsWritten - w0;
  assert.ok((await w.db.first("SELECT COUNT(*) n FROM reward WHERE kind = 'tier' AND state = 'sent'")).n >= 60, 'the hot groups were all paid');
  assert.equal((await w.db.first('SELECT backlog b FROM tick_state')).b, 0);
  for (const [n, rows] of perRun.slice(-20)) { assert.ok(n <= 3, 'a settled company needs about two invocations per run: ' + n); assert.ok(rows <= 6000, 'rows per idle run ' + rows); }
  assert.ok(inv <= 480, 'invocations per day ' + inv);
  assert.ok(read <= 500_000, 'rows returned per day ' + read + ' (stated bound 500,000; the free plan allows 5,000,000 scanned)');
  assert.ok(written <= 20_000, 'rows written per day ' + written);
});

test('A2 above the soft rows-read limit the settle does hot work only and the overview says rows_read_high with the number', async () => {
  const w = await crawlWorld({ people: 20, months: 4, coldTargets: 2 });
  await w.login('admin');
  const day = Math.floor(w.clock.t / DAY);
  await w.db.run('INSERT INTO tick_state (company_id, rows_day, rows_read_day) VALUES (?,?,?) ON CONFLICT (company_id) DO UPDATE SET rows_day = excluded.rows_day, rows_read_day = excluded.rows_read_day', w.company.id, day, 3_600_000);
  const ov = await w.call('admin', 'GET', '/api/admin/overview');
  assert.equal(ov.json.rows_read_today, 3_600_000);
  assert.ok(ov.json.alerts.some((a) => a.startsWith('rows_read_high: 3600000 rows')), JSON.stringify(ov.json.alerts));
  const key = await createKey(w.ctx, w.company, w.admin, { scope: 'event_write' });
  const r = await keyCall(w, key, 'POST', '/api/ingest/tick', { turn: 'settle' });
  assert.equal(r.json.settled.cold_read, 0); assert.equal(r.json.settled.rows_high, true);
});

test('M1 a retry mark backs off and a changed fingerprint ends the wait at once; a cap change shows in the fingerprint; the batch gate always lets the first item run', () => {
  const ctx = { now: () => 1_000_000 };
  const mk = (sig, ago) => ({ sig, at: 1_000_000 - ago });
  assert.equal(judge(ctx, mk('RETRY:1:fp', 60_000), 'fp'), 'wait');
  assert.equal(judge(ctx, mk('RETRY:1:fp', 121_000), 'fp'), 'todo');
  assert.equal(judge(ctx, mk('RETRY:3:fp', 121_000), 'fp'), 'wait', 'the third failure waits 8 minutes');
  assert.equal(judge(ctx, mk('RETRYB:1:fp', 3_000_000), 'fp'), 'wait');
  assert.equal(judge(ctx, mk('RETRYB:1:fp', 3_000_000), 'fp2'), 'todo', 'a blocked member is looked at again as soon as something changed');
  assert.equal(judge(ctx, mk('RETRYB', 3_000_000), 'x'), 'wait', 'old bare marks keep their meaning');
  assert.equal(retryInfo(mk('RETRY:12:abc', 0)).n, 12);
  assert.notEqual(capsOf({ cap_person_month: 100, cap_person_season: 1, cap_period_bonus_person_period: 1, cap_event: 1 }), capsOf({ cap_person_month: 200, cap_person_season: 1, cap_period_bonus_person_period: 1, cap_event: 1 }));
  assert.ok(COLD_MIN_PER_DAY >= 1 && invocationLimit({ TICK_QUERY_BUDGET: '0' }) === Infinity && invocationLimit({}) === 50 && invocationLimit({ INVOCATION_QUERY_LIMIT: '1000' }) === 1000);
  const g = batchGate({ env: {}, budget: { used: 40 } }); assert.equal(g.canTake(), true); g.begin(); g.end(); assert.equal(g.canTake(), false, 'the first item always runs, the second does not fit');
});

test('M2 a first payment is guarded in the INSERT: a failed row that appeared meanwhile stops the second cash row', async () => {
  const w = await crawlWorld({ people: 3, months: 1 });
  const person = await w.db.first('SELECT * FROM app_user WHERE id = ?', w.ids[0]);
  const gk = 'tier:t_x:M2026-10';
  await w.db.run("INSERT INTO reward (id, company_id, person_id, kind, group_key, idem_key, amount, season_id, state, note, created_at, sent_amount, last_error) VALUES ('zf1',?,?,'tier',?,'k-failed',10,?,'failed','{}',?,10,'account_closed')", w.company.id, person.id, gk, w.season, w.clock.t);
  const noRows = { sql: 'NOT EXISTS (SELECT 1 FROM reward WHERE company_id = ? AND person_id = ? AND group_key = ?)', params: [w.company.id, person.id, gk] };
  const g = await grant(w.ctx, w.company, { person, kind: 'tier', amount: 10, idem: 'k-new', groupKey: gk, periodKey: 'M2026-10', at: w.clock.t, periodBonus: true, actor: 'system', paidGuard: { paid: 0 }, alsoGuard: noRows });
  assert.equal(g.reason, 'stale'); assert.equal((await w.db.first('SELECT COUNT(*) n FROM reward WHERE group_key = ?', gk)).n, 1, 'no second row');
});
