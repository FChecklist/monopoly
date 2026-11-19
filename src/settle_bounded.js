// The settle of the clock when a per-invocation query budget is in force (src/budget.js). The same rules as settleCompany (periods.js), reached at a cost that does not depend on how many people, teams or
// targets there are. Cloudflare D1 counts one batch() as ONE query, so everything that only READS is done in a few batches:
//  1. ONE batch reads the schedule: targets, tiers, where each target's history starts, streaks, the saved cursor.
//  2. The work is cut into UNITS: one period of one target, or the streak run of one target. Units are visited newest closed period first; the two newest periods of each target and every streak unit are looked at on
//     every settle turn, the older ones in rotation from a cursor saved in tick_state.settle_cursor. A chunk of up to 12 units is read in ONE batch (events, rewards, marks of every member of every unit).
//  3. From those rows the code works out, in memory, which members have something to settle (their fingerprint differs from the mark of their last clean visit). Members that are up to date cost nothing.
//  4. Only a member that really needs settling costs calls: about 20 for a first payment (the money path itself, one provider call included), and the mark is written in the same step.
// A visit never blocks the others: a member whose visit did not finish cleanly gets a RETRY mark (tried again after a while) and the loop goes on; a budget stop saves the cursor and reports the backlog.
// The mark of a member is written ONLY when its visit finished cleanly (paid, or verified up to date).
import { settingsOf } from './config.js';
import { periodOf, DAY } from './util.js';
import { tierReached, safeSettle, snapshotTeam, splitTeamBonus } from './periods.js';
import { BudgetReached } from './budget.js';
import { commit } from './audit.js';

export const PAY_COST = 20;     // calls a first payment of one member may use (reads that confirm 'nothing there', the grant, the provider call, the receipt, the mark)
export const REVISIT_COST = 12; // calls a member that already has rows may use (settle again, mark)
export const SCHEDULE_COST = 2; // the schedule batch and the first unit batch: nothing starts with less
const CHUNK = 12, CHUNK_STATEMENTS = 80, MAX_STREAK_PERIODS = 600;
const RECHECK = 7 * DAY;        // safety net: every member is settled again at least once a week whatever its fingerprint says (a change of events or rewards shows in the fingerprint at once)
const RETRY_AFTER = 2 * 60_000, RETRY_BLOCKED_AFTER = 6 * 3600_000;
const COUNT = "('queued','sent','waiting','recorded')";
const AGG = `COALESCE(SUM(CASE WHEN state IN ${COUNT} THEN amount ELSE 0 END),0) paid, COUNT(*) c, COALESCE(SUM(CASE state WHEN 'queued' THEN 1 WHEN 'failed' THEN 7 WHEN 'waiting' THEN 13 WHEN 'sent' THEN 31 WHEN 'void' THEN 61 ELSE 127 END),0) ss, COALESCE(MAX(created_at),0) mx, COALESCE(SUM(LENGTH(COALESCE(last_error,''))),0) le, COALESCE(SUM(sent_amount),0) sa`;
// the same six numbers as one string, computed by the database (used to write a mark without reading the group again)
const SIGEXPR = `COALESCE(SUM(CASE WHEN state IN ${COUNT} THEN amount ELSE 0 END),0) || '|' || COUNT(*) || '|' || COALESCE(SUM(CASE state WHEN 'queued' THEN 1 WHEN 'failed' THEN 7 WHEN 'waiting' THEN 13 WHEN 'sent' THEN 31 WHEN 'void' THEN 61 ELSE 127 END),0) || '|' || COALESCE(MAX(created_at),0) || '|' || COALESCE(SUM(LENGTH(COALESCE(last_error,''))),0) || '|' || COALESCE(SUM(sent_amount),0)`;
const rsig = (r) => (r ? `${r.paid}|${r.c}|${r.ss}|${r.mx}|${r.le}|${r.sa}` : '0|0|0|0|0|0');
const cfgOf = (tiers) => tiers.map((x) => `${x.count}:${x.bonus}`).join(',');
const upper = (prefix) => prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1); // 'a:b:' -> 'a:b;' : an index-friendly range instead of LIKE 'a:b:%'

