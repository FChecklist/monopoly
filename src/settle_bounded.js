// The settle of the clock when a per-tick query budget is in force (src/budget.js). The same rules as settleCompany (periods.js), reached in a different order and at a different cost:
//  - the work is cut into UNITS (one period of one target), newest closed periods first; the two newest of every target are visited at every tick, the rest in rotation from a persisted cursor;
//  - a group that did not change costs no query of its own: ONE aggregated query per unit gives every person's fingerprint (events, rewards), one query loads the marks of the last visit, and only a person whose
//    fingerprint differs (or whose mark is older than a day) is settled again;
//  - nothing starts without the budget for it; when the budget runs out the settle stops cleanly, saves the cursor and reports the backlog (groups still waiting), which the overview shows.
import { settingsOf } from './config.js';
import { periodOf, DAY } from './util.js';
import { tiersOf, tierReached, safeSettle, snapshotTeam, teamEntitlements } from './periods.js';
import { BudgetReached } from './budget.js';
import { commit } from './audit.js';

export const VISIT_COST = 20; // queries one full visit of one group may use (settle, grant, send, fingerprint, mark): nothing is started with less left
const RECHECK = 7 * DAY;     // safety net: every group is settled again at least once a week whatever its fingerprint says (a change of events or rewards shows in the fingerprint at once)
const COUNT = "('queued','sent','waiting','recorded')";
const AGG = `COALESCE(SUM(CASE WHEN state IN ${COUNT} THEN amount ELSE 0 END),0) paid, COUNT(*) c, COALESCE(SUM(CASE state WHEN 'queued' THEN 1 WHEN 'failed' THEN 7 WHEN 'waiting' THEN 13 WHEN 'sent' THEN 31 WHEN 'void' THEN 61 ELSE 127 END),0) ss, COALESCE(MAX(created_at),0) mx, COALESCE(SUM(LENGTH(COALESCE(last_error,''))),0) le, COALESCE(SUM(sent_amount),0) sa`;
const rsig = (r) => (r ? `${r.paid}|${r.c}|${r.ss}|${r.mx}|${r.le}|${r.sa}` : '0|0|0|0|0|0');
const cfgOf = (tiers) => tiers.map((x) => `${x.count}:${x.bonus}`).join(',');

const rewardAgg = (ctx, companyId, personId, groupKey) => ctx.db.first(`SELECT ${AGG} FROM reward WHERE company_id = ? AND person_id = ? AND group_key = ?`, companyId, personId, groupKey);
const writeMark = (ctx, companyId, groupKey, personId, sig) => ctx.db.run('INSERT INTO settle_mark (company_id, group_key, person_id, sig, checked_at) VALUES (?,?,?,?,?) ON CONFLICT (company_id, group_key, person_id) DO UPDATE SET sig = excluded.sig, checked_at = excluded.checked_at', companyId, groupKey, personId, sig, ctx.now());

/** The closed periods of one target (oldest first), as settleCompany works them out; null when the target has no tiers or nothing to settle. */
async function periodsOf(ctx, company, t, s, asOf, lag) {
  const tiers = await tiersOf(ctx, t.id);
  if (!tiers.length) return null;
  const bw = await ctx.db.first('SELECT (SELECT MIN(occurred_at) FROM event WHERE company_id=? AND event_type=? AND stage=? AND occurred_at >= ?) a, (SELECT MIN(created_at) FROM reward WHERE company_id=? AND group_key LIKE ?) r', company.id, t.event_type, t.stage, t.active_from, company.id, `%:${t.id}:%`);
  const startAt = Math.max(t.active_from, Math.min(bw?.a ?? Infinity, bw?.r ?? Infinity));
  if (!Number.isFinite(startAt)) return null;
  const periods = [];
  let p = periodOf(t.period, startAt, s.fy_start_month);
  for (let guard = 0; p.end + lag <= asOf && guard < 20000; guard++) { if (p.end > t.active_from) periods.push(p); p = periodOf(t.period, p.end, s.fy_start_month); }
  const allPeriods = periods.slice();
  if (periods.length > 400) periods.splice(0, periods.length - 400);
  return { tiers, periods, allPeriods };
}

const note = (report, out) => { report.paid += out.paid ?? 0; report.reversed += out.reversed ?? 0; report.visited++; };

