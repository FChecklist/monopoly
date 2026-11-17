// Period targets: weekly, monthly, quarterly, half-yearly, yearly tiers, streaks and team splits.
// All bonuses are settled as an "entitlement": what the person has earned now minus what was already paid.
// A positive difference is paid once (idempotent). A negative one is reversed. So a later cancellation is corrected at the next close.
import { settingsOf } from './config.js';
import { grant, reverseReward, seasonAt } from './rewards.js';
import { periodOf, prevPeriod, DAY, sha256Hex } from './util.js';
import { commit } from './audit.js';
import { ProviderError } from './provider/errors.js';

const COUNT = "('queued','sent','waiting','recorded')";

/** Applied (counted) events of one type and stage by one person inside [start, end). Reversed or rejected events never count. */
// An event under a reversal notice (or appeal) still counts until the reversal actually executes.
export async function countFor(ctx, company, target, personId, start, end) {
  if (target.active_from) start = Math.max(start, target.active_from); // a target never counts work from before it started
  const r = await ctx.db.first("SELECT COUNT(*) n FROM event WHERE company_id=? AND person_id=? AND event_type=? AND stage=? AND status IN ('applied','reversal_pending') AND occurred_at >= ? AND occurred_at < ?", company.id, personId, target.event_type, target.stage, start, end);
  return r.n;
}
export const tiersOf = (ctx, targetId) => ctx.db.all('SELECT * FROM tier WHERE target_id = ? ORDER BY idx', targetId);

export function tierReached(tiers, count) {
  let best = null;
  for (const t of tiers) if (count >= t.count) best = t;
  return best;
}

/** How many closed periods (up to `asOf`) the person reached tier 1 of this target. */
export async function periodsHit(ctx, company, target, personId, asOf) {
  const s = settingsOf(company);
  const tiers = await tiersOf(ctx, target.id);
  if (!tiers.length) return 0;
  const first = await ctx.db.first("SELECT MIN(occurred_at) m FROM event WHERE company_id=? AND person_id=? AND event_type=? AND stage=? AND status IN ('applied','reversal_pending') AND occurred_at >= ?", company.id, personId, target.event_type, target.stage, target.active_from ?? 0);
  if (!first?.m) return 0;
  let n = 0, p = periodOf(target.period, first.m, s.fy_start_month);
  while (p.start <= asOf) {
    if (target.scope === 'person' && (await countFor(ctx, company, target, personId, p.start, p.end)) >= tiers[0].count) n++;
    p = periodOf(target.period, p.end, s.fy_start_month);
  }
  return n;
}

const paidSum = async (ctx, companyId, personId, groupKey) =>
  (await ctx.db.first(`SELECT COALESCE(SUM(amount),0) s FROM reward WHERE company_id=? AND person_id=? AND group_key=? AND state IN ${COUNT}`, companyId, personId, groupKey)).s;

