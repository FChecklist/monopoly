// Rewards: the one place the game decides to pay credits, and the one place it calls the provider to do it.
// A reward row is a decision plus a receipt. It is never a balance. Money moves only inside the provider.
//
// Race safety: every cap and the season budget are checked INSIDE the guarded INSERT, in the same batch that
// writes the row. Two writers cannot both pass a check that only one of them fits under. A guard that fails
// means "someone else got there first": the numbers are read again and the decision is made again.
import { settingsOf, DEFAULTS } from './config.js';
import { commit } from './audit.js';
import { newId, monthKey, dayKey, DAY } from './util.js';
import { ProviderError, RETRIABLE_CODES } from './provider/errors.js';

const COUNT = "('queued','sent','waiting','recorded')";
const FUNDED = "('queued','sent')";
export const MAX_CAP = 1_000_000; // no cap can be set above this, and a person/season/period cap can never be "off"

export async function seasonAt(ctx, companyId, at) {
  return ctx.db.first("SELECT * FROM season WHERE company_id = ? AND status = 'published' AND starts_at <= ? AND ends_at > ? ORDER BY starts_at DESC LIMIT 1", companyId, at, at);
}
const sum = async (ctx, sql, ...p) => (await ctx.db.first(sql, ...p))?.s ?? 0;
const one = async (ctx, sql, ...p) => Object.values((await ctx.db.first(sql, ...p)) ?? { v: 0 })[0] ?? 0;

/** Person, season and period caps: 0, negative or junk falls back to the default. Never unlimited, never above MAX_CAP. */
export function capOf(s, key) {
  const v = Number(s[key]);
  return Math.min(MAX_CAP, Number.isInteger(v) && v > 0 ? v : DEFAULTS[key]);
}
/** A rate-card row cap: 0 is the schema default and means "this row has no cap of its own" (person and season caps still apply). */
const rowCap = (v) => { v = Number(v); return Number.isInteger(v) && v > 0 ? Math.min(v, MAX_CAP) : 0; };

export async function accountRef(ctx, company, person) {
  if (person.provider_account_ref) return ctx.unseal(person.provider_account_ref);
  const email = await ctx.unseal(person.email_sealed);
  const { account_ref } = await ctx.provider(company).ensureAccount({ externalRef: person.id, email });
  await ctx.db.run('UPDATE app_user SET provider_account_ref = ? WHERE id = ?', await ctx.seal(account_ref), person.id);
  return account_ref;
}

const fundedSql = 'SELECT COALESCE(SUM(amount),0) FROM reward WHERE company_id=? AND season_id=? AND amount>0 AND state IN ' + FUNDED;

/** Pending corrections come out of a reward as a smaller credit (never more than offset_max_pct of one reward). */
async function takesFor(ctx, company, personId, amount, s) {
  let room = Math.floor((amount * s.offset_max_pct) / 100), offset = 0;
  const takes = [];
  for (const c of await ctx.db.all("SELECT * FROM correction WHERE company_id=? AND person_id=? AND state='open' ORDER BY created_at", company.id, personId)) {
    if (room <= 0) break;
    const t = Math.min(room, c.amount - c.recovered);
    if (t > 0) { takes.push([c.id, t]); offset += t; room -= t; }
  }
  return { offset, takes };
}
// A correction is never taken out of a reversal or out of credits that are being handed back (penalty_return).
const NO_TAKE = new Set(['reversal', 'penalty_return']);
const takeGuard = (takes) => takes.map(([cid, t]) => ({ sql: "EXISTS (SELECT 1 FROM correction WHERE id=? AND state='open' AND recovered + ? <= amount)", params: [cid, t] }));
const takeStmts = (takes, rewardId, extraWhere = '', extraParams = []) => takes.flatMap(([cid, t]) => [
  [`UPDATE correction SET recovered = recovered + ? WHERE id = ? AND state='open' AND recovered + ? <= amount AND EXISTS (SELECT 1 FROM reward WHERE id = ?)${extraWhere}`, t, cid, t, rewardId, ...extraParams],
  ["UPDATE correction SET state = 'cleared' WHERE id = ? AND recovered >= amount", cid],
]);

/**
 * Decide and queue one reward, with every cap applied, then try to send it.
 * p: { person, kind, amount, idem, groupKey, periodKey, at, eventId, card, capMonth, capDay, capEvent, periodBonus, reserve, note, actor, bypassCaps }
 *   reserve: extra credits that must still fit in the season budget after this reward (the top of a dice bonus).
 * Returns { paid, reason, reward }.
 */