/** One period of a person-scope target. Returns how many persons are still waiting (not enough budget left). */
async function personUnit(ctx, company, u, report) {
  const { t, m, pr } = u, b = ctx.budget, gkey = `tier:${t.id}:${pr.key}`, start = Math.max(pr.start, t.active_from ?? 0), cfg = cfgOf(m.tiers);
  const ev = await ctx.db.all("SELECT person_id id, SUM(CASE WHEN status IN ('applied','reversal_pending') THEN 1 ELSE 0 END) n, COUNT(*) total FROM event WHERE company_id=? AND event_type=? AND stage=? AND status IN ('applied','reversed','reversal_pending') AND occurred_at >= ? AND occurred_at < ? GROUP BY person_id", company.id, t.event_type, t.stage, start, pr.end);
  const rw = await ctx.db.all(`SELECT person_id id, ${AGG} FROM reward WHERE company_id = ? AND group_key = ? GROUP BY person_id`, company.id, gkey);
  const marks = new Map((await ctx.db.all('SELECT person_id id, sig, checked_at at FROM settle_mark WHERE company_id = ? AND group_key = ?', company.id, gkey)).map((r) => [r.id, r]));
  const evBy = new Map(ev.map((x) => [x.id, x])), rwBy = new Map(rw.map((x) => [x.id, x]));
  let pending = 0;
  for (const id of new Set([...evBy.keys(), ...rwBy.keys()])) {
    const e = evBy.get(id), n = e?.n ?? 0, sig = `${cfg}|${n}|${e?.total ?? 0}|${rsig(rwBy.get(id))}`, mk = marks.get(id);
    if (mk && mk.sig === sig && ctx.now() - mk.at < RECHECK) { report.unchanged++; continue; }
    if (b.left() < VISIT_COST) { pending++; continue; }
    const person = await ctx.db.first('SELECT * FROM app_user WHERE id = ?', id);
    if (!person) continue;
    const out = await safeSettle(ctx, company, report, { person, kind: 'tier', groupKey: gkey, periodKey: pr.key, entitled: tierReached(m.tiers, n)?.bonus ?? 0, at: pr.end - 1, label: t.name });
    report.tiers++; note(report, out); report.dirty.add(t.id);
    await writeMark(ctx, company.id, gkey, id, `${cfg}|${n}|${e?.total ?? 0}|${rsig(await rewardAgg(ctx, company.id, id, gkey))}`);
  }
  return pending;
}

/** One period of a team-scope target. */
async function teamUnit(ctx, company, u, report) {
  const { t, m, pr } = u, b = ctx.budget, s = settingsOf(company), final = pr.end + s.late_close_days * DAY <= ctx.now(), cfg = cfgOf(m.tiers), prefix = `team:${t.id}:${pr.key}:`;
  const ev = await ctx.db.first("SELECT COUNT(*) n, COALESCE(MAX(rowid),0) mx, COALESCE(SUM(CASE WHEN status IN ('applied','reversal_pending') THEN 1 ELSE 0 END),0) ok FROM event WHERE company_id=? AND event_type=? AND stage=? AND occurred_at >= ? AND occurred_at < ?", company.id, t.event_type, t.stage, Math.max(pr.start, t.active_from ?? 0), pr.end);
  const rw = await ctx.db.all(`SELECT group_key g, person_id id, ${AGG} FROM reward WHERE company_id = ? AND group_key LIKE ? GROUP BY group_key, person_id`, company.id, prefix + '%');
  const rwBy = new Map(rw.map((x) => [x.g + '|' + x.id, x]));
  const unitSig = `${cfg}|${ev.n}|${ev.mx}|${ev.ok}|${final ? 1 : 0}|${rw.map((x) => x.g + x.id + rsig(x)).join(';')}`;
  const marks = new Map((await ctx.db.all('SELECT group_key g, person_id id, sig, checked_at at FROM settle_mark WHERE company_id = ? AND group_key LIKE ?', company.id, prefix + '%')).map((r) => [r.g + '|' + r.id, r]));
  const um = (await ctx.db.first("SELECT sig, checked_at at FROM settle_mark WHERE company_id = ? AND group_key = ? AND person_id = '*'", company.id, 'unit:' + prefix));
  if (um && um.sig === unitSig && ctx.now() - um.at < RECHECK) { report.unchanged++; return 0; }
  if (b.left() < VISIT_COST) return 1;
  const teams = await ctx.db.all('SELECT * FROM team WHERE company_id = ? ORDER BY id', company.id);
  for (const team of teams) await snapshotTeam(ctx, company, t, pr, team);
  let pending = 0;
  for (const team of teams) {
    const g2 = `${prefix}${team.id}`;
    for (const mem of await teamEntitlements(ctx, company, t, m.tiers, pr, team, s, final)) {
      const sig = `${cfg}|E${mem.entitled}|${rsig(rwBy.get(g2 + '|' + mem.id))}`, mk = marks.get(g2 + '|' + mem.id);
      if (mk && mk.sig === sig && ctx.now() - mk.at < RECHECK) { report.unchanged++; continue; }
      if (b.left() < VISIT_COST) { pending++; continue; }
      const person = await ctx.db.first('SELECT * FROM app_user WHERE id = ?', mem.id);
      if (!person) continue;
      const out = await safeSettle(ctx, company, report, { person, kind: 'team', groupKey: g2, periodKey: pr.key, entitled: mem.entitled, at: pr.end - 1, label: t.name });
      report.team++; note(report, out);
      await writeMark(ctx, company.id, g2, mem.id, `${cfg}|E${mem.entitled}|${rsig(await rewardAgg(ctx, company.id, mem.id, g2))}`);
    }
  }
  if (pending === 0 && b.left() >= 3) await writeMark(ctx, company.id, 'unit:' + prefix, '*', unitSig); // (a later change of the unit simply makes it differ again)
  return pending;
}