/** Bring what was paid for (person, group) in line with what is earned now. */
export async function settleEntitlement(ctx, company, { person, kind, groupKey, periodKey, entitled, at, label }) {
  let paid = await paidSum(ctx, company.id, person.id, groupKey);
  const out = { paid: 0, reversed: 0 };
  if (entitled < paid) {
    // Reverse newest rows first until paid <= entitled. Any overshoot is topped up below.
    const rows = await ctx.db.all("SELECT * FROM reward WHERE company_id=? AND person_id=? AND group_key=? AND reversed=0 AND amount>0 AND kind != 'reversal' AND state IN ('queued','sent','waiting') ORDER BY created_at DESC, rowid DESC", company.id, person.id, groupKey);
    for (const r of rows) {
      if (paid <= entitled) break;
      // Reversing a whole row may overshoot; the difference is paid again below. When no published season covers the period (it closed),
      // that top-up could not be placed and the person would end with LESS than earned: keep the row, the person is overpaid, never underpaid.
      if (paid - r.amount < entitled && !(await seasonAt(ctx, company.id, at))) { out.kept = (out.kept ?? 0) + 1; out.keptAmount = paid - entitled; continue; }
      const o = await reverseReward(ctx, company, r, { reason: 'tier_lost:' + (label ?? kind), actor: 'system' });
      if (o.skipped) { out.skipped = (out.skipped ?? 0) + 1; out.skipCode = o.code ?? out.skipCode ?? 'pending'; continue; } // not confirmed yet (provider still has to answer): leave it for the next close
      out.reversed += r.amount;
      paid -= r.amount;
    }
  }
  // `paid` and the reversal count `gen` come from ONE statement, so the key below never mixes a stale paid with a fresher gen.
  const snap = await ctx.db.first(`SELECT
    (SELECT COALESCE(SUM(amount),0) FROM reward WHERE company_id=? AND person_id=? AND group_key=? AND state IN ${COUNT}) AS paid,
    (SELECT COUNT(*) FROM reward WHERE company_id=? AND person_id=? AND group_key=? AND reversed=1 AND kind != 'reversal' AND NOT (state='void' AND COALESCE(last_error,'') IN ('no_season','season_closed','season_cap'))) AS gen`,
  company.id, person.id, groupKey, company.id, person.id, groupKey);
  paid = snap.paid;
  if (entitled > paid) {
    // The key depends on what is owed and on how many rows of this group were reversed or voided by a reversal (a void writes no reversal row). A row the system itself voided as unreleasable (no_season, season_closed, season_cap: exactly these last_error values, set only by voidWaiting; a void by reversal clears last_error) is not counted, or it would be re-created at every tick, never on how many rows exist.
    // Two settle runs at the same time therefore make the same key, and the second one is a replay.
    const gen = snap.gen;
    // `p${paid}` is what is already counted: a capped or partly paid earlier grant moved it, so the next run tops up the rest
    // under a new key; a voided earlier grant did not, so it replays (a void row is never paid a second time).
    // A row that FAILED for good (a permanent account error) replays as failed_before. Once it is older than the block time, the next try uses a new key (x<n>), so it is paid after all if the account is fine now.
    const stale = (await ctx.db.first("SELECT COUNT(*) n FROM reward WHERE company_id=? AND person_id=? AND group_key=? AND state='failed' AND attempts <= 1 AND created_at <= ?", company.id, person.id, groupKey, ctx.now() - BLOCK_TTL)).n; // a row tried more than once may have reached the provider (a lost answer): it is not revived by itself, an admin does it (open_failed_rewards)
    const idem = `${kind}:${person.id}:${periodKey}:${groupKey.split(':')[1]}:g${gen}:e${entitled}:p${paid}` + (stale ? `:x${stale}` : '');
    const g = await grant(ctx, company, { person, kind, amount: entitled - paid, idem, groupKey, periodKey, at, periodBonus: true, actor: 'system' });
    out.paid = g.paid;
    if (g.failed || g.reason === 'failed_before') out.failedCode = g.reward?.last_error ?? 'failed';
  }
  return out;
}

const BLOCK_TTL = 24 * 3600_000; // a block expires: the entry is tried again after a day
const BLOCKING_CODES = new Set(['account_closed', 'bad_request']); // account-specific and permanent; configuration/provider-state errors are never recorded as a block
const MARKERS = "('period.settle_blocked','period.settle_unblocked')";
const keyOf = async (args) => (await sha256Hex(`${args.person.id}|${args.groupKey}|e${args.entitled}`)).slice(0, 40); // hex: survives the audit scrubber
/** The time the entry was blocked, or null when its newest marker line is an unblock (or there is none). */
async function blockedAt(ctx, company, key) {
  const row = await ctx.db.first(`SELECT action, at FROM audit WHERE company_id = ? AND action IN ${MARKERS} AND instr(data, ?) > 0 ORDER BY n DESC LIMIT 1`, company.id, `"key":"${key}"`);
  return row?.action === 'period.settle_blocked' ? row.at : null;
}

/**
 * One entry of a close. A retriable provider error on this person/target is logged by code only and the run goes on; the next close retries it.
 * Only a PAY entry that fails with an account-specific permanent code (account_closed, bad_request) is recorded as a 'period.settle_blocked'
 * line keyed by person, group and entitled amount, and skipped for 24 hours (then tried again; a success writes 'period.settle_unblocked').
 * A reversal entry (entitled below what was paid) is NEVER blocked: it is retried at every close. A config or provider-state error
 * (unsupported, unauthorized, misconfigured, rate limit, timeout...) never writes a block. A changed entitlement is a new key.
 */