const replayOf = (r) => ['failed', 'void'].includes(r.state) ? { paid: 0, reason: r.state + '_before', replay: true, reward: r } : { paid: r.amount, replay: true, reward: r };

export async function grant(ctx, company, p) {
  const s = settingsOf(company);
  const found = await ctx.db.first('SELECT * FROM reward WHERE idem_key = ?', p.idem);
  if (found) return ['failed', 'void'].includes(found.state) ? { paid: 0, reason: found.state + '_before', replay: true, reward: found } : { paid: found.amount, replay: true, reward: found };
  if (!Number.isInteger(p.amount) || p.amount <= 0) return { paid: 0, reason: 'nothing_to_pay' };
  // Credits handed back (penalty_return) never wait for a season or budget and never count against them: they are the person's own credits.
  const exempt = p.kind === 'penalty_return';
  const season = exempt ? null : await seasonAt(ctx, company.id, p.at);
  const mk = monthKey(p.at), dk = dayKey(p.at);
  const reserve = Math.max(0, p.reserve | 0);
  for (let attempt = 0; attempt < 30; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, Math.min(attempt, 8)));
    let room = p.amount;
    const why = [];
    const caps = []; // {sql, params, cap}: "what is used" query plus its limit; re-checked inside the INSERT
    const clamp = (cap, used, name) => { if (cap - used < room) { room = cap - used; why.push(name); } };
    if (!p.bypassCaps) {
      if (p.capEvent > 0) clamp(Math.min(p.capEvent, MAX_CAP), 0, 'event_cap');
      const rm = rowCap(p.capMonth), rd = rowCap(p.capDay);
      if (p.groupKey && rm) caps.push({ name: 'row_month_cap', cap: rm, sql: `SELECT COALESCE(SUM(amount),0) FROM reward WHERE company_id=? AND person_id=? AND group_key=? AND month_key=? AND state IN ${COUNT}`, params: [company.id, p.person.id, p.groupKey, mk] });
      if (p.groupKey && rd) caps.push({ name: 'row_day_cap', cap: rd, sql: `SELECT COALESCE(SUM(amount),0) FROM reward WHERE company_id=? AND person_id=? AND group_key=? AND day_key=? AND state IN ${COUNT}`, params: [company.id, p.person.id, p.groupKey, dk] });
      // Period bonuses sit under their own cap and are exempt from the per-month cap; they still count to the season cap.
      if (!p.periodBonus) caps.push({ name: 'person_month_cap', cap: capOf(s, 'cap_person_month'), sql: `SELECT COALESCE(SUM(amount),0) FROM reward WHERE company_id=? AND person_id=? AND month_key=? AND state IN ${COUNT}`, params: [company.id, p.person.id, mk] });
      if (season) caps.push({ name: 'season_cap', cap: capOf(s, 'cap_person_season'), sql: `SELECT COALESCE(SUM(amount),0) FROM reward WHERE company_id=? AND person_id=? AND season_id=? AND state IN ${COUNT}`, params: [company.id, p.person.id, season.id] });
      if (p.periodBonus) caps.push({ name: 'period_bonus_cap', cap: capOf(s, 'cap_period_bonus_person_period'), sql: `SELECT COALESCE(SUM(amount),0) FROM reward WHERE company_id=? AND person_id=? AND period_key=? AND kind IN ('tier','streak','team') AND state IN ${COUNT}`, params: [company.id, p.person.id, p.periodKey ?? ''] });
    }
    for (const c of caps) clamp(c.cap, await one(ctx, c.sql, ...c.params), c.name);
    if (room <= 0) return { paid: 0, reason: why[0] ?? 'cap_reached' };
    const amount = room;

    // Budget: a reward is never promised from an empty budget. No published season = it waits (and is fully re-checked at release).
    let state = 'queued', funded = 0;
    if (exempt) state = 'queued';
    else if (!season) state = 'waiting';
    else {
      funded = await one(ctx, fundedSql, company.id, season.id);
      if (funded + amount + reserve > season.budget) state = 'waiting';
    }
    let offset = 0, takes = [];
    if (state === 'queued' && !NO_TAKE.has(p.kind)) ({ offset, takes } = await takesFor(ctx, company, p.person.id, amount, s));

    const guards = caps.map((c) => ({ sql: `(${c.sql}) + ? <= ?`, params: [...c.params, amount, c.cap] }));
    if (state === 'queued' && season) guards.push({ sql: `(${fundedSql}) + ? <= ?`, params: [company.id, season.id, amount + reserve, season.budget] });
    guards.push(...takeGuard(takes));
    const id = newId('rw'), sent = amount - offset;
    const noteJson = JSON.stringify({ offset, takes, note: p.note ?? null, at: p.at, bypass: !!p.bypassCaps, periodBonus: !!p.periodBonus });
    const cols = [id, company.id, p.person.id, p.kind, p.groupKey ?? null, p.idem, amount, p.periodKey ?? null, mk, dk, season?.id ?? null, p.eventId ?? null, p.card?.id ?? null, p.card?.version ?? null, state, noteJson, ctx.now(), sent];
    const stmts = [[
      `INSERT INTO reward (id, company_id, person_id, kind, group_key, idem_key, amount, period_key, month_key, day_key, season_id, event_id, rate_card_id, rate_version, state, note, created_at, sent_amount)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guards.map((g) => g.sql).join(' AND ') || '1=1'}`,
      ...cols, ...guards.flatMap((g) => g.params)]];
    stmts.push(...takeStmts(takes, id));
    let res;
    try {
      res = await commit(ctx, company.id, p.actor ?? 'system', 'reward.create', { id, person: p.person.id, kind: p.kind, amount, state, offset, idem: p.idem, card: p.card?.id ?? null, version: p.card?.version ?? null, capped: why }, stmts, { onlyIf: { sql: 'SELECT 1 FROM reward WHERE id = ?', params: [id] } }); // no audit line when a guard lost the race
    } catch (e) {
      if (/idem_key/i.test(String(e?.message))) { const r = await ctx.db.first('SELECT * FROM reward WHERE idem_key = ?', p.idem); return replayOf(r); }
      if (/audit chain is busy/i.test(String(e?.message))) continue; // many writers at once: read the numbers again and retry
      throw e;
    }
    if (res[0].changes === 0) { // a guard failed: somebody else got there first. Read the numbers again.
      const r = await ctx.db.first('SELECT * FROM reward WHERE idem_key = ?', p.idem);
      if (r) return { paid: r.amount, replay: true, reward: r };
      continue;
    }
    const reward = await ctx.db.first('SELECT * FROM reward WHERE id = ?', id);
    if (state === 'queued') {
      const sentRow = await sendReward(ctx, company, reward);
      if (sentRow.state === 'failed') return { paid: 0, reason: sentRow.last_error ?? 'failed', failed: true, reward: sentRow, capped: why }; // a permanent provider error: nothing was paid
      return { paid: amount, reward: sentRow, capped: why };
    }
    return { paid: amount, reward, waiting: true, capped: why };
  }
  return { paid: 0, reason: 'busy' };
}