/** Streaks of a person-scope target: N hit periods in a row. Runs when a person of the target was settled this tick, or once a day; resumable (every group has its own mark). */
async function streaksOf(ctx, company, t, m, report) {
  const b = ctx.budget, s = settingsOf(company), runKey = 'streakrun:' + t.id;
  const streaks = await ctx.db.all('SELECT * FROM streak WHERE target_id = ?', t.id);
  if (!streaks.length) return 0;
  const run = await ctx.db.first("SELECT checked_at at FROM settle_mark WHERE company_id = ? AND group_key = ? AND person_id = '*'", company.id, runKey);
  if (run && !report.dirty.has(t.id) && ctx.now() - run.at < RECHECK) return 0;
  const windowKeys = new Set(m.periods.map((x) => x.key));
  const hit = new Map(); // period key -> Set of persons who reached tier 1
  for (const pr of m.allPeriods) {
    if (b.left() < 4) return 1; // not enough budget to learn every period: the run continues at a later tick
    hit.set(pr.key, new Set((await ctx.db.all("SELECT person_id id FROM event WHERE company_id=? AND event_type=? AND stage=? AND status IN ('applied','reversal_pending') AND occurred_at >= ? AND occurred_at < ? GROUP BY person_id HAVING COUNT(*) >= ?", company.id, t.event_type, t.stage, Math.max(pr.start, t.active_from ?? 0), pr.end, m.tiers[0].count)).map((x) => x.id)));
  }
  let pending = 0;
  for (const st of streaks) {
    const prior = await ctx.db.all("SELECT person_id id, period_key k FROM reward WHERE company_id = ? AND group_key LIKE ? AND period_key IS NOT NULL GROUP BY person_id, period_key", company.id, `streak:${st.id}:%`);
    const aggs = new Map((await ctx.db.all(`SELECT group_key g, person_id id, ${AGG} FROM reward WHERE company_id = ? AND group_key LIKE ? GROUP BY group_key, person_id`, company.id, `streak:${st.id}:%`)).map((x) => [x.g + '|' + x.id, x]));
    const marks = new Map((await ctx.db.all('SELECT group_key g, person_id id, sig, checked_at at FROM settle_mark WHERE company_id = ? AND group_key LIKE ?', company.id, `streak:${st.id}:%`)).map((r) => [r.g + '|' + r.id, r]));
    const ids = new Set(prior.map((x) => x.id));
    for (const set of hit.values()) for (const id of set) ids.add(id);
    for (const id of ids) {
      let runN = 0; const entitled = new Set(), frozenIn = new Set();
      for (const pr of m.allPeriods) {
        if (hit.get(pr.key)?.has(id)) { runN++; if (runN >= st.length) { entitled.add(pr.key); runN = 0; } continue; }
        const q = periodOf('quarter', pr.start, s.fy_start_month).key;
        if (st.freeze_per_quarter > 0 && !frozenIn.has(q)) { frozenIn.add(q); continue; }
        runN = 0;
      }
      const keys = new Set([...entitled, ...prior.filter((x) => x.id === id).map((x) => x.k)]);
      for (const k of keys) {
        if (!windowKeys.has(k)) continue;
        const pr = m.periods.find((x) => x.key === k), g = `streak:${st.id}:${k}`, want = entitled.has(k) ? st.bonus : 0;
        const sig = `S${want}|${rsig(aggs.get(g + '|' + id))}`, mk = marks.get(g + '|' + id);
        if (mk && mk.sig === sig && ctx.now() - mk.at < RECHECK) { report.unchanged++; continue; }
        if (b.left() < VISIT_COST) { pending++; continue; }
        const person = await ctx.db.first('SELECT * FROM app_user WHERE id = ?', id);
        if (!person) continue;
        const out = await safeSettle(ctx, company, report, { person, kind: 'streak', groupKey: g, periodKey: k, entitled: want, at: pr.end - 1, label: t.name });
        report.streaks++; note(report, out);
        await writeMark(ctx, company.id, g, id, `S${want}|${rsig(await rewardAgg(ctx, company.id, id, g))}`);
      }
    }
  }
  if (pending === 0 && b.left() >= 2) await writeMark(ctx, company.id, runKey, '*', 'done');
  return pending;
}