async function safeSettle(ctx, company, report, args) {
  const key = await keyOf(args);
  const isReversal = args.entitled < (await paidSum(ctx, company.id, args.person.id, args.groupKey));
  const at = await blockedAt(ctx, company, key);
  if (!isReversal && at !== null && ctx.now() - at < BLOCK_TTL) { report.blocked = (report.blocked ?? 0) + 1; return { paid: 0, reversed: 0 }; }
  try {
    const out = await settleEntitlement(ctx, company, args);
    if (out.skipped) { report.reversal_skipped = (report.reversal_skipped ?? 0) + out.skipped; await commit(ctx, company.id, 'system', 'period.settle_error', { kind: args.kind, group: args.groupKey, code: 'reverse_pending_' + out.skipCode }); }
    if (out.kept) {
      report.reversal_kept = (report.reversal_kept ?? 0) + out.kept; report.reversal_kept_amount = (report.reversal_kept_amount ?? 0) + (out.keptAmount ?? 0);
      // The person stays overpaid on purpose: one audit line per key (ids, codes and the amount only).
      if (!(await ctx.db.first("SELECT 1 x FROM audit WHERE company_id = ? AND action = 'period.reversal_kept' AND instr(data, ?) > 0", company.id, `"key":"${key}"`))) await commit(ctx, company.id, 'system', 'period.reversal_kept', { key, kind: args.kind, group: args.groupKey, amount: out.keptAmount ?? 0 });
    }
    if (out.failedCode) { // the pay entry failed for good (account error): make it visible and wait out the block time before the next, new-key try
      await commit(ctx, company.id, 'system', 'period.settle_blocked', { key, kind: args.kind, code: out.failedCode });
      report.blocked = (report.blocked ?? 0) + 1; return out;
    }
    if (at !== null) { await commit(ctx, company.id, 'system', 'period.settle_unblocked', { key, kind: args.kind }); report.unblocked = (report.unblocked ?? 0) + 1; }
    return out;
  } catch (e) {
    if (!(e instanceof ProviderError)) { // whatever failed, one entry never stops the close
      report.errors = (report.errors ?? 0) + 1;
      try { await commit(ctx, company.id, 'system', 'period.settle_error', { kind: args.kind, group: args.groupKey, code: 'internal' }); } catch { /* the next close logs again */ }
      return { paid: 0, reversed: 0 };
    }
    const code = e.code ?? 'error';
    report.errors = (report.errors ?? 0) + 1;
    if (!isReversal && !e.retriable && BLOCKING_CODES.has(code)) {
      await commit(ctx, company.id, 'system', 'period.settle_blocked', { key, kind: args.kind, code });
      report.blocked = (report.blocked ?? 0) + 1; report.newly_blocked = (report.newly_blocked ?? 0) + 1;
    } else await commit(ctx, company.id, 'system', 'period.settle_error', { kind: args.kind, group: args.groupKey, code });
    return { paid: 0, reversed: 0 };
  }
}

/** Admin helper: lift every settle block of a company so the next close tries those entries again. Idempotent. Returns the number lifted. */
export async function clearBlocked(ctx, company) {
  const rows = await ctx.db.all(`SELECT action, data, n FROM audit WHERE company_id = ? AND action IN ${MARKERS} ORDER BY n`, company.id);
  const state = new Map();
  for (const r of rows) { let k; try { k = JSON.parse(r.data).key; } catch { continue; } if (k) state.set(k, r.action === 'period.settle_blocked'); }
  let cleared = 0;
  for (const [key, blocked] of state) if (blocked) { await commit(ctx, company.id, 'admin', 'period.settle_unblocked', { key, cleared: true }); cleared++; }
  return { cleared };
}

/** Split a team bonus. Part by contribution, part equal among members with at least one verified event. Rounds down; the remainder goes to the top contributor. */
export function splitTeamBonus(total, members, contribPct) {
  const elig = members.filter((m) => m.events > 0);
  const out = new Map(members.map((m) => [m.id, 0]));
  if (!elig.length || total <= 0) return out;
  const contribPart = Math.floor((total * contribPct) / 100), equalPart = total - contribPart;
  const evSum = elig.reduce((a, m) => a + m.events, 0);
  const wSum = elig.reduce((a, m) => a + (m.weight ?? 1), 0);
  let given = 0;
  for (const m of elig) {
    const a = Math.floor((contribPart * m.events) / evSum) + Math.floor((equalPart * (m.weight ?? 1)) / wSum);
    out.set(m.id, a); given += a;
  }
  const top = [...elig].sort((a, b) => b.events - a.events || String(a.id).localeCompare(String(b.id)))[0];
  out.set(top.id, out.get(top.id) + (total - given));
  return out;
}