// Codes that describe the provider or its configuration, not this person's account: never a reason to fail a reward for good.
// insufficient_credits on a CREDIT call can only mean the tenant side is out of funds (API.md has no person-level 402 on /v1/credit): it waits, it never fails the row.
export const TRANSIENT = new Set([...RETRIABLE_CODES, 'unsupported', 'insufficient_credits']);
export const isTransient = (code) => TRANSIENT.has(code) || /^(5\d\d|http_5\d\d)$/.test(String(code));
// NOTE: 'cap_reached' (a Moneypenny rule cap) is deliberately PERMANENT for the row (it fails visibly, open_failed_rewards, and an admin can revive it after raising the cap).
/** Send one queued reward to the provider. Safe to repeat: the provider replays the first answer for the same key. */
export async function sendReward(ctx, company, r) {
  if (r.state !== 'queued') return r;
  if (r.sent_amount === 0) { // fully taken by a pending correction: nothing to send
    await ctx.db.run("UPDATE reward SET state='sent', provider_ref='offset', sent_at=? WHERE id=? AND state='queued'", ctx.now(), r.id);
    return ctx.db.first('SELECT * FROM reward WHERE id = ?', r.id);
  }
  const person = await ctx.db.first('SELECT * FROM app_user WHERE id = ?', r.person_id);
  const season = r.season_id ? await ctx.db.first('SELECT * FROM season WHERE id = ?', r.season_id) : null;
  // Mark the attempt BEFORE the call. If we crash between the provider crediting and our receipt, attempts > 0 tells
  // everybody this credit may already exist at the provider, so the row is never voided, only sent and then reversed.
  // If this changes no row, somebody (a void, or another sender) got there first: the provider is NOT called.
  const marked = await ctx.db.run("UPDATE reward SET attempts = attempts + 1 WHERE id = ? AND state = 'queued'", r.id);
  if (marked.changes === 0) return ctx.db.first('SELECT * FROM reward WHERE id = ?', r.id);
  try {
    let prov;
    try { prov = ctx.provider(company); } catch (e) { // whatever the provider setup says (missing key, bad URL, unknown provider) is OUR configuration: the row waits, it never fails
      throw e instanceof ProviderError && !(e.retriable || isTransient(e.code)) ? new ProviderError('misconfigured', e.message) : e;
    }
    const ref = await accountRef(ctx, company, person);
    const caps = await prov.capabilities();
    const res = await prov.credit({ accountRef: ref, amount: r.sent_amount, fromHoldId: caps.hold ? season?.hold_id : undefined, expiresAt: null, reasonCode: r.kind, ref: r.id, idem: r.idem_key });
    const got = Number.isInteger(res.granted) && res.granted > 0 && res.granted < r.sent_amount ? res.granted : r.sent_amount; // partial grant is recorded as partial
    await ctx.db.run("UPDATE reward SET state='sent', provider_ref=?, sent_at=?, sent_amount=?, last_error=? WHERE id=? AND state='queued'", res.entry_id ?? r.idem_key, ctx.now(), got, got < r.sent_amount ? 'partial_grant' : null, r.id);
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    if (e.retriable || isTransient(e.code)) { // configuration / provider-state problems are never permanent: the row stays queued and every tick retries it
      await ctx.db.run('UPDATE reward SET last_error=? WHERE id=?', e.code, r.id);
      // One audit line per CHANGE of code (not per try), so a long outage never grows the audit chain.
      if (r.last_error !== e.code) { try { await commit(ctx, company.id, 'system', 'reward.send_error', { id: r.id, code: e.code }); } catch { /* the next try writes it */ } }
    }
    else if (e.code === 'insufficient_budget' || e.code === 'hold_expired') await backToWaiting(ctx, company, r, e.code);
    else await failReward(ctx, company, r, e.code);
  }
  return ctx.db.first('SELECT * FROM reward WHERE id = ?', r.id);
}