const holdOf = (sig) => (sig === 'RETRYB' ? RETRY_BLOCKED_AFTER : RETRY_AFTER);
/** What to do with a member: 'same' (up to date), 'wait' (retry hold), 'todo'. */
function judge(ctx, mk, sig) {
  if (mk && mk.sig === sig && ctx.now() - mk.at < RECHECK) return 'same';
  if (mk && (mk.sig === 'RETRY' || mk.sig === 'RETRYB') && ctx.now() - mk.at < holdOf(mk.sig)) return 'wait';
  return 'todo';
}
const retryMark = (ctx, companyId, group, personId, sig) => ctx.db.run('INSERT INTO settle_mark (company_id, group_key, person_id, sig, checked_at) VALUES (?,?,?,?,?) ON CONFLICT (company_id, group_key, person_id) DO UPDATE SET sig = excluded.sig, checked_at = excluded.checked_at', companyId, group, personId, sig, ctx.now());
// ONE statement: the mark gets the fingerprint the group has NOW (read inside the same statement), so a payment just made is part of it
const cleanMark = (ctx, companyId, group, personId, prefix) => ctx.db.run(`INSERT INTO settle_mark (company_id, group_key, person_id, sig, checked_at) SELECT ?,?,?, ? || (SELECT ${SIGEXPR} FROM reward WHERE company_id = ? AND person_id = ? AND group_key = ?), ? WHERE 1 ON CONFLICT (company_id, group_key, person_id) DO UPDATE SET sig = excluded.sig, checked_at = excluded.checked_at`, companyId, group, personId, prefix, companyId, personId, group, ctx.now());

/** The closed periods of one target (oldest first) from the schedule rows; null when nothing to settle. */
function periodsFrom(t, tiers, st, s, asOf, lag) {
  if (!tiers.length) return null;
  const startAt = Math.max(t.active_from, Math.min(st?.a ?? Infinity, st?.r1 ?? Infinity, st?.r2 ?? Infinity));
  if (!Number.isFinite(startAt)) return null;
  const periods = [];
  let p = periodOf(t.period, startAt, s.fy_start_month);
  for (let guard = 0; p.end + lag <= asOf && guard < 20000; guard++) { if (p.end > t.active_from) periods.push(p); p = periodOf(t.period, p.end, s.fy_start_month); }
  const allPeriods = periods.slice();
  if (periods.length > 400) periods.splice(0, periods.length - 400);
  return { tiers, periods, allPeriods };
}

// ---------- reading: the statements of a unit, and the plan worked out from the rows ----------
function readsOf(company, u, s) {
  const { t, m, pr } = u;
  if (u.kind === 'person') {
    const g = `tier:${t.id}:${pr.key}`;
    return [
      ["SELECT person_id id, SUM(CASE WHEN status IN ('applied','reversal_pending') THEN 1 ELSE 0 END) n, COUNT(*) total FROM event WHERE company_id=? AND event_type=? AND stage=? AND status IN ('applied','reversed','reversal_pending') AND occurred_at >= ? AND occurred_at < ? GROUP BY person_id", company.id, t.event_type, t.stage, Math.max(pr.start, t.active_from ?? 0), pr.end],
      [`SELECT person_id id, ${AGG} FROM reward WHERE company_id = ? AND group_key = ? GROUP BY person_id`, company.id, g],
      ['SELECT person_id id, sig, checked_at at FROM settle_mark WHERE company_id = ? AND group_key = ?', company.id, g],
    ];
  }
  if (u.kind === 'team') {
    const prefix = `team:${t.id}:${pr.key}:`;
    return [
      ["SELECT person_id id, COUNT(*) n FROM event WHERE company_id=? AND event_type=? AND stage=? AND status IN ('applied','reversal_pending') AND occurred_at >= ? AND occurred_at < ? GROUP BY person_id", company.id, t.event_type, t.stage, Math.max(pr.start, t.active_from ?? 0), pr.end],
      ['SELECT id FROM team WHERE company_id = ? ORDER BY id', company.id],
      ['SELECT team_id, person_id, weight, entitled FROM team_period_member WHERE target_id = ? AND period_key = ? ORDER BY team_id, person_id', t.id, pr.key],
      ['SELECT team_id FROM team_period WHERE target_id = ? AND period_key = ?', t.id, pr.key],
      [`SELECT group_key g, person_id id, ${AGG} FROM reward WHERE company_id = ? AND group_key >= ? AND group_key < ? GROUP BY group_key, person_id`, company.id, prefix, upper(prefix)],
      ['SELECT group_key g, person_id id, sig, checked_at at FROM settle_mark WHERE company_id = ? AND group_key >= ? AND group_key < ?', company.id, prefix, upper(prefix)],
    ];
  }
  // streak run of one target: who reached tier 1 in every period (one SELECT per period, all in the same batch), the rewards and the marks of its streaks
  const out = [];
  for (const p of m.allPeriods.slice(-MAX_STREAK_PERIODS)) out.push(["SELECT person_id id FROM event WHERE company_id=? AND event_type=? AND stage=? AND status IN ('applied','reversal_pending') AND occurred_at >= ? AND occurred_at < ? GROUP BY person_id HAVING COUNT(*) >= ?", company.id, t.event_type, t.stage, Math.max(p.start, t.active_from ?? 0), p.end, m.tiers[0].count]);
  for (const st of u.streaks) {
    const prefix = `streak:${st.id}:`;
    out.push([`SELECT group_key g, person_id id, ${AGG} FROM reward WHERE company_id = ? AND group_key >= ? AND group_key < ? GROUP BY group_key, person_id`, company.id, prefix, upper(prefix)]);
    out.push(['SELECT group_key g, person_id id, sig, checked_at at FROM settle_mark WHERE company_id = ? AND group_key >= ? AND group_key < ?', company.id, prefix, upper(prefix)]);
  }
  return out;
}