/**
 * Members of a team for a period, as they are at the moment the period is first closed: app_user.team_id then.
 * Used ONCE per (target, period, team) (then it is a snapshot). A person already listed under another team for the same
 * target and period is never added again, so a person is in exactly one team's list per period and the order in which
 * teams are visited cannot decide who gets a person (the snapshot of ALL teams is taken in one pass, teams by id).
 */
async function currentMembers(ctx, company, teamId, t, p) {
  return ctx.db.all('SELECT * FROM app_user u WHERE u.company_id=? AND u.team_id=? AND u.joined_at < ? AND (u.left_at IS NULL OR u.left_at > ?) AND NOT EXISTS (SELECT 1 FROM team_period_member x WHERE x.target_id=? AND x.period_key=? AND x.person_id=u.id AND x.team_id != ?) ORDER BY u.id', company.id, teamId, p.end, p.start, t.id, p.key, teamId);
}
const weightOf = (u, p) => {
  const from = Math.max(u.joined_at, p.start), to = Math.min(u.left_at ?? p.end, p.end);
  return Math.max(0.0001, Math.min(1, Math.max(0, to - from) / (p.end - p.start)));
};

async function snapshotTeam(ctx, company, t, pr, team) {
  const key = [t.id, pr.key, team.id];
  if (!(await ctx.db.first('SELECT 1 x FROM team_period WHERE target_id=? AND period_key=? AND team_id=?', ...key))) {
    const stmts = [['INSERT OR IGNORE INTO team_period (target_id, period_key, team_id, company_id, closed_at) VALUES (?,?,?,?,?)', ...key, company.id, ctx.now()]];
    for (const u of await currentMembers(ctx, company, team.id, t, pr)) {
      stmts.push(['INSERT OR IGNORE INTO team_period_member (target_id, period_key, team_id, person_id, company_id, weight) VALUES (?,?,?,?,?,?)', ...key, u.id, company.id, weightOf(u, pr)]);
    }
    await commit(ctx, company.id, 'system', 'team.close', { target: t.id, period: pr.key, team: team.id, members: stmts.length - 1 }, stmts);
  }
}

/**
 * The team bonus of one closed period. The first time a period closes, who was in the team is written down
 * (team_period_member). From then on that list is the only list: a person who later moves team or leaves is neither
 * paid again by the new team nor does their share vanish from the pool. A person is in one team's list per period.
 * Later runs may only LOWER a share (events reversed after the close), never raise it, and never add members.
 */
async function teamEntitlements(ctx, company, t, tiers, pr, team, s, final) {
  const key = [t.id, pr.key, team.id];
  await snapshotTeam(ctx, company, t, pr, team);
  const rows = await ctx.db.all('SELECT m.*, u.id uid FROM team_period_member m JOIN app_user u ON u.id = m.person_id WHERE m.target_id=? AND m.period_key=? AND m.team_id=? ORDER BY m.person_id', ...key);
  const members = [];
  for (const m of rows) members.push({ id: m.person_id, row: m, weight: m.weight, events: await countFor(ctx, company, t, m.person_id, pr.start, pr.end) });
  const total = members.reduce((a, m) => a + m.events, 0);
  const tier = tierReached(tiers, total);
  const elig = members.filter((m) => m.events > 0).length;
  const split = splitTeamBonus(Math.min(tier?.bonus ?? 0, s.split_head_cap * elig), members, s.split_contrib_pct);
  const out = [];
  for (const m of members) {
    const now = split.get(m.id) ?? 0;
    // Until the late-event window has really ended the share is recomputed every run (it may rise or fall): a forced
    // settle or a season close inside the window must not freeze a low number. After the window the first run freezes it.
    if (!final) { out.push({ id: m.id, entitled: now }); continue; }
    if (m.row.entitled === null || m.row.entitled === undefined) {
      await ctx.db.run('UPDATE team_period_member SET entitled = ? WHERE target_id=? AND period_key=? AND team_id=? AND person_id=? AND entitled IS NULL', now, ...key, m.id);
    }
    // Always the STORED value, so two runs at once (each with its own view of the events) agree: never raised, only lowered.
    const stored = (await ctx.db.first('SELECT entitled FROM team_period_member WHERE target_id=? AND period_key=? AND team_id=? AND person_id=?', ...key, m.id))?.entitled ?? now;
    out.push({ id: m.id, entitled: Math.min(now, stored) });
  }
  return out;
}