/** Back to 'waiting': the corrections it had taken go back first (guarded on the row still being queued) and the note forgets them, so the release takes again from a clean state. */
async function backToWaiting(ctx, company, r, code) {
  const cur = await ctx.db.first('SELECT note FROM reward WHERE id = ?', r.id);
  const n = JSON.parse(cur?.note || r.note || '{}');
  const own = "EXISTS (SELECT 1 FROM reward WHERE id = ? AND state = 'queued' AND note IS ?)"; // and the note is still the one we read
  const stmts = [];
  for (const [cid, t] of n.takes ?? []) stmts.push([`UPDATE correction SET recovered = MAX(0, recovered - ?), state = CASE WHEN state = 'cleared' THEN 'open' ELSE state END WHERE id = ? AND ${own}`, t, cid, r.id, cur?.note ?? null]);
  stmts.push(["UPDATE reward SET state='waiting', last_error=?, sent_amount=amount, note=? WHERE id=? AND state='queued' AND note IS ?", code, JSON.stringify({ ...n, offset: 0, takes: [] }), r.id, cur?.note ?? null]);
  await commit(ctx, company.id, 'system', 'reward.waiting', { id: r.id, code }, stmts, { onlyIfChanged: true });
}

/**
 * A reward fails for good ONLY from a definitive 4xx rejection Moneypenny gave for THIS call (API.md: "a failed call leaves no trace, so its key can be reused").
 * Config, auth, network, 5xx, timeout and bad-body errors are transient and never reach here. So a revived row reuses the SAME idempotency key:
 * if the first credit had somehow landed, the provider replays it and nothing is paid twice.
 */
async function failReward(ctx, company, r, code) {
  const n = JSON.parse(r.note || '{}');
  // Give the corrections back first, guarded on the row still being queued, then flip the row. All or nothing.
  const own = "EXISTS (SELECT 1 FROM reward WHERE id = ? AND state = 'queued')";
  const stmts = [];
  for (const [cid, t] of n.takes ?? []) stmts.push([`UPDATE correction SET recovered = MAX(0, recovered - ?), state = CASE WHEN state = 'cleared' THEN 'open' ELSE state END WHERE id = ? AND ${own}`, t, cid, r.id]);
  stmts.push(["UPDATE reward SET state='failed', last_error=? WHERE id=? AND state='queued'", code, r.id]);
  await commit(ctx, company.id, 'system', 'reward.failed', { id: r.id, code }, stmts);
}