/** Members of a unit with something to settle. Each: { id, group, kind, periodKey, entitled, at, fresh, prefix, label }. */
async function planOf(ctx, company, u, rows, s, report) {
  const { t, m, pr } = u, todo = [];
  if (u.kind === 'person') {
    const [ev, rw, mk] = rows, g = `tier:${t.id}:${pr.key}`, cfg = cfgOf(m.tiers);
    const evBy = new Map(ev.map((x) => [x.id, x])), rwBy = new Map(rw.map((x) => [x.id, x])), mkBy = new Map(mk.map((x) => [x.id, x]));
    for (const id of new Set([...evBy.keys(), ...rwBy.keys()])) {
      const e = evBy.get(id), n = e?.n ?? 0, total = e?.total ?? 0, prefix = `${cfg}|${n}|${total}|`, sig = prefix + rsig(rwBy.get(id)), entitled = tierReached(m.tiers, n)?.bonus ?? 0;
      const j = judge(ctx, mkBy.get(id), sig);
      if (j === 'same') { report.unchanged++; continue; }
      if (j === 'wait') { report.retrying = (report.retrying ?? 0) + 1; continue; }
      if (!rwBy.has(id) && entitled === 0) { report.unchanged++; continue; } // nothing earned, nothing paid
      todo.push({ id, group: g, kind: 'tier', periodKey: pr.key, entitled, at: pr.end - 1, fresh: !rwBy.has(id) && entitled > 0, prefix, label: t.name, count: 'tiers' });
    }
    return todo;
  }
  if (u.kind === 'team') {
    let [ev, teams, mem, tp, rw, mk] = rows;
    const cfg = cfgOf(m.tiers), prefix = `team:${t.id}:${pr.key}:`, final = pr.end + s.late_close_days * DAY <= ctx.now();
    const have = new Set(tp.map((x) => x.team_id)), missing = teams.filter((x) => !have.has(x.id));
    if (missing.length) { // first close of this period: who was in each team is written down once (a snapshot), then read back
      for (const team of missing) await snapshotTeam(ctx, company, t, pr, team);
      mem = await ctx.db.all('SELECT team_id, person_id, weight, entitled FROM team_period_member WHERE target_id = ? AND period_key = ? ORDER BY team_id, person_id', t.id, pr.key);
    }
    const evBy = new Map(ev.map((x) => [x.id, x.n])), byTeam = new Map();
    for (const r of mem) { if (!byTeam.has(r.team_id)) byTeam.set(r.team_id, []); byTeam.get(r.team_id).push(r); }
    const rwBy = new Map(rw.map((x) => [x.g + '|' + x.id, x])), mkBy = new Map(mk.map((x) => [x.g + '|' + x.id, x]));
    const freeze = [], ent = new Map(); // the share of a member: recomputed until the late window ended, then the first value is frozen and only ever lowered
    for (const [teamId, rows2] of byTeam) {
      const members = rows2.map((r) => ({ id: r.person_id, row: r, weight: r.weight, events: evBy.get(r.person_id) ?? 0 }));
      const total = members.reduce((a, x) => a + x.events, 0), tier = tierReached(m.tiers, total), elig = members.filter((x) => x.events > 0).length;
      const split = splitTeamBonus(Math.min(tier?.bonus ?? 0, s.split_head_cap * elig), members, s.split_contrib_pct);
      for (const x of members) {
        const now = split.get(x.id) ?? 0;
        if (!final) { ent.set(teamId + '|' + x.id, now); continue; }
        if (x.row.entitled === null || x.row.entitled === undefined) freeze.push({ teamId, id: x.id, now });
        ent.set(teamId + '|' + x.id, Math.min(now, x.row.entitled ?? now));
      }
    }
    if (freeze.length) {
      const res = await ctx.db.batch(freeze.map((f) => ['UPDATE team_period_member SET entitled = ? WHERE target_id = ? AND period_key = ? AND team_id = ? AND person_id = ? AND entitled IS NULL', f.now, t.id, pr.key, f.teamId, f.id]));
      if (res.some((r) => r.changes === 0)) { // somebody froze it first: use THEIR figure (never raised)
        const again = await ctx.db.all('SELECT team_id, person_id, entitled FROM team_period_member WHERE target_id = ? AND period_key = ?', t.id, pr.key);
        for (const r of again) { const k = r.team_id + '|' + r.person_id; if (ent.has(k) && r.entitled != null) ent.set(k, Math.min(ent.get(k), r.entitled)); }
      }
    }
    for (const [k, entitled] of ent) {
      const [teamId, id] = k.split('|'), g = `${prefix}${teamId}`, rr = rwBy.get(g + '|' + id), pre = `${cfg}|E${entitled}|`, sig = pre + rsig(rr), j = judge(ctx, mkBy.get(g + '|' + id), sig);
      if (j === 'same') { report.unchanged++; continue; }
      if (j === 'wait') { report.retrying = (report.retrying ?? 0) + 1; continue; }
      if (!rr && entitled === 0) { report.unchanged++; continue; }
      todo.push({ id, group: g, kind: 'team', periodKey: pr.key, entitled, at: pr.end - 1, fresh: !rr && entitled > 0, prefix: pre, label: t.name, count: 'team' });
    }
    return todo;
  }
  // streaks
  const nP = Math.min(m.allPeriods.length, MAX_STREAK_PERIODS), periods = m.allPeriods.slice(-nP), windowKeys = new Set(m.periods.map((x) => x.key));
  const hit = new Map(periods.map((p, i) => [p.key, new Set(rows[i].map((x) => x.id))]));
  u.streaks.forEach((st, si) => {
    const rw = rows[nP + 2 * si], mk = rows[nP + 2 * si + 1], prefix = `streak:${st.id}:`;
    const rwBy = new Map(rw.map((x) => [x.g + '|' + x.id, x])), mkBy = new Map(mk.map((x) => [x.g + '|' + x.id, x]));
    const priorBy = new Map(); // person -> period keys that already have rows
    for (const x of rw) { if (!priorBy.has(x.id)) priorBy.set(x.id, new Set()); priorBy.get(x.id).add(x.g.slice(prefix.length)); }
    const ids = new Set(priorBy.keys()); for (const set of hit.values()) for (const id of set) ids.add(id);
    for (const id of ids) {
      let runN = 0; const entitled = new Set(), frozenIn = new Set();
      for (const pr2 of periods) {
        if (hit.get(pr2.key)?.has(id)) { runN++; if (runN >= st.length) { entitled.add(pr2.key); runN = 0; } continue; }
        const q = periodOf('quarter', pr2.start, s.fy_start_month).key;
        if (st.freeze_per_quarter > 0 && !frozenIn.has(q)) { frozenIn.add(q); continue; }
        runN = 0;
      }
      for (const k of new Set([...entitled, ...(priorBy.get(id) ?? [])])) {
        if (!windowKeys.has(k)) continue;
        const pr2 = m.periods.find((x) => x.key === k), g = `${prefix}${k}`, want = entitled.has(k) ? st.bonus : 0, rr = rwBy.get(g + '|' + id), pre = `S${want}|`, sig = pre + rsig(rr), j = judge(ctx, mkBy.get(g + '|' + id), sig);
        if (j === 'same') { report.unchanged++; continue; }
        if (j === 'wait') { report.retrying = (report.retrying ?? 0) + 1; continue; }
        if (!rr && want === 0) { report.unchanged++; continue; }
        todo.push({ id, group: g, kind: 'streak', periodKey: k, entitled: want, at: pr2.end - 1, fresh: !rr && want > 0, prefix: pre, label: t.name, count: 'streaks' });
      }
    }
  });
  return todo;
}