/**
 * Settle every closed period of every target. A period is closed once its end plus the late-event window has passed.
 * `force` settles periods that have ended even before the window closes (used by tests and by the admin's "close now" button).
 * Periods that ended before the target's active_from are never settled (adding a target later pays nothing for the past).
 */
export async function settleCompany(ctx, company, asOf = ctx.now(), { force = false } = {}) {
  const s = settingsOf(company);
  const report = { tiers: 0, paid: 0, reversed: 0, streaks: 0, team: 0 };
  const lag = force ? 0 : s.late_close_days * DAY;
  const targets = await ctx.db.all('SELECT * FROM period_target WHERE company_id = ?', company.id);
  for (const t of targets) {
    const tiers = await tiersOf(ctx, t.id);
    if (!tiers.length) continue;
    const bounds = await ctx.db.first("SELECT MIN(occurred_at) a, MAX(occurred_at) b FROM event WHERE company_id=? AND event_type=? AND stage=? AND occurred_at >= ?", company.id, t.event_type, t.stage, t.active_from);
    const rewarded = await ctx.db.first("SELECT MIN(created_at) a FROM reward WHERE company_id=? AND group_key LIKE ?", company.id, `%:${t.id}:%`);
    const startAt = Math.max(t.active_from, Math.min(bounds?.a ?? Infinity, rewarded?.a ?? Infinity));
    if (!Number.isFinite(startAt)) continue;
    const periods = [];
    let p = periodOf(t.period, startAt, s.fy_start_month);
    // The newest 400 closed periods are settled (a weekly target keeps settling after years); older ones are left as they were paid.
    for (let guard = 0; p.end + lag <= asOf && guard < 20000; guard++) { if (p.end > t.active_from) periods.push(p); p = periodOf(t.period, p.end, s.fy_start_month); }
    const allPeriods = periods.slice(); // the streak run counter is anchored here (the first period of the target), not at the 400 window
    if (periods.length > 400) periods.splice(0, periods.length - 400);
    const windowKeys = new Set(periods.map((x) => x.key));
    const results = new Map(); // personId -> [{period, hit}]
    for (const pr of periods) {
      const gkey = `tier:${t.id}:${pr.key}`;
      if (t.scope === 'person') {
        const people = await ctx.db.all("SELECT DISTINCT person_id id FROM event WHERE company_id=? AND event_type=? AND stage=? AND status IN ('applied','reversed','reversal_pending') AND occurred_at >= ? AND occurred_at < ? UNION SELECT DISTINCT person_id FROM reward WHERE company_id=? AND group_key=?", company.id, t.event_type, t.stage, Math.max(pr.start, t.active_from), pr.end, company.id, gkey);
        for (const { id } of people) {
          const person = await ctx.db.first('SELECT * FROM app_user WHERE id = ?', id);
          if (!person) continue;
          const n = await countFor(ctx, company, t, id, pr.start, pr.end);
          const tier = tierReached(tiers, n);
          const out = await safeSettle(ctx, company, report, { person, kind: 'tier', groupKey: gkey, periodKey: pr.key, entitled: tier?.bonus ?? 0, at: pr.end - 1, label: t.name });
          report.tiers++; report.paid += out.paid; report.reversed += out.reversed;
          if (!results.has(id)) results.set(id, new Map());
          results.get(id).set(pr.key, n >= tiers[0].count);
        }
      } else {
        const final = pr.end + s.late_close_days * DAY <= ctx.now();
        const teams = await ctx.db.all('SELECT * FROM team WHERE company_id = ? ORDER BY id', company.id);
        for (const team of teams) await snapshotTeam(ctx, company, t, pr, team); // all teams are written down first, in one pass
        for (const team of teams) {
          const g2 = `team:${t.id}:${pr.key}:${team.id}`;
          for (const m of await teamEntitlements(ctx, company, t, tiers, pr, team, s, final)) {
            const person = await ctx.db.first('SELECT * FROM app_user WHERE id = ?', m.id);
            if (!person) continue;
            const out = await safeSettle(ctx, company, report, { person, kind: 'team', groupKey: g2, periodKey: pr.key, entitled: m.entitled, at: pr.end - 1, label: t.name });
            report.team++; report.paid += out.paid; report.reversed += out.reversed;
          }
        }
      }
    }
    // Streaks: N hit periods in a row. One miss per quarter may be frozen (neither counts nor breaks).
    if (t.scope === 'person') {
      for (const st of await ctx.db.all('SELECT * FROM streak WHERE target_id = ?', t.id)) {
        const prior = await ctx.db.all("SELECT DISTINCT person_id id FROM reward WHERE company_id=? AND group_key LIKE ?", company.id, `streak:${st.id}:%`);
        const ids = new Set([...results.keys(), ...prior.map((x) => x.id)]);
        for (const id of ids) {
          const person = await ctx.db.first('SELECT * FROM app_user WHERE id = ?', id);
          if (!person) continue;
          const hits = results.get(id) ?? new Map();
          let run = 0; const entitled = new Set(); const frozenIn = new Set();
          for (const pr of allPeriods) {
            // Periods older than the window were not settled above: their hit is worked out here so the run does not restart at the window start.
            const hit = windowKeys.has(pr.key) ? hits.get(pr.key) : (await countFor(ctx, company, t, id, pr.start, pr.end)) >= tiers[0].count;
            if (hit) { run++; if (run >= st.length) { entitled.add(pr.key); run = 0; } continue; }
            const q = periodOf('quarter', pr.start, s.fy_start_month).key;
            if (st.freeze_per_quarter > 0 && !frozenIn.has(q)) { frozenIn.add(q); continue; }
            run = 0;
          }
          const keys = new Set([...entitled, ...(await ctx.db.all('SELECT DISTINCT period_key k FROM reward WHERE company_id=? AND person_id=? AND group_key LIKE ?', company.id, id, `streak:${st.id}:%`)).map((x) => x.k)]);
          for (const k of keys) {
            if (!windowKeys.has(k)) continue; // older than the window: left as it was paid, never settled to 0
            const pr = periods.find((x) => x.key === k);
            const out = await safeSettle(ctx, company, report, { person, kind: 'streak', groupKey: `streak:${st.id}:${k}`, periodKey: k, entitled: entitled.has(k) ? st.bonus : 0, at: pr.end - 1, label: t.name });
            report.streaks++; report.paid += out.paid; report.reversed += out.reversed;
          }
        }
      }
    }
  }
  if (report.paid || report.reversed || report.errors || report.newly_blocked || report.unblocked) await commit(ctx, company.id, 'system', 'settle', report, []); // a close that changed nothing leaves no line
  return report;
}