const REVIVABLE = "company_id=? AND state='failed' AND amount>0 AND kind NOT IN ('reversal','penalty_return') AND (event_id IS NOT NULL OR attempts > 1) AND (event_id IS NULL OR EXISTS (SELECT 1 FROM event e WHERE e.id = reward.event_id AND e.status = 'applied'))"; // a reward of an event that was reversed is never revived // period rows with one try revive themselves under a new key (x<n>) after the block time
const MAX_REVIVES = 5;
/** Failed event rewards (and period rows tried more than once) that wait for an admin. Shown as open_failed_rewards in the overview. */
export const openFailedRewards = async (ctx, companyId) => (await ctx.db.first('SELECT COUNT(*) n FROM reward WHERE ' + REVIVABLE, companyId)).n;
/**
 * Admin helper, like clearBlocked: put every failed event reward back to 'waiting'; releaseWaiting then runs the whole check again and sends it.
 * It keeps the SAME idempotency key (see failReward), so it cannot pay twice. A row is revived at most MAX_REVIVES times.
 */
export async function reviveFailedRewards(ctx, company, actor = 'admin') {
  let revived = 0;
  for (const r of await ctx.db.all('SELECT * FROM reward WHERE ' + REVIVABLE + ' ORDER BY created_at', company.id)) {
    const n = JSON.parse(r.note || '{}');
    if ((n.revives ?? 0) >= MAX_REVIVES) continue;
    const note = JSON.stringify({ ...n, offset: 0, takes: [], revives: (n.revives ?? 0) + 1 });
    const stmts = [["UPDATE reward SET state='waiting', last_error='revived', sent_amount=amount, note=? WHERE id=? AND state='failed'", note, r.id]];
    const res = await commit(ctx, company.id, actor, 'reward.revived', { id: r.id, was: r.last_error }, stmts, { onlyIfChanged: true });
    if (res[res.length - 1].changes > 0) revived++;
  }
  const rel = revived ? await releaseWaiting(ctx, company) : { moved: 0, voided: 0 };
  return { revived, ...rel };
}

/** A failed event reward whose event is being reversed: nothing was ever sent for it (failed = definitive rejection), so it is voided, not revived later. */
export async function voidFailedReward(ctx, company, r, reason = 'event_reversed') {
  await commit(ctx, company.id, 'system', 'reward.void', { orig: r.id, reason }, [["UPDATE reward SET state='void', reversed=1, last_error=? WHERE id=? AND state='failed'", reason, r.id]], { onlyIfChanged: true });
}

/** A reverse call is about to go out: leave a marker FIRST (once per row), so a lost answer is finished before the row is trusted as paid. */
async function markReversePending(ctx, company, r, reason, eventId) {
  if (await ctx.db.first("SELECT 1 x FROM audit WHERE company_id = ? AND action = 'reward.reverse_pending' AND instr(data, ?) > 0", company.id, `"id":"${r.id}"`)) return;
  await commit(ctx, company.id, 'system', 'reward.reverse_pending', { id: r.id, reason: String(reason ?? 'reversal').slice(0, 80), event: eventId ?? null });
}
/** Re-run the idempotent reverse (key rev:<entry>) of rows of this group whose reverse call may have been cut short, before anybody counts them as paid. */
export async function healPendingReverses(ctx, company, personId, groupKey) {
  let healed = 0;
  for (const r of await ctx.db.all("SELECT * FROM reward WHERE company_id=? AND person_id=? AND group_key=? AND state='sent' AND reversed=0 AND amount>0 AND kind != 'reversal'", company.id, personId, groupKey)) {
    const m = await ctx.db.first("SELECT data FROM audit WHERE company_id = ? AND action = 'reward.reverse_pending' AND instr(data, ?) > 0 ORDER BY n DESC LIMIT 1", company.id, `"id":"${r.id}"`);
    if (!m) continue;
    let d = {}; try { d = JSON.parse(m.data); } catch { /* default reason */ }
    const o = await reverseReward(ctx, company, r, { reason: d.reason ?? 'reversal', actor: 'system', eventId: d.event ?? null });
    if (!o.skipped) healed += r.amount;
  }
  return healed;
}

/** Retry everything that is "on its way". Run by the admin button and by the scheduled trigger. */
export async function retryQueued(ctx, company, limit = 100) {
  let sent = 0, stuck = 0;
  limit = Math.max(1, Math.min(1000, Number(limit) | 0 || 100));
  for (const r of await ctx.db.all("SELECT * FROM reward WHERE company_id=? AND state='queued' ORDER BY attempts, created_at LIMIT ?", company.id, limit)) { // fewest tries first: a row that can never be sent cannot starve newer ones
    const out = await sendReward(ctx, company, r);
    if (out.state === 'sent') sent++;
    else if (ctx.now() - r.created_at > 24 * 3600_000) stuck++;
  }
  await releaseClosedHolds(ctx, company);
  return { sent, stuck };
}