/** One member: settle it, then write its mark ONLY if the visit finished cleanly. A BudgetReached propagates (no mark: the member is visited again). */
async function visit(ctx, company, report, x, person) {
  const e0 = report.errors ?? 0, rs0 = report.reversal_skipped ?? 0, bl0 = report.blocked ?? 0;
  const out = await safeSettle(ctx, company, report, { person, kind: x.kind, groupKey: x.group, periodKey: x.periodKey, entitled: x.entitled, at: x.at, label: x.label, fresh: x.fresh });
  report[x.count]++; report.visited++; report.paid += out.paid ?? 0; report.reversed += out.reversed ?? 0;
  const blockedNow = (report.blocked ?? 0) > bl0 && !out.blocked && !out.failedCode; // a block in force (or just recorded): look again later, not weekly
  const unclean = (report.errors ?? 0) > e0 || (report.reversal_skipped ?? 0) > rs0 || out.stale;
  if (blockedNow || unclean) { report.unclean = (report.unclean ?? 0) + 1; await retryMark(ctx, company.id, x.group, x.id, blockedNow ? 'RETRYB' : 'RETRY'); return; }
  await cleanMark(ctx, company.id, x.group, x.id, x.prefix);
}

/**
 * One settle turn under a budget. `force` (the admin's settle and the season close) also takes periods whose late window has not ended. Returns the report; backlog = members still to settle plus units not looked at;
 * b.settleCursor / b.backlog are read by the tick for its bookkeeping.
 */