export async function settleBounded(ctx, company, asOf = ctx.now()) {
  const b = ctx.budget, s = settingsOf(company), lag = s.late_close_days * DAY;
  const report = { tiers: 0, paid: 0, reversed: 0, streaks: 0, team: 0, visited: 0, unchanged: 0, dirty: new Set() };
  let backlog = 0, cursor = null, done = false, sweepLeft = 0;
  try {
    const st = await ctx.db.first('SELECT settle_cursor FROM tick_state WHERE company_id = ?', company.id);
    const targets = await ctx.db.all('SELECT * FROM period_target WHERE company_id = ?', company.id);
    const units = [], metas = new Map();
    for (const t of targets) {
      const m = await periodsOf(ctx, company, t, s, asOf, lag);
      if (!m) continue;
      metas.set(t.id, m);
      m.periods.slice().reverse().forEach((pr, rank) => units.push({ t, m, pr, rank, key: String(pr.end).padStart(16, '0') + '|' + t.id }));
    }
    units.sort((a, c) => (a.key < c.key ? 1 : a.key > c.key ? -1 : 0));
    const prio = units.filter((x) => x.rank < 2), rest = units.filter((x) => x.rank >= 2);
    const from = st?.settle_cursor ? rest.findIndex((x) => x.key < st.settle_cursor) : 0;
    const order = prio.concat(from < 0 ? rest : rest.slice(from));
    let i = 0;
    for (; i < order.length; i++) {
      const u = order[i];
      if (b.left() < 6) break; // not even the aggregates of the next unit fit
      const pending = u.t.scope === 'person' ? await personUnit(ctx, company, u, report) : await teamUnit(ctx, company, u, report);
      if (pending > 0) { backlog += pending; i++; break; }
      if (u.rank >= 2) cursor = u.key;
    }
    sweepLeft = Math.max(0, order.length - i); // periods the sweep has not looked at yet: information, not work known to be waiting
    if (i >= order.length && backlog === 0) {
      done = true;
      for (const t of targets) if (t.scope === 'person' && metas.has(t.id)) backlog += await streaksOf(ctx, company, t, metas.get(t.id), report);
    }
  } catch (e) {
    if (!(e instanceof BudgetReached)) throw e;
    backlog = Math.max(backlog, 1); // the budget ended inside a unit: it is resumed at the next tick
  }
  b.backlog = backlog; b.sweepLeft = sweepLeft; b.settleCursor = done && backlog === 0 ? null : cursor;
  b.settleCursorSet = done && backlog === 0 ? true : cursor !== null;
  const out = { ...report, dirty: undefined, backlog, sweepLeft };
  if (report.paid || report.reversed || report.errors || report.newly_blocked || report.unblocked) { // the same one line as the unbounded settle
    try { await commit(ctx, company.id, 'system', 'settle', { tiers: report.tiers, paid: report.paid, reversed: report.reversed, streaks: report.streaks, team: report.team, errors: report.errors, newly_blocked: report.newly_blocked, unblocked: report.unblocked }, []); } catch { /* the next tick */ }
  }
  return out;
}