/**
 * A season closed while some of its rewards were still queued (provider outage) keeps its budget hold, because those rewards draw from it.
 * Once none is queued any more the hold is released and forgotten. Idempotent; a provider problem just leaves it for the next tick.
 */
/** Give a closed season's hold back and write the line. Returns the amount, or null while the provider cannot do it (the tick tries again). */
export async function releaseSeasonHold(ctx, company, se) {
  let amount = 0;
  try {
    const prov = ctx.provider(company);
    if ((await prov.capabilities()).hold) amount = (await prov.releaseHold({ holdId: se.hold_id })).released ?? 0;
  } catch (e) { if (!(e instanceof ProviderError)) throw e; if (e.code !== 'hold_expired') return null; }
  await commit(ctx, company.id, 'system', 'season.hold_released', { id: se.id });
  return amount;
}
export async function releaseClosedHolds(ctx, company) {
  let released = 0;
  const pending = await ctx.db.all("SELECT s.* FROM season s WHERE s.company_id=? AND s.status='closed' AND s.hold_id IS NOT NULL AND EXISTS (SELECT 1 FROM audit a WHERE a.company_id=s.company_id AND a.action='season.close' AND instr(a.data, '\"deferred\":true') > 0 AND instr(a.data, '\"id\":\"' || s.id || '\"') > 0) AND NOT EXISTS (SELECT 1 FROM audit a WHERE a.company_id=s.company_id AND a.action='season.hold_released' AND instr(a.data, '\"id\":\"' || s.id || '\"') > 0)", company.id);
  for (const se of pending) {
    if ((await ctx.db.first("SELECT COUNT(*) n FROM reward WHERE season_id=? AND state='queued'", se.id)).n > 0) continue;
    if ((await releaseSeasonHold(ctx, company, se)) !== null) released++;
  }
  return released;
}

/**
 * After the admin raises the budget, or a season is published, move waiting rewards to queued while the budget lasts.
 * The WHOLE check is run again here: the season for the reward's own date, the person-season cap, the season budget,
 * and any pending correction. A reward that can never fit its season cap is voided (nothing was ever sent for it).
 */