export async function settleBounded(ctx, company, asOf = ctx.now(), { force = false } = {}) {
  const b = ctx.budget, s = settingsOf(company), lag = force ? 0 : s.late_close_days * DAY;
  const report = { tiers: 0, paid: 0, reversed: 0, streaks: 0, team: 0, visited: 0, unchanged: 0 };
  let pending = 0, unvisited = 0, cursor = null, done = false, stopped = false, total = 0;
  try {
    if (b.left() < SCHEDULE_COST + 1) { stopped = true; unvisited = 1; throw new BudgetReached(); }
    const [targets, tierRows, starts, streakRows, cur] = await ctx.db.reads([
      ['SELECT * FROM period_target WHERE company_id = ?', company.id],
      ['SELECT * FROM tier WHERE target_id IN (SELECT id FROM period_target WHERE company_id = ?) ORDER BY target_id, idx', company.id],
      ["SELECT t.id id, (SELECT MIN(occurred_at) FROM event e WHERE e.company_id = t.company_id AND e.event_type = t.event_type AND e.stage = t.stage AND e.occurred_at >= t.active_from) a, (SELECT MIN(created_at) FROM reward r WHERE r.company_id = t.company_id AND r.group_key >= 'tier:' || t.id || ':' AND r.group_key < 'tier:' || t.id || ';') r1, (SELECT MIN(created_at) FROM reward r WHERE r.company_id = t.company_id AND r.group_key >= 'team:' || t.id || ':' AND r.group_key < 'team:' || t.id || ';') r2 FROM period_target t WHERE t.company_id = ?", company.id],
      ['SELECT * FROM streak WHERE target_id IN (SELECT id FROM period_target WHERE company_id = ?)', company.id],
      ['SELECT settle_cursor FROM tick_state WHERE company_id = ?', company.id],
    ]);
    const tiersBy = new Map(), startBy = new Map(starts.map((x) => [x.id, x]));
    for (const r of tierRows) { if (!tiersBy.has(r.target_id)) tiersBy.set(r.target_id, []); tiersBy.get(r.target_id).push(r); }
    const units = [], streakUnits = [];
    for (const t of targets) {
      const m = periodsFrom(t, tiersBy.get(t.id) ?? [], startBy.get(t.id), s, asOf, lag);
      if (!m) continue;
      m.periods.slice().reverse().forEach((pr, rank) => units.push({ kind: t.scope === 'person' ? 'person' : 'team', t, m, pr, rank, key: String(pr.end).padStart(16, '0') + '|' + t.id }));
      const sk = streakRows.filter((x) => x.target_id === t.id);
      if (t.scope === 'person' && sk.length) streakUnits.push({ kind: 'streak', t, m, streaks: sk, rank: 0, key: '~' + t.id });
    }
    units.sort((a, c) => (a.key < c.key ? 1 : a.key > c.key ? -1 : 0));
    const prio = units.filter((x) => x.rank < 2), rest = units.filter((x) => x.rank >= 2);
    const saved = cur[0]?.settle_cursor ?? null, from = saved ? rest.findIndex((x) => x.key < saved) : 0;
    const order = prio.concat(streakUnits, from < 0 ? rest : rest.slice(from));
    total = order.length;
    let i = 0;
    const people = new Map();
    while (i < order.length && !stopped) {
      if (b.left() < 2) { stopped = true; break; }
      const chunk = []; let stmts = 0;
      while (i + chunk.length < order.length && chunk.length < CHUNK) {
        const u = order[i + chunk.length], r = readsOf(company, u, s);
        if (chunk.length && stmts + r.length > CHUNK_STATEMENTS) break;
        chunk.push({ u, r }); stmts += r.length;
      }
      const results = await ctx.db.reads(chunk.flatMap((c) => c.r));
      let off = 0; const plans = [];
      for (const c of chunk) { const rows = results.slice(off, off + c.r.length); off += c.r.length; plans.push(await planOf(ctx, company, c.u, rows, s, report)); }
      const ids = [...new Set(plans.flat().map((x) => x.id))].slice(0, 80);
      if (ids.length && b.left() >= PAY_COST) for (const p of await ctx.db.all(`SELECT * FROM app_user WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)) people.set(p.id, p);
      for (let k = 0; k < chunk.length; k++) {
        const u = chunk[k].u; let unitDone = true;
        for (const x of plans[k]) {
          if (stopped || b.left() < (x.fresh ? PAY_COST : REVISIT_COST)) { // not enough left for this member: it is counted, the loop goes on to count the rest and ends
            if (!stopped && b.limit < PAY_COST + 8) b.budgetSmall = `${PAY_COST + 8}:${b.limit}`;
            stopped = true; pending++; unitDone = false; continue;
          }
          const person = people.get(x.id) ?? (await ctx.db.first('SELECT * FROM app_user WHERE id = ?', x.id));
          if (!person) continue;
          await visit(ctx, company, report, x, person);
        }
        if (unitDone) { if (u.rank >= 2 && u.kind !== 'streak') cursor = u.key; i++; }
        else break; // this unit is not finished: it and the units after it are looked at at the next turn
      }
    }
    unvisited = Math.max(0, order.length - i);
    if (i >= order.length && !stopped && pending === 0) done = true;
  } catch (e) {
    if (!(e instanceof BudgetReached)) throw e;
    stopped = true; pending = Math.max(pending, 1); // the budget ended inside a read or a visit: the member is visited again at the next turn (the money paths replay safely)
  }
  b.backlog = pending + unvisited; b.pending = pending; b.sweepLeft = unvisited; b.settleCursor = done ? null : cursor; b.settleCursorSet = done ? true : cursor !== null;
  const out = { ...report, backlog: b.backlog, pending, sweepLeft: unvisited, units: total };
  if (report.paid || report.reversed || report.errors || report.newly_blocked || report.unblocked) { // the same one line as the unbounded settle
    try { if (b.left() >= 3) await commit(ctx, company.id, 'system', 'settle', { tiers: report.tiers, paid: report.paid, reversed: report.reversed, streaks: report.streaks, team: report.team, errors: report.errors, newly_blocked: report.newly_blocked, unblocked: report.unblocked }, []); } catch { /* the next tick */ }
  }
  return out;
}