/** Worst-case cost before publishing: all rates at expected volume, all tiers, streaks, team bonuses and the top of the bonus range. */
export async function simulateBudget(ctx, company, { people, perPerson = {} }) {
  const s = settingsOf(company);
  const cards = await ctx.db.all('SELECT * FROM rate_card WHERE company_id = ? AND active_to IS NULL', company.id);
  let perHead = 0, tierMax = 0, streakMax = 0;
  // The dice mode is a property of the season being costed (the one in force or the next one), not of the company default.
  const se = await ctx.db.first("SELECT mode FROM season WHERE company_id = ? AND status != 'closed' AND ends_at > ? ORDER BY (status = 'published') DESC, starts_at LIMIT 1", company.id, ctx.now());
  const dice = (se?.mode ?? s.mode) === 'dice' ? 1 : 0;
  for (const c of cards) {
    const vol = perPerson[`${c.event_type}:${c.stage}`] ?? 0;
    let amt = c.credits * vol;
    if (c.cap_month > 0) amt = Math.min(amt, c.cap_month);
    perHead += dice ? Math.ceil(amt * (1 + s.bonus_max_pct / 100)) : amt;
  }
  for (const t of await ctx.db.all('SELECT * FROM period_target WHERE company_id = ?', company.id)) {
    const top = (await tiersOf(ctx, t.id)).at(-1)?.bonus ?? 0;
    tierMax += t.scope === 'person' ? top * people : top;
  }
  for (const st of await ctx.db.all('SELECT * FROM streak WHERE company_id = ?', company.id)) streakMax += st.bonus * people;
  const worst = perHead * people + tierMax + streakMax;
  return { worstCase: worst, perHead, tierMax, streakMax, usd: worst / s.credits_per_usd };
}