export async function releaseWaiting(ctx, company) {
  const s = settingsOf(company);
  const lag = s.late_close_days * DAY;
  let moved = 0, voided = 0;
  for (const r of await ctx.db.all("SELECT * FROM reward WHERE company_id=? AND state='waiting' ORDER BY created_at, rowid", company.id)) {
    const n = JSON.parse(r.note || '{}');
    const at = n.at ?? r.created_at;
    const own = r.season_id ? await ctx.db.first('SELECT * FROM season WHERE id=?', r.season_id) : null;
    const season = own ? (own.status === 'published' ? own : null) : r.season_id ? null : await seasonAt(ctx, company.id, at);
    const neverSent = r.attempts === 0 || r.last_error === 'insufficient_budget' || r.last_error === 'hold_expired' || r.last_error === 'revived'; // a revived row failed for good first: nothing was ever sent for it
    if (!season) {
      // A row whose season is closed, or that no published season covers, can never be released. After the late-event
      // window it is voided with a plain reason instead of sitting here forever (nothing was ever sent for it).
      if (neverSent && ctx.now() - at > lag) {
        let reason = null;
        if (own && own.status === 'closed') reason = 'season_closed';
        else if (!own && !(await ctx.db.first("SELECT id FROM season WHERE company_id=? AND status != 'closed' AND starts_at <= ? AND ends_at > ?", company.id, at, at))) reason = 'no_season';
        if (reason && r.kind !== 'penalty_return' && (await voidWaiting(ctx, company, r, n, reason))) voided++;
      }
      continue;
    }
    const seasonCap = capOf(s, 'cap_person_season');
    const seasonSql = `SELECT COALESCE(SUM(amount),0) FROM reward WHERE company_id=? AND person_id=? AND season_id=? AND state IN ${COUNT} AND id != ?`;
    const seasonParams = [company.id, r.person_id, season.id, r.id];
    if (!n.bypass && (await one(ctx, seasonSql, ...seasonParams)) + r.amount > seasonCap) {
      if (neverSent && (await voidWaiting(ctx, company, r, n, 'season_cap'))) voided++;
      continue;
    }
    if ((await one(ctx, fundedSql, company.id, season.id)) + r.amount > season.budget) continue;
    const { offset, takes } = NO_TAKE.has(r.kind) ? { offset: 0, takes: [] } : await takesFor(ctx, company, r.person_id, r.amount, s);
    const guards = [{ sql: "EXISTS (SELECT 1 FROM reward WHERE id=? AND state='waiting')", params: [r.id] }, { sql: `(${fundedSql}) + ? <= ?`, params: [company.id, season.id, r.amount, season.budget] }];
    if (!n.bypass) guards.push({ sql: `(${seasonSql}) + ? <= ?`, params: [...seasonParams, r.amount, seasonCap] });
    guards.push(...takeGuard(takes));
    const where = guards.map((g) => g.sql).join(' AND '), gp = guards.flatMap((g) => g.params);
    // The reward moves FIRST, guarded on everything (including each take still fitting). The takes then apply only if THAT
    // statement just wrote this exact note (it carries a one-time token), so reward and takes are all-or-nothing and a
    // lost race (or a guard that fails) leaves the corrections untouched. The audit line is written only if the reward moved.
    const newNote = JSON.stringify({ ...n, offset, takes, rel: newId('rl') });
    const stmts = [[`UPDATE reward SET state='queued', season_id=?, sent_amount=?, note=? WHERE id=? AND ${where}`, season.id, r.amount - offset, newNote, r.id, ...gp]];
    for (const [cid, t] of takes) {
      stmts.push(["UPDATE correction SET recovered = recovered + ? WHERE id = ? AND state='open' AND recovered + ? <= amount AND EXISTS (SELECT 1 FROM reward WHERE id = ? AND state='queued' AND note = ?)", t, cid, t, r.id, newNote]);
      stmts.push(["UPDATE correction SET state = 'cleared' WHERE id = ? AND recovered >= amount", cid]);
    }
    const res = await commit(ctx, company.id, 'system', 'reward.release', { id: r.id, season: season.id, offset }, stmts, { onlyIf: { sql: 'SELECT 1 FROM reward WHERE id = ? AND note = ?', params: [r.id, newNote] } });
    if (res[0].changes === 0) continue;
    await sendReward(ctx, company, await ctx.db.first('SELECT * FROM reward WHERE id=?', r.id));
    moved++;
  }
  return { moved, voided };
}

/** Void a waiting row that can never be released. Corrections it had taken go back. No audit line if somebody else got there first. */
async function voidWaiting(ctx, company, r, n, reason) {
  const live = "EXISTS (SELECT 1 FROM reward WHERE id=? AND state='waiting')";
  const stmts = [];
  for (const [cid, t] of n.takes ?? []) stmts.push([`UPDATE correction SET recovered = MAX(0, recovered - ?), state = CASE WHEN state = 'cleared' THEN 'open' ELSE state END WHERE id = ? AND ${live}`, t, cid, r.id]);
  stmts.push(["UPDATE reward SET state='void', reversed=1, last_error=? WHERE id=? AND state='waiting'", reason, r.id]); // last statement: onlyIfChanged is exact
  const res = await commit(ctx, company.id, 'system', 'reward.void', { orig: r.id, reason }, stmts, { onlyIfChanged: true });
  return res[res.length - 2].changes > 0;
}

/**
 * Reverse a reward (cancelled lead, cancelled game, lost tier). Unsent rewards are simply voided.
 * Sent ones are reversed at the provider if it can; whatever it could not take back becomes a pending correction,
 * which later rewards pay down as a smaller credit. It is never a debt on wages and never a penalty.
 * A row that was ever offered to the provider (attempts > 0) is never voided: it is sent (the provider replays the
 * first answer for the same key) and then reversed.
 */
export async function reverseReward(ctx, company, r, { reason, actor = 'system', eventId = null }) {
  if (r.reversed || r.amount <= 0 || r.kind === 'reversal') return { reversed: 0, owed: 0, skipped: true };
  const base = { reason, orig: r.id, amount: r.amount };
  if (r.state === 'queued' && r.attempts > 0) {
    r = await sendReward(ctx, company, r);
    if (r.state === 'queued') return { reversed: 0, owed: 0, skipped: true, pending: true }; // still not confirmed: try again next close
  }
  if (r.state !== 'sent') {
    if (!['queued', 'waiting'].includes(r.state)) return { reversed: 0, owed: 0, skipped: true };
    const n = JSON.parse(r.note || '{}');
    const live = "EXISTS (SELECT 1 FROM reward WHERE id=? AND state IN ('queued','waiting') AND reversed=0 AND (attempts=0 OR state='waiting'))";
    const stmts = [];
    for (const [cid, t] of n.takes ?? []) stmts.push([`UPDATE correction SET recovered = MAX(0, recovered - ?), state = CASE WHEN state = 'cleared' THEN 'open' ELSE state END WHERE id = ? AND ${live}`, t, cid, r.id]);
    stmts.push(["UPDATE reward SET state='void', reversed=1, last_error=NULL WHERE id=? AND state IN ('queued','waiting') AND reversed=0 AND (attempts=0 OR state='waiting')", r.id]); // a void by reversal carries NO last_error (a stale insufficient_budget/hold_expired must not look like a system void)
    await commit(ctx, company.id, actor, 'reward.void', base, stmts, { onlyIfChanged: true }); // the reward update is the last statement: no line if it lost a race
    const now = await ctx.db.first('SELECT state FROM reward WHERE id=?', r.id);
    if (now.state === 'void') return { reversed: r.amount, owed: 0, voided: true };
    r = await ctx.db.first('SELECT * FROM reward WHERE id=?', r.id);
    if (r.state === 'queued') return { reversed: 0, owed: 0, skipped: true, pending: true };
    if (r.state !== 'sent') return { reversed: 0, owed: 0, skipped: true };
  }
  const person = await ctx.db.first('SELECT * FROM app_user WHERE id=?', r.person_id);
  let reversed = 0, owed = r.sent_amount ?? r.amount;
  if (r.provider_ref && r.provider_ref !== 'offset') {
    let prov, canReverse;
    // A provider/config problem (unsupported, misconfigured, unauthorized, down) is never permanent for a reversal: the row stays due and the next tick retries.
    try { prov = ctx.provider(company); canReverse = (await prov.capabilities()).reverse; } catch (e) { if (!(e instanceof ProviderError)) throw e; return { reversed: 0, owed: 0, skipped: true, pending: true, code: e.code }; }
    if (canReverse) {
      try {
        await markReversePending(ctx, company, r, reason, eventId);
        const out = await prov.reverse({ entryId: r.provider_ref, reasonCode: 'reversal', idem: 'rev:' + r.provider_ref });
        reversed = out.reversed; owed = out.owed ?? Math.max(0, (r.sent_amount ?? r.amount) - reversed);
      } catch (e) { if (!(e instanceof ProviderError)) throw e; if (e.retriable) throw e; }
    }
  } else owed = 0; // fully offset: nothing was ever sent
  const stmts = [
    ["INSERT INTO reward (id, company_id, person_id, kind, group_key, idem_key, amount, period_key, month_key, day_key, season_id, event_id, state, note, created_at, sent_amount) VALUES (?,?,?,'reversal',?,?,?,?,?,?,?,?, 'recorded', ?, ?, 0)",
      newId('rw'), company.id, r.person_id, r.group_key, 'rev:' + r.id, -r.amount, r.period_key, r.month_key, r.day_key, r.season_id, eventId ?? r.event_id, JSON.stringify({ reason, orig: r.id, owed }), ctx.now()],
    ['UPDATE reward SET reversed = 1 WHERE id = ?', r.id],
  ];
  // The corrections this reward had taken come back: the person earned nothing, so what was written off is owed again.
  for (const [cid, t] of JSON.parse(r.note || '{}').takes ?? []) stmts.push(["UPDATE correction SET recovered = MAX(0, recovered - ?), state = CASE WHEN state = 'cleared' THEN 'open' ELSE state END WHERE id = ?", t, cid]);
  if (owed > 0) stmts.push(["INSERT INTO correction (id, company_id, person_id, amount, state, reason, event_id, created_at) VALUES (?,?,?,?, 'open', ?, ?, ?)", newId('cr'), company.id, r.person_id, owed, reason, eventId ?? r.event_id, ctx.now()]);
  try {
    await commit(ctx, company.id, actor, 'reward.reverse', { ...base, reversed, owed, person: person?.id }, stmts);
  } catch (e) { if (/idem_key/i.test(String(e?.message))) return { reversed: 0, owed: 0, skipped: true }; throw e; }
  return { reversed, owed };
}

/** Net credits earned by a person in a month, from our own decision rows (not a balance). */
export const earnedNet = (ctx, companyId, personId, mk) =>
  sum(ctx, `SELECT SUM(amount) s FROM reward WHERE company_id=? AND person_id=? AND month_key=? AND state IN ${COUNT}`, companyId, personId, mk);
