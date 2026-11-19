// Rewards: the one place the game decides to pay credits, and the one place it calls the provider to do it.
// A reward row is a decision plus a receipt. It is never a balance. Money moves only inside the provider.
//
// Race safety: every cap and the season budget are checked INSIDE the guarded INSERT, in the same batch that
// writes the row. Two writers cannot both pass a check that only one of them fits under. A guard that fails
// means "someone else got there first": the numbers are read again and the decision is made again.
import { settingsOf, DEFAULTS } from './config.js';
import { commit } from './audit.js';
import { BudgetReached } from './budget.js';
import { newId, monthKey, dayKey, DAY, ApiError } from './util.js';
import { ProviderError, RETRIABLE_CODES } from './provider/errors.js';
import { futureOn, MAX_SINGLE_CREDIT, assertCreditAmount } from './v1.js';
import { intend, getOp, run, settleOp, unsettled, openOps } from './provider-ops.js';

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
  checkIdemKey(p.idem);
  const s = settingsOf(company);
  const found = await ctx.db.first('SELECT * FROM reward WHERE idem_key = ?', p.idem);
  if (found) return ['failed', 'void'].includes(found.state) ? { paid: 0, reason: found.state + '_before', replay: true, reward: found } : { paid: found.amount, replay: true, reward: found };
  if (!Number.isInteger(p.amount) || p.amount <= 0) return { paid: 0, reason: 'nothing_to_pay' };
  if (p.person?.erased_at) return { paid: 0, reason: 'person_erased' }; // an erased leaver is never paid: nothing is promised
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
      if (!p.periodBonus) caps.push({ name: 'person_month_cap', cap: capOf(s, 'cap_person_month'), sql: `SELECT COALESCE(SUM(amount),0) FROM reward WHERE company_id=? AND person_id=? AND month_key=? AND kind != 'penalty_return' AND state IN ${COUNT}`, params: [company.id, p.person.id, mk] });
      if (season) caps.push({ name: 'season_cap', cap: capOf(s, 'cap_person_season'), sql: `SELECT COALESCE(SUM(amount),0) FROM reward WHERE company_id=? AND person_id=? AND season_id=? AND state IN ${COUNT}`, params: [company.id, p.person.id, season.id] });
      if (p.periodBonus) caps.push({ name: 'period_bonus_cap', cap: capOf(s, 'cap_period_bonus_person_period'), sql: `SELECT COALESCE(SUM(amount),0) FROM reward WHERE company_id=? AND person_id=? AND period_key=? AND (kind IN ('tier','streak','team') OR (kind = 'reversal' AND substr(group_key, 1, instr(group_key, ':') - 1) IN ('tier','streak','team'))) AND state IN ${COUNT}`, params: [company.id, p.person.id, p.periodKey ?? ''] });
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
      if (funded + amount + reserve - (p.freed | 0) > season.budget) state = 'waiting'; // freed: what the closed old row gives back in the same batch
    }
    if (p.requireQueued && state !== 'queued') return { paid: 0, reason: 'not_payable' }; // a re-issue never creates a row that would only wait
    let offset = 0, takes = [];
    if (state === 'queued' && !NO_TAKE.has(p.kind) && !p.noTake) ({ offset, takes } = await takesFor(ctx, company, p.person.id, amount, s));

    const guards = caps.map((c) => ({ sql: `(${c.sql}) + ? <= ?`, params: [...c.params, amount, c.cap] }));
    const budgetGuard = state === 'queued' && season ? { sql: `(${fundedSql}) + ? <= ?`, params: [company.id, season.id, amount + reserve, season.budget] } : null;
    if (budgetGuard) guards.push(budgetGuard);
    guards.push(...takeGuard(takes));
    if (p.alsoGuard) guards.push(p.alsoGuard);
    if (p.paidGuard) guards.push({ sql: `(SELECT COALESCE(SUM(amount),0) FROM reward WHERE company_id = ? AND person_id = ? AND group_key = ? AND state IN ${COUNT}) = ?`, params: [company.id, p.person.id, p.groupKey, p.paidGuard.paid] }); // a period grant is made only while the group's counted total is still the one it was computed from
    if (p.alsoGuardBoth) guards.push(p.alsoGuardBoth); // a condition that must hold for the close AND the insert (person not erased, event still open)
    const id = newId('rw'), sent = amount - offset;
    const noteJson = JSON.stringify({ offset, takes, note: p.note ?? null, at: p.at, bypass: !!p.bypassCaps, periodBonus: !!p.periodBonus });
    const cols = [id, company.id, p.person.id, p.kind, p.groupKey ?? null, p.idem, amount, p.periodKey ?? null, mk, dk, season?.id ?? null, p.eventId ?? null, p.card?.id ?? null, p.card?.version ?? null, state, noteJson, ctx.now(), sent];
    // The statements that close another row ride in the SAME batch and carry the SAME budget/take guards as the insert: if the new row cannot be placed, the old row is not touched.
    // The close runs BEFORE the insert, so its budget guard counts what the close itself frees (a partial row gives its missing rest back).
    const closeGuards = guards.filter((g) => g !== p.alsoGuard && g !== budgetGuard);
    if (budgetGuard) closeGuards.push({ sql: `(${fundedSql}) + ? <= ?`, params: [company.id, season.id, amount + reserve - (p.freed | 0), season.budget] });
    const alsoStmts = (p.also ?? []).map(([sql, ...prm]) => (closeGuards.length ? [sql + ' AND ' + closeGuards.map((g) => g.sql).join(' AND '), ...prm, ...closeGuards.flatMap((g) => g.params)] : [sql, ...prm]));
    const stmts = [...alsoStmts, [
      `INSERT INTO reward (id, company_id, person_id, kind, group_key, idem_key, amount, period_key, month_key, day_key, season_id, event_id, rate_card_id, rate_version, state, note, created_at, sent_amount)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guards.map((g) => g.sql).join(' AND ') || '1=1'}`,
      ...cols, ...guards.flatMap((g) => g.params)]];
    stmts.push(...takeStmts(takes, id));
    let res;
    try {
      res = await commit(ctx, company.id, p.actor ?? 'system', 'reward.create', { id, person: p.person.id, kind: p.kind, amount, state, offset, idem: p.idem, card: p.card?.id ?? null, version: p.card?.version ?? null, capped: why, ...(p.auditExtra ?? {}) }, stmts, { onlyIf: { sql: 'SELECT 1 FROM reward WHERE id = ?', params: [id] } }); // no audit line when a guard lost the race
    } catch (e) {
      if (/idem_key/i.test(String(e?.message))) { const r = await ctx.db.first('SELECT * FROM reward WHERE idem_key = ?', p.idem); return replayOf(r); }
      if (/audit chain is busy/i.test(String(e?.message))) continue; // many writers at once: read the numbers again and retry
      throw e;
    }
    if (res[(p.also ?? []).length].changes === 0) { // a guard failed: somebody else got there first. Read the numbers again.
      const r = await ctx.db.first('SELECT * FROM reward WHERE idem_key = ?', p.idem);
      if (r) return replayOf(r);
      if (p.paidGuard) return { paid: 0, reason: 'stale' }; // the group moved under us: the caller reads it again and recomputes (never pays from an old figure)
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
/** Free text and the account reference leave the note of a row of an erased person; the marker that an earlier try may have landed stays. ONE expression for every erase path (people.js uses it too). */
export const SCRUB_NOTE_SQL = "CASE WHEN attempts > 0 THEN json_set(json_remove(COALESCE(note, '{}'), '$.acct', '$.ledger_note', '$.note', '$.inflight'), '$.maybe_landed', json('true')) ELSE json_remove(COALESCE(note, '{}'), '$.acct', '$.ledger_note', '$.note', '$.inflight') END";
export const TRANSIENT = new Set([...RETRIABLE_CODES, 'unsupported', 'insufficient_credits']);
const MAX_AMBIGUOUS_TRIES = 5;
/** Did an EARLIER try of this row happen (it may have landed)? Re-read now, not from the snapshot: an overlapping tick may have tried it meanwhile. */
async function ambiguousTry(ctx, r) {
  const f = await ctx.db.first('SELECT attempts FROM reward WHERE id = ?', r.id);
  const before = (f?.attempts ?? 1) - 1; // this try counted itself first
  return before > 0 && before < MAX_AMBIGUOUS_TRIES;
}
export const isTransient = (code) => TRANSIENT.has(code) || /^(5\d\d|http_5\d\d)$/.test(String(code));
// NOTE: 'cap_reached' (a Moneypenny rule cap) is deliberately PERMANENT for the row (it fails visibly, open_failed_rewards, and an admin can revive it after raising the cap).
/** Send one queued reward to the provider. Safe to repeat: the provider replays the first answer for the same key. */
export const SEND_COST = 9; // queries and provider calls one send needs (the attempt mark, the account, the call, the receipt)
export async function sendReward(ctx, company, r) {
  if (r.state !== 'queued') return r;
  if (ctx.budget && !ctx.budget.unlimited && ctx.budget.left() < SEND_COST) throw new BudgetReached(); // checked BEFORE the attempt is counted: a budget cut is never an attempt
  if (r.sent_amount === 0) { // fully taken by a pending correction: nothing to send
    await ctx.db.run("UPDATE reward SET state='sent', provider_ref='offset', sent_at=? WHERE id=? AND state='queued'", ctx.now(), r.id);
    return ctx.db.first('SELECT * FROM reward WHERE id = ?', r.id);
  }
  const person = await ctx.db.first('SELECT * FROM app_user WHERE id = ?', r.person_id);
  const noteNow = JSON.parse(r.note || '{}');
  if (!person || person.erased_at) { // an erased leaver is never paid: the row is closed for good (voided_erased, an audit line, skipped everywhere). If an earlier try may have landed, the line says so. // an erased leaver cannot be paid: the row is voided with a plain reason (the corrections it took go back), it never throws
    const n0 = JSON.parse(r.note || '{}');
    const own = "EXISTS (SELECT 1 FROM reward WHERE id = ? AND state = 'queued')";
    const st = [];
    for (const [cid, t] of n0.takes ?? []) st.push([`UPDATE correction SET recovered = MAX(0, recovered - ?), state = CASE WHEN state = 'cleared' THEN 'open' ELSE state END WHERE id = ? AND ${own}`, t, cid, r.id]);
    st.push(["UPDATE reward SET state='void', reversed=1, last_error='voided_erased', note = " + SCRUB_NOTE_SQL + " WHERE id=? AND state='queued'", r.id]);
    await commit(ctx, company.id, 'system', 'reward.void', { orig: r.id, reason: 'voided_erased', maybe_landed: r.attempts > 0 }, st);
    return ctx.db.first('SELECT * FROM reward WHERE id = ?', r.id);
  }
  if (r.sent_amount > MAX_SINGLE_CREDIT && company.provider === 'moneypenny') { await failReward(ctx, company, r, 'above_provider_max'); return ctx.db.first('SELECT * FROM reward WHERE id = ?', r.id); } // v1 never splits a credit and never sends one the provider would cut
  const season = r.season_id ? await ctx.db.first('SELECT * FROM season WHERE id = ?', r.season_id) : null;
  // Mark the attempt BEFORE the call. If we crash between the provider crediting and our receipt, attempts > 0 tells
  // everybody this credit may already exist at the provider, so the row is never voided, only sent and then reversed.
  // If this changes no row, somebody (a void, or another sender) got there first: the provider is NOT called.
  // The account of this first try is sealed on the row in the SAME update that counts the attempt: a crash can never leave a counted try without its account.
  let acctSealed = null;
  if (!noteNow.acct) { try { acctSealed = await ctx.seal(await accountRef(ctx, company, person), 'reward.acct:' + r.id); } catch { /* the call below reports it */ } }
  const marked = await ctx.db.run("UPDATE reward SET attempts = attempts + 1, note = CASE WHEN ? IS NOT NULL AND json_extract(COALESCE(note, '{}'), '$.acct') IS NULL THEN json_set(COALESCE(note, '{}'), '$.acct', ?) ELSE note END WHERE id = ? AND state = 'queued'", acctSealed, acctSealed, r.id);
  if (marked.changes === 0) return ctx.db.first('SELECT * FROM reward WHERE id = ?', r.id);
  let usedRef = null; const credits0 = ctx.budget?.credits ?? 0;
  try {
    let prov;
    try { prov = ctx.provider(company); } catch (e) { // whatever the provider setup says (missing key, bad URL, unknown provider) is OUR configuration: the row waits, it never fails
      throw e instanceof ProviderError && !(e.retriable || isTransient(e.code)) ? new ProviderError('misconfigured', e.message) : e;
    }
    // The same key must carry the same body: a retry uses the account of the FIRST try (kept sealed on the row), even if the e-mail changed since.
    const ref = noteNow.acct ? await ctx.unseal(noteNow.acct, 'reward.acct:' + r.id) : await accountRef(ctx, company, person);
    usedRef = ref;
    const caps = await prov.capabilities();
    const res = await prov.credit({ accountRef: ref, amount: r.sent_amount, fromHoldId: caps.hold ? season?.hold_id : undefined, expiresAt: null, reasonCode: r.kind, ref: r.id, idem: r.idem_key });
    const got = Number.isInteger(res.granted) && res.granted > 0 && res.granted < r.sent_amount ? res.granted : r.sent_amount; // partial grant is recorded as partial
    await ctx.db.run("UPDATE reward SET state='sent', provider_ref=?, sent_at=?, sent_amount=?, last_error=? WHERE id=? AND state='queued'", res.entry_id ?? r.idem_key, ctx.now(), got, got < r.sent_amount ? 'partial_grant' : null, r.id);
  } catch (e) {
    if (e instanceof BudgetReached && (ctx.budget?.credits ?? 0) === credits0) { // cut before the credit call was made: take the attempt back (on the raw port: the budget is spent)
      try { await (ctx.rawDb ?? ctx.db).run("UPDATE reward SET attempts = MAX(0, attempts - 1) WHERE id = ? AND state = 'queued'", r.id); } catch { /* the row then looks tried once: it is sent with the same key, so nothing is paid twice */ }
    }
    if (!(e instanceof ProviderError)) throw e;
    if (usedRef && !noteNow.acct && (e.retriable || isTransient(e.code) || e.code === 'duplicate' || true)) { try { await ctx.db.run("UPDATE reward SET note = json_set(COALESCE(note, '{}'), '$.acct', ?) WHERE id = ? AND json_extract(COALESCE(note, '{}'), '$.acct') IS NULL AND state = 'queued'", await ctx.seal(usedRef, 'reward.acct:' + r.id), r.id); } catch { /* the next try stores it */ } }
    if (e.code === 'duplicate') {
      // duplicate_ref: the provider already has a credit under this reference. The amount is taken ONLY from its history (ref manual:<ref>); when it cannot be confirmed the row needs an admin and is never paid again by itself.
      let line = null;
      line = (await ledgerLine(ctx, company, usedRef, r.id)).line;
      if (line && Number.isInteger(line.amount) && line.amount > 0) {
        const got = Math.min(line.amount, r.sent_amount);
        await ctx.db.run("UPDATE reward SET state='sent', provider_ref=?, sent_at=?, sent_amount=?, last_error=? WHERE id=? AND state='queued'", r.idem_key, ctx.now(), got, got < r.sent_amount ? 'partial_grant' : null, r.id);
      } else await failReward(ctx, company, r, 'duplicate_unconfirmed');
    } else if (e.retriable || isTransient(e.code)) { // configuration / provider-state problems are never permanent: the row stays queued and every tick retries it
      await ctx.db.run('UPDATE reward SET last_error=? WHERE id=?', e.code, r.id);
      // At most ONE audit line per row per day (a flapping code A,B,A,B must not write at every change), so a long outage never grows the audit chain.
      if (r.last_error !== e.code && !(await ctx.db.first("SELECT 1 x FROM audit WHERE company_id = ? AND action = 'reward.send_error' AND at > ? AND instr(data, ?) > 0", company.id, ctx.now() - DAY, `"id":"${r.id}"`))) { try { await commit(ctx, company.id, 'system', 'reward.send_error', { id: r.id, code: e.code }); } catch { /* the next try writes it */ } }
    }
    else if (e.code === 'insufficient_budget' || e.code === 'hold_expired') await backToWaiting(ctx, company, r, e.code);
    else if (await ambiguousTry(ctx, r)) {
      // An earlier try ended without an answer (it may have landed). A definitive "no" now contradicts that, so it is not believed yet: the row stays queued
      // and is tried again, up to MAX_AMBIGUOUS_TRIES; only then it fails (visible as open_failed_rewards).
      await ctx.db.run('UPDATE reward SET last_error=? WHERE id=?', 'ambiguous_' + e.code, r.id);
    } else await failReward(ctx, company, r, e.code);
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

const REVIVABLE = "company_id=? AND state='failed' AND amount>0 AND kind NOT IN ('reversal','penalty_return') AND (event_id IS NOT NULL OR attempts > 1 OR (kind IN ('tier','streak','team') AND (SELECT COUNT(*) FROM reward f WHERE f.company_id = reward.company_id AND f.person_id = reward.person_id AND f.group_key = reward.group_key AND f.state = 'failed') >= 3)) AND (event_id IS NULL OR EXISTS (SELECT 1 FROM event e WHERE e.id = reward.event_id AND e.status = 'applied'))"; // a reward of an event that was reversed is never revived // period rows with one try revive themselves under a new key (x<n>) after the block time
const MAX_REVIVES = 5;
/** Failed event rewards (and period rows tried more than once) that wait for an admin. Shown as open_failed_rewards in the overview. */
export const openFailedRewards = async (ctx, companyId) => (futureOn(ctx.env, await ctx.db.first('SELECT live, provider FROM company WHERE id = ?', companyId)) ? (await ctx.db.first('SELECT COUNT(*) n FROM reward WHERE ' + REVIVABLE, companyId)).n : (await ctx.db.first("SELECT COUNT(*) n FROM reward WHERE company_id = ? AND state = 'failed' AND reversed = 0 AND amount > 0 AND kind NOT IN ('reversal','penalty_return') AND person_id IN (SELECT id FROM app_user WHERE erased_at IS NULL)", companyId)).n);
/**
 * Admin helper, like clearBlocked: put every failed event reward back to 'waiting'; releaseWaiting then runs the whole check again and sends it.
 * It keeps the SAME idempotency key (see failReward), so it cannot pay twice. A row is revived at most MAX_REVIVES times.
 */
export async function reviveFailedRewards(ctx, company, actor = 'admin', { force = false } = {}) {
  if (!futureOn(ctx.env, company)) throw new ApiError(409, 'not_enabled_in_v1', 'Failed rewards are not revived in v1: check the Moneypenny ledger, then re-issue as a new grant.');
  let revived = 0;
  const seenGroup = new Set();
  for (const r of await ctx.db.all('SELECT * FROM reward WHERE ' + REVIVABLE + ' ORDER BY created_at DESC', company.id)) {
    const n = JSON.parse(r.note || '{}');
    if (r.event_id == null) { // a period entitlement failed on several daily tries (one row per try): ONE of them (the latest) is revived, the older ones are the same entitlement and are voided, so it is paid once
      const gk = r.person_id + '|' + r.group_key;
      if (seenGroup.has(gk)) { await commit(ctx, company.id, actor, 'reward.void', { orig: r.id, reason: 'superseded_by_revive' }, [["UPDATE reward SET state='void', last_error='superseded_by_revive' WHERE id=? AND state='failed'", r.id]], { onlyIfChanged: true }); continue; }
      seenGroup.add(gk);
    }
    if ((n.revives ?? 0) >= MAX_REVIVES && !force) continue; // force: an admin may go beyond the limit
    // The first credit may have reached the provider: the revived credit must repeat the SAME amount (same key), so the amount and the takes of the first try are kept.
    const isPeriod = r.event_id == null;
    // An event row repeats its first amount and key (it may have landed). A period row is the same ENTITLEMENT again: computed fresh and sent under a fresh :v<n> key.
    const note = JSON.stringify(isPeriod ? { ...n, offset: 0, takes: [], revives: (n.revives ?? 0) + 1 } : { ...n, offset: r.amount - r.sent_amount, takes: [], takes0: n.takes ?? [], sent0: r.sent_amount, revives: (n.revives ?? 0) + 1 });
    const newKey = String(r.idem_key).replace(/:v\d+$/, '') + ':v' + ((n.revives ?? 0) + 1);
    const stmts = [[`UPDATE reward SET state='waiting', last_error='revived', note=?${isPeriod ? ', idem_key=?, sent_amount=amount' : ''} WHERE id=? AND state='failed' AND (event_id IS NULL OR EXISTS (SELECT 1 FROM event e WHERE e.id = reward.event_id AND e.status = 'applied'))`, note, ...(isPeriod ? [newKey] : []), r.id]];
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

export const openReversesFailed = (ctx, companyId) => openOps(ctx, companyId, ['reverse']);
/** Re-run the idempotent reverse (key rev:<entry>) of rows whose reverse operation is not settled (a lost reply, a crash), before anybody counts them as paid. */
export async function healPendingReverses(ctx, company, personId, groupKey) {
  let healed = 0;
  try { if (!(await ctx.provider(company).capabilities()).reverse) return 0; } catch (e) { if (e instanceof ProviderError) return 0; throw e; } // a provider that cannot reverse has nothing to heal
  for (const op of (await ctx.db.all("SELECT o.* FROM provider_op o JOIN reward r ON r.id = o.subject WHERE o.company_id = ? AND o.kind = 'reverse' AND o.settled = 0 AND r.person_id = ? AND r.group_key = ? AND r.state = 'sent' AND r.reversed = 0", company.id, personId, groupKey))) {
    let d = {}; try { d = JSON.parse(op.params); } catch { /* default */ }
    const r = await ctx.db.first('SELECT * FROM reward WHERE id = ?', op.subject);
    const o = await reverseReward(ctx, company, r, { reason: d.reason ?? 'reversal', actor: 'system', eventId: d.event ?? null });
    if (!o.skipped) healed += r.amount;
  }
  return healed;
}

const PARTIAL_QUICK = 8, PARTIAL_QUICK_EVERY = 6 * 3600_000, PARTIAL_SLOW_EVERY = DAY;
const remOf = (r, note) => r.amount - (note.offset ?? 0) - (note.remCut ?? 0) - r.sent_amount;
/** Rows that were granted only in part (the provider's own cap was short) and whose remainder is still open. */
export const openPartialGrants = async (ctx, companyId) => (await ctx.db.first("SELECT COUNT(*) n FROM reward WHERE person_id IN (SELECT id FROM app_user WHERE erased_at IS NULL) AND company_id = ? AND state = 'sent' AND reversed = 0 AND last_error = 'partial_grant' AND amount - COALESCE(json_extract(note, '$.offset'), 0) - COALESCE(json_extract(note, '$.remCut'), 0) > sent_amount", companyId)).n;
/**
 * The remainder of a partial grant is paid later under its own key AND its own reference (<key>:r<k>, <id>:r<k>; Moneypenny refuses a reused reference).
 * The first 8 tries are 6 hours apart, then one a day, with no hard stop until the remainder is paid or the row is reversed or cut by a lower entitlement.
 * The call is announced on the row first (note.inflight): a reversal or a drop waits for it, and a lost reply replays the SAME key, so what was credited is always what is recorded.
 */
export async function topUpPartials(ctx, company, { force = false } = {}) {
  let paid = 0;
  if (!futureOn(ctx.env, company)) return 0; // FUTURE (not enabled in v1): a partial grant is not topped up by itself; an admin checks the ledger and re-issues
  for (const r of await ctx.db.all("SELECT * FROM reward WHERE company_id = ? AND state = 'sent' AND reversed = 0 AND last_error = 'partial_grant' ORDER BY created_at LIMIT 50", company.id)) {
    let note = JSON.parse(r.note || '{}'), curNote = r.note;
    const rem = remOf(r, note);
    if (rem <= 0 && !note.inflight) { await ctx.db.run("UPDATE reward SET last_error = NULL WHERE id = ? AND last_error = 'partial_grant'", r.id); continue; }
    let k = note.remK ?? 0, amount = rem, acct = null;
    if (note.inflight) { k = note.inflight.k; amount = note.inflight.amount; acct = note.inflight.acct ?? null; } // a call that was cut short: replay the same key and body
    else {
      const every = k < PARTIAL_QUICK ? PARTIAL_QUICK_EVERY : PARTIAL_SLOW_EVERY;
      if (!force && ctx.now() - (note.remAt ?? r.sent_at ?? 0) < every) continue;
      const person = await ctx.db.first('SELECT * FROM app_user WHERE id = ?', r.person_id);
      if (!person || person.erased_at) continue;
      try { acct = await ctx.seal(await accountRef(ctx, company, person), 'reward.acct:' + r.id); } catch { continue; }
      const marked = JSON.stringify({ ...note, inflight: { k, amount, acct } });
      const claim = await ctx.db.run("UPDATE reward SET note = ? WHERE id = ? AND reversed = 0 AND state = 'sent' AND note IS ? AND sent_amount = ?", marked, r.id, r.note, r.sent_amount);
      if (claim.changes === 0) continue;
      note = JSON.parse(marked); curNote = marked;
    }
    const refStr = `${r.id}:r${k}`, key = `${r.idem_key}:r${k}`;
    const finish = (extra, add) => { const { inflight, ...rest } = note; return ctx.db.run("UPDATE reward SET sent_amount = sent_amount + ?, last_error = CASE WHEN sent_amount + ? >= amount - ? - ? THEN NULL ELSE 'partial_grant' END, note = ? WHERE id = ? AND reversed = 0 AND sent_amount = ? AND note IS ?", add, add, note.offset ?? 0, note.remCut ?? 0, JSON.stringify({ ...rest, ...extra }), r.id, r.sent_amount, curNote); };
    try {
      const prov = ctx.provider(company);
      const res = await prov.credit({ accountRef: await ctx.unseal(acct, 'reward.acct:' + r.id), amount, reasonCode: r.kind, ref: refStr, idem: key });
      const got = Number.isInteger(res.granted) && res.granted > 0 && res.granted < amount ? res.granted : amount;
      await finish({ remK: got < amount ? k + 1 : k, remAt: ctx.now() }, got);
      paid += got;
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      if (e.code === 'cap_reached') await finish({ remK: k + 1, remAt: ctx.now() }, 0); // a zero grant: next time under a new key and reference
      else if (e.code === 'duplicate') {
        // The provider says this reference exists. Believed only when its history shows it; otherwise it is retried, and after 3 unconfirmed answers the number moves on.
        let line = null;
        try { line = ((await ctx.provider(company).history({ accountRef: await ctx.unseal(acct, 'reward.acct:' + r.id), limit: 100 })).lines ?? []).find((l) => l.ref === refStr || l.ref === 'manual:' + refStr); } catch { /* not confirmed */ }
        if (line) { const got = Math.min(Number.isInteger(line.amount) && line.amount > 0 ? line.amount : amount, amount); await finish({ remK: got < amount ? k + 1 : k, remAt: ctx.now() }, got); paid += got; }
        else {
          const dups = (note.inflight?.dups ?? 0) + 1;
          if (dups >= 3) await finish({ remK: k + 1, remAt: ctx.now() }, 0);
          else await ctx.db.run('UPDATE reward SET note = ? WHERE id = ? AND note IS ?', JSON.stringify({ ...note, inflight: { ...note.inflight, dups } }), r.id, curNote);
        }
      } // any other (retriable) error: the call stays announced and the next tick replays it
    }
  }
  return paid;
}
/** Admin action: try every open remainder now. */
export async function retryPartialsNow(ctx, company) {
  if (!futureOn(ctx.env, company)) throw new ApiError(409, 'not_enabled_in_v1', 'Partial grants are not topped up in v1: check the Moneypenny ledger, then re-issue the rest as a new grant.'); return { paid: await topUpPartials(ctx, company, { force: true }) }; }

/** Retry everything that is "on its way". Run by tick() (admin button, signed /api/ingest/tick, or the lazy tick). */
export async function retryQueued(ctx, company, limit = 100) {
  let sent = 0, stuck = 0;
  try { // rows of an erased person that are failed or never released are closed for good, with one audit line
    const er = await ctx.db.all("SELECT id, attempts, state FROM reward WHERE company_id = ? AND (state IN ('failed','waiting') OR (state = 'sent' AND last_error = 'partial_grant')) AND amount > 0 AND person_id IN (SELECT id FROM app_user WHERE erased_at IS NOT NULL) LIMIT 200", company.id);
    if (er.length) await commit(ctx, company.id, 'system', 'reward.void', { reason: 'voided_erased', n: er.length, maybe_landed: er.filter((x) => x.attempts > 0).length }, er.map((x) => (x.state === 'sent' // a partly granted row keeps its amounts and state (the part that landed stays counted): only the reason changes, and the marker says it may have landed
      ? ["UPDATE reward SET last_error = 'voided_erased', note = json_set(" + SCRUB_NOTE_SQL + ", '$.maybe_landed', json('true')) WHERE id = ? AND state = 'sent' AND last_error = 'partial_grant'", x.id]
      : ["UPDATE reward SET state = 'void', reversed = 1, last_error = 'voided_erased', note = " + SCRUB_NOTE_SQL + " WHERE id = ? AND state IN ('failed','waiting')", x.id])));
  } catch { /* the next tick */ }
  limit = Math.max(1, Math.min(1000, Number(limit) | 0 || 100));
  for (const r of await ctx.db.all("SELECT * FROM reward WHERE company_id=? AND state='queued' ORDER BY attempts, created_at LIMIT ?", company.id, limit)) { // fewest tries first: a row that can never be sent cannot starve newer ones
    let out;
    try { out = await sendReward(ctx, company, r); } catch (e) { if (e instanceof BudgetReached) throw e; stuck++; continue; } // one bad row never stops the others (it is tried again at the next tick)
    if (out.state === 'sent') sent++;
    else if (ctx.now() - r.created_at > 24 * 3600_000) stuck++;
  }
  try { await topUpPartials(ctx, company); } catch { /* the next tick */ }
  try { await releaseClosedHolds(ctx, company); await releasePendingHolds(ctx, company); } catch { /* housekeeping never stops the sending: it runs again at the next tick */ }
  return { sent, stuck };
}

/**
 * A season closed while some of its rewards were still queued (provider outage) keeps its budget hold, because those rewards draw from it.
 * Once none is queued any more the hold is released and forgotten. Idempotent; a provider problem just leaves it for the next tick.
 */
/** Give a hold back through the operation state machine (one release operation per hold, replayed until the provider confirms). Returns the released amount, or null while unconfirmed. */
export async function releaseHoldOp(ctx, company, holdId, seasonId) {
  const op = await intend(ctx, company, { kind: 'hold_release', key: 'hrel:' + holdId, subject: seasonId, params: { hold: holdId } });
  return driveHoldRelease(ctx, company, op);
}
async function driveHoldRelease(ctx, company, op) {
  let prov;
  try { prov = ctx.provider(company); if (!(await prov.capabilities()).hold) return null; } catch (e) { if (e instanceof ProviderError) return null; throw e; }
  const res = await run(ctx, company, op, (p) => prov.releaseHold({ holdId: p.hold }), { okCodes: ['hold_expired'], believeRefusal: false }); // a release that is refused is NOT done: it is replayed, never forgotten
  if (res.state !== 'landed') return null;
  if (await settleOp(ctx, op)) await commit(ctx, company.id, 'system', 'season.hold_freed', { id: op.subject, hold: op.params.hold });
  return res.result?.released ?? 0;
}
/**
 * Hold housekeeping, driven by the tick: (1) every release operation that is not confirmed is replayed; (2) a reserve operation older than 10 minutes that was never
 * recorded on its season (a lost reply, a failed commit, a lost race) is replayed with ITS key to learn the hold, and that hold is released unless it is the season's hold.
 */
export async function releasePendingHolds(ctx, company) {
  let prov;
  try { prov = ctx.provider(company); if (!(await prov.capabilities()).hold) return 0; } catch (e) { if (e instanceof ProviderError) return 0; throw e; }
  let freed = 0;
  for (const op of await unsettled(ctx, company.id, 'hold_release')) if ((await driveHoldRelease(ctx, company, op)) !== null) freed++;
  for (const op of await unsettled(ctx, company.id, 'hold_reserve')) {
    if (ctx.now() - op.created_at < 600_000) continue;
    const res = await run(ctx, company, op, (p) => prov.reserveBudget({ amount: p.amount, name: p.name, idem: op.key }));
    if (res.state === 'refused') { await settleOp(ctx, op); continue; }
    if (res.state !== 'landed') continue;
    const hold = res.result?.hold_id;
    const se = await ctx.db.first('SELECT hold_id FROM season WHERE id = ?', op.subject);
    if (se?.hold_id !== hold && hold) { const rel = await intend(ctx, company, { kind: 'hold_release', key: 'hrel:' + hold, subject: op.subject, params: { hold } }); if ((await driveHoldRelease(ctx, company, rel)) !== null) freed++; }
    await settleOp(ctx, op);
  }
  return freed;
}
/** Give a closed season's hold back and write the line. Returns the amount, or null while the provider cannot confirm (the tick tries again). */
export async function releaseSeasonHold(ctx, company, se) {
  let amount = 0;
  let hasHold = true;
  try { hasHold = (await ctx.provider(company).capabilities()).hold; } catch (e) { if (e instanceof ProviderError) return null; throw e; }
  if (hasHold) { amount = await releaseHoldOp(ctx, company, se.hold_id, se.id); if (amount === null) return null; }
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
    if (n.sent0 != null && !n.bypass && !n.periodBonus && (await one(ctx, "SELECT COALESCE(SUM(amount),0) FROM reward WHERE company_id=? AND person_id=? AND month_key=? AND kind != 'penalty_return' AND state IN " + COUNT + ' AND id != ?', company.id, r.person_id, r.month_key, r.id)) + r.amount > capOf(s, 'cap_person_month')) continue; // a revived row meets the month cap again
    if ((await one(ctx, fundedSql, company.id, season.id)) + r.amount > season.budget) continue;
    let { offset, takes } = NO_TAKE.has(r.kind) ? { offset: 0, takes: [] } : n.sent0 != null ? await sameTakes(ctx, company, n, r) : await takesFor(ctx, company, r.person_id, r.amount, s);
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
    try { await sendReward(ctx, company, await ctx.db.first('SELECT * FROM reward WHERE id=?', r.id)); } catch { /* one bad row never stops the others: the tick sends it */ }
    moved++;
  }
  return { moved, voided };
}

/** A revived row repeats its first amount: the corrections it took then are taken again if they still have room (else the row is sent smaller, they stay open, and the shortfall is written down). */
async function sameTakes(ctx, company, n, r) {
  const takes = [];
  for (const [cid, t] of n.takes0 ?? []) {
    const c = await ctx.db.first("SELECT amount, recovered FROM correction WHERE id=? AND state='open'", cid);
    if (c && c.amount - c.recovered >= t) takes.push([cid, t]);
  }
  const offset = r.amount - n.sent0, got = takes.reduce((a, [, t]) => a + t, 0);
  if (got < offset) {
    if (r.attempts <= 1) { // the first try was refused cleanly (nothing can have landed): compute the amount fresh, under a NEW key
      const fresh = await takesFor(ctx, company, r.person_id, r.amount, settingsOf(company));
      await ctx.db.run("UPDATE reward SET idem_key = ? WHERE id = ? AND state = 'waiting'", String(r.idem_key).split(':v')[0] + ':v' + (n.revives ?? 1), r.id);
      n.sent0 = null; n.takes0 = [];
      return fresh;
    }
    // The first try may have landed: the amount must repeat. The shortfall (the part of the corrections that is gone) is paid as its own grant so the person is not charged twice.
    const person = await ctx.db.first('SELECT * FROM app_user WHERE id = ?', r.person_id);
    const g = person ? await grant(ctx, company, { person, kind: r.kind, amount: offset - got, idem: r.idem_key + ':short', groupKey: r.group_key, periodKey: r.period_key, at: n.at ?? r.created_at, eventId: r.event_id, bypassCaps: true, noTake: true, actor: 'system' }) : { paid: 0 };
    if (!(g.paid > 0)) { try { await commit(ctx, company.id, 'system', 'reward.take_lost', { id: r.id, lost: offset - got }); } catch { /* the next release writes it */ } }
  }
  return { offset, takes };
}
/** Void a waiting row that can never be released. Corrections it had taken go back. No audit line if somebody else got there first. */
async function voidWaiting(ctx, company, r, n, reason) {
  const live = "EXISTS (SELECT 1 FROM reward WHERE id=? AND state='waiting')";
  const stmts = [];
  for (const [cid, t] of n.takes ?? []) stmts.push([`UPDATE correction SET recovered = MAX(0, recovered - ?), state = CASE WHEN state = 'cleared' THEN 'open' ELSE state END WHERE id = ? AND ${live}`, t, cid, r.id]);
  stmts.push(["UPDATE reward SET state='void', reversed=1, last_error=?, note = json_set(COALESCE(note, '{}'), '$.voided_at', ?) WHERE id=? AND state='waiting'", reason, ctx.now(), r.id]); // last statement: onlyIfChanged is exact
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
  if (r.state === 'sent' && JSON.parse((await ctx.db.first('SELECT note FROM reward WHERE id = ?', r.id))?.note || '{}').inflight) return { reversed: 0, owed: 0, skipped: true, pending: true, code: 'topup_pending' }; // a top-up of the remainder is in flight: decide after it is recorded
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
  let rop = null;
  if (r.provider_ref && r.provider_ref !== 'offset') {
    let prov, canReverse;
    // A provider/config problem (unsupported, misconfigured, unauthorized, down) is never permanent for a reversal: the row stays due and the next tick retries.
    try { prov = ctx.provider(company); canReverse = (await prov.capabilities()).reverse; } catch (e) { if (!(e instanceof ProviderError)) throw e; return { reversed: 0, owed: 0, skipped: true, pending: true, code: e.code }; }
    if (canReverse) {
      // The reverse is ONE provider operation (provider-ops.js): announced before the call, replayed with the same key (rev:<entry>), a refusal believed only on the first try.
      rop = await intend(ctx, company, { kind: 'reverse', key: 'rev:' + r.provider_ref, subject: r.id, params: { entry: r.provider_ref, reason: String(reason ?? 'reversal').slice(0, 80), event: eventId ?? null } });
      const res = await run(ctx, company, rop, () => prov.reverse({ entryId: r.provider_ref, reasonCode: 'reversal', idem: rop.key }));
      if (res.state === 'landed') { reversed = res.result?.reversed ?? 0; owed = res.result?.owed ?? Math.max(0, (r.sent_amount ?? r.amount) - reversed); }
      else if (res.state === 'refused') { /* a clear first "no": nothing was reversed, the whole credit is owed */ }
      else if (res.exhausted || res.busy) return { reversed: 0, owed: 0, skipped: true, pending: true, code: 'reverse_pending' }; // gave up (open_reverses_failed) or another worker is deciding
      else throw new ProviderError(res.code ?? 'provider_down', 'The reversal is not confirmed yet.', { retriable: true });
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
  } catch (e) { if (/idem_key/i.test(String(e?.message))) { if (rop) await settleOp(ctx, rop); return { reversed: 0, owed: 0, skipped: true }; } throw e; }
  if (rop) await settleOp(ctx, rop);
  return { reversed, owed };
}

/** Net credits earned by a person in a month, from our own decision rows (not a balance). */
export const earnedNet = (ctx, companyId, personId, mk) =>
  sum(ctx, `SELECT SUM(amount) s FROM reward WHERE company_id=? AND person_id=? AND month_key=? AND kind != 'penalty_return' AND state IN ${COUNT}`, companyId, personId, mk);

/** The provider's own record of a credit with this reference: a few pages of the history (a page is at most 100 lines; next_before_seq says where the next page starts). reachable=false when the provider could not be asked. */
export async function ledgerLine(ctx, company, accountRef, rewardId) {
  let line = null, reachable = true;
  try {
    let before = null;
    for (let pg = 0; pg < 20 && !line; pg++) { // at most 20 pages of 100 lines
      const h = await ctx.provider(company).history({ accountRef, limit: 100, beforeSeq: before });
      line = (h.lines ?? []).find((l) => l.ref === rewardId || l.ref === 'manual:' + rewardId) ?? null;
      before = h.next_before_seq ?? null; if (before == null) break;
    }
  } catch { reachable = false; }
  return { line, reachable };
}
const noteOf = (note) => {
  const t = typeof note === 'string' ? note.trim() : '';
  if (t.length < 10) throw new ApiError(400, 'note_required', 'Write what you checked in the Moneypenny ledger (at least 10 characters: what you saw, where, when).');
  return t.slice(0, 300);
};
/** Can a NEW grant made now be queued? (a published season for today and room in its budget). Otherwise it would wait and be lost later: refuse up front, nothing is touched. */
async function assertPayableNow(ctx, company, want, freed = 0) {
  const season = await seasonAt(ctx, company.id, ctx.now());
  if (!season) throw new ApiError(409, 'reissue_not_payable', 'There is no published season today: a new grant could not be sent. Nothing was changed.');
  const funded = await one(ctx, fundedSql, company.id, season.id);
  if (funded - freed + want > season.budget) throw new ApiError(409, 'reissue_not_payable', 'The season budget has no room for this grant. Nothing was changed.');
}
/** An idempotency key is at most 120 characters. It is checked when it is made: a longer one is refused, never cut (a cut key could collide with another). */
export const MAX_IDEM = 120;
export function checkIdemKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_IDEM) throw new Error('idempotency key must be 1 to ' + MAX_IDEM + ' characters (got ' + String(key).length + ')');
  return key;
}
const keyAfter = (key) => { const m = /^(.*):re(\d+)$/.exec(String(key)); return m ? `${m[1]}:re${Number(m[2]) + 1}` : key + ':re1'; };

/**
 * v1: an EVENT reward that failed, or was granted only in part, is closed by an admin who has CHECKED the Moneypenny ledger (confirm + a note of at least 10 characters) and re-issued as a NEW grant
 * (new reward id = new reference). Period bonuses (tier, streak, team) are not supported in v1: they are fixed by hand outside the app.
 * The new idempotency key comes from the old row alone (<old key>:re<N>): two requests for one row can only make ONE new reward; the second gets the first one's answer (replay:true), another amount is 409 changed.
 * ONE batch closes the old row and inserts the new one, the close carrying the same budget guards as the insert and the insert guarded on the old row being closed by this action;
 * the audit line is the batch's own reward.create (the admin is its actor, reissue_of names the old row). If the new row cannot be placed, the old row is untouched (409 reissue_not_payable).
 */
export async function reissueReward(ctx, company, actor, opts = {}) {
  const { id, confirm, note = null } = opts;
  const hasAmount = Object.hasOwn(opts, 'amount') && opts.amount !== undefined; // absent (or undefined) = the default, the whole rest; present (even null) must be a whole number
  const amount = hasAmount ? opts.amount : null;
  if (confirm !== true) throw new ApiError(400, 'confirm_required', 'Check the Moneypenny ledger first, then confirm that the old credit is not there (or only in part).');
  const text = noteOf(note);
  if (hasAmount && (typeof amount !== 'number' || !Number.isSafeInteger(amount))) throw new ApiError(400, 'bad_amount', 'The amount must be a whole number of credits.'); // BEFORE any replay: a repeat with a bad amount is never answered 200
  const r = await ctx.db.first('SELECT * FROM reward WHERE id = ? AND company_id = ?', id, company.id);
  if (r && r.event_id == null && ['tier', 'streak', 'team'].includes(r.kind)) throw new ApiError(409, 'not_supported_in_v1', 'A period bonus (tier, streak or team) cannot be re-issued in v1: check the Moneypenny ledger and fix it by hand outside the app.');
  if (r && r.event_id && ['reissued', 'closed_partial'].includes(r.last_error)) { // asked again after it worked: the same answer
    const done = await ctx.db.first('SELECT * FROM reward WHERE company_id = ? AND idem_key = ?', company.id, keyAfter(r.idem_key));
    if (done) {
      if (hasAmount && amount !== done.amount) throw new ApiError(409, 'changed', 'This reward was already re-issued with another amount.');
      return { closed: r.id, new_reward: done.id, key: done.idem_key, state: done.state, paid: done.state === 'sent' ? done.sent_amount : 0, replay: true };
    }
  }
  const partial = !!r && r.state === 'sent' && r.last_error === 'partial_grant';
  if (!r || r.event_id == null || !(r.state === 'failed' || partial) || r.reversed !== 0 || r.amount <= 0 || ['reversal', 'penalty_return'].includes(r.kind)) throw new ApiError(404, 'not_reissuable', 'Only a failed event reward, or one granted only in part, can be re-issued.');
  const n = JSON.parse(r.note || '{}');
  const delivered = partial ? r.sent_amount : 0;
  const rest = Math.max(0, r.amount - (partial ? (n.offset ?? 0) : 0) - delivered);
  if (amount != null && (typeof amount !== 'number' || !Number.isSafeInteger(amount))) throw new ApiError(400, 'bad_amount', 'The amount must be a whole number of credits.');
  const want = amount == null ? rest : amount;
  if (!Number.isInteger(want) || want <= 0 || want > rest) throw new ApiError(400, 'bad_amount', 'The new grant must be more than 0 and at most what is still missing (' + rest + ').');
  assertCreditAmount(company, want, 'The new grant');
  const person = await ctx.db.first('SELECT * FROM app_user WHERE id = ?', r.person_id);
  if (!person || person.erased_at) throw new ApiError(409, 'person_erased', 'This person was erased: nothing is paid.');
  const ev = await ctx.db.first('SELECT status FROM event WHERE id = ? AND company_id = ?', r.event_id, company.id);
  if (!ev || ['reversal_pending', 'reversed'].includes(ev.status)) throw new ApiError(409, 'event_closed', 'The event behind this reward is being reversed or was reversed: nothing is paid for it.');
  // Rows of the SAME chain (the root key and its :re<N> follow-ups: the closed_partial row of an earlier try, a voided re-issue) are not "other rewards": they are this reward's own history.
  const root = String(r.idem_key).replace(/:re\d+$/, '');
  const live = await ctx.db.first("SELECT COALESCE(SUM(amount),0) s FROM reward WHERE company_id = ? AND event_id = ? AND kind = ? AND id != ? AND state IN ('queued','sent','waiting') AND reversed = 0 AND NOT (idem_key = ? OR substr(idem_key, 1, ?) = ?)", company.id, r.event_id, r.kind, r.id, root, root.length + 3, root + ':re');
  if (live.s > 0 && live.s + delivered >= r.amount - (partial ? (n.offset ?? 0) : 0)) throw new ApiError(409, 'already_covered', 'Other rewards already cover this one: nothing to re-issue.');
  await assertPayableNow(ctx, company, want, partial ? rest : 0);
  let newKey; try { newKey = checkIdemKey(keyAfter(r.idem_key)); } catch { throw new ApiError(409, 'key_too_long', 'The reference of this reward cannot be extended any further: check the Moneypenny ledger and fix it by hand outside the app.'); }
  const marker = partial ? 'closed_partial' : 'reissued';
  const close = partial
    ? ["UPDATE reward SET amount = ?, last_error = 'closed_partial' WHERE id = ? AND state = 'sent' AND last_error = 'partial_grant' AND reversed = 0", (n.offset ?? 0) + delivered, r.id]
    : ["UPDATE reward SET state = 'void', reversed = 1, last_error = 'reissued' WHERE id = ? AND state = 'failed' AND reversed = 0", r.id];
  const g = await grant(ctx, company, { person, kind: r.kind, amount: want, idem: newKey, groupKey: r.group_key, periodKey: r.period_key, at: ctx.now(), eventId: r.event_id, bypassCaps: true, noTake: true, actor, note: text, requireQueued: true,
    also: [close], freed: partial ? rest : 0, alsoGuardBoth: { sql: "EXISTS (SELECT 1 FROM app_user WHERE id = ? AND erased_at IS NULL) AND EXISTS (SELECT 1 FROM event WHERE id = ? AND status NOT IN ('reversal_pending','reversed'))", params: [person.id, r.event_id] }, alsoGuard: { sql: 'EXISTS (SELECT 1 FROM reward WHERE id = ? AND last_error = ?)', params: [r.id, marker] }, auditExtra: { reissue_of: r.id, partial, delivered, note_len: text.length } });
  if (g.reason === 'not_payable') throw new ApiError(409, 'reissue_not_payable', 'The new grant could not be queued (no season or no budget right now). Nothing was changed.');
  const nr = g.reward?.id ? await ctx.db.first('SELECT * FROM reward WHERE id = ?', g.reward.id) : null;
  if (!nr || nr.idem_key !== newKey) throw new ApiError(409, g.reason === 'busy' ? 'busy' : 'not_reissued', 'Nothing was changed: ' + (g.reason ?? 'the reward changed meanwhile') + '. Look again.');
  const out = { closed: r.id, new_reward: nr.id, key: newKey, state: nr.state, paid: nr.state === 'sent' ? nr.sent_amount : 0 };
  if (g.replay) { // a second request for the same row: the first one's result, no second grant (a different amount is a conflict)
    if (nr.amount !== want) throw new ApiError(409, 'changed', 'This reward was already re-issued with another amount.');
    return { ...out, replay: true };
  }
  if (!['queued', 'sent'].includes(nr.state)) out.warning = 'The new grant is ' + nr.state + ' and has not been sent yet.';
  return out;
}

/**
 * ONE predicate for "this row of a period group blocks the settle": a failed row, a partly granted row, or a row the system voided (no_season, season_closed, season_cap) that no later live row of the group replaces.
 * Alias x is the row. The settle (periods.js) and the needs-admin list both use it, so what is listed is exactly what is blocked.
 */
const blockerSql = (x) => `${x}.kind != 'reversal' AND ${x}.amount > 0 AND (${x}.state = 'failed' OR (${x}.state = 'sent' AND ${x}.last_error = 'partial_grant') OR (${x}.state = 'void' AND ${x}.last_error IN ('no_season','season_closed','season_cap') AND NOT EXISTS (SELECT 1 FROM reward y WHERE y.company_id = ${x}.company_id AND y.person_id = ${x}.person_id AND y.group_key = ${x}.group_key AND y.kind != 'reversal' AND y.state IN ${COUNT} AND y.created_at >= ${x}.created_at AND y.id != ${x}.id)))`;
export const GROUP_BLOCKER = blockerSql('x');
/** The latest blocking row of a group, or null. */
export const groupBlocker = (ctx, companyId, personId, groupKey) => ctx.db.first(`SELECT x.id, x.state, x.last_error FROM reward x WHERE x.company_id = ? AND x.person_id = ? AND x.group_key = ? AND ${GROUP_BLOCKER} ORDER BY x.created_at DESC LIMIT 1`, companyId, personId, groupKey);
/** The settle tells the list what is still owed: rows that block carry the amount (note.owed); once nothing is owed any more the figure is 0 and the group leaves the list. */
export async function markGroupOwed(ctx, companyId, personId, groupKey, owed) {
  if (owed > 0) await ctx.db.run(`UPDATE reward SET note = json_set(COALESCE(note, '{}'), '$.owed', ?) WHERE id IN (SELECT x.id FROM reward x WHERE x.company_id = ? AND x.person_id = ? AND x.group_key = ? AND ${GROUP_BLOCKER})`, owed, companyId, personId, groupKey);
  else await ctx.db.run("UPDATE reward SET note = json_set(COALESCE(note, '{}'), '$.owed', 0) WHERE company_id = ? AND person_id = ? AND group_key = ? AND kind != 'reversal' AND state IN ('failed','sent','void') AND COALESCE(json_extract(note, '$.owed'), -1) != 0 AND (state = 'failed' OR last_error IN ('partial_grant','no_season','season_closed','season_cap'))", companyId, personId, groupKey);
}

/** What a partly granted row has NOT delivered (and nobody cut): the one definition of "delivered" for the settle, the blocker and the lists. alias a = the row. */
export const undeliveredSql = (a) => `(CASE WHEN ${a}.state = 'sent' AND ${a}.last_error = 'partial_grant' THEN MAX(0, ${a}.amount - COALESCE(json_extract(${a}.note, '$.offset'), 0) - COALESCE(json_extract(${a}.note, '$.remCut'), 0) - ${a}.sent_amount) ELSE 0 END)`;
/** What is undelivered across the group's partly granted rows (the settle's paid minus this is what was delivered). */
export const groupUndelivered = async (ctx, companyId, personId, groupKey) => (await ctx.db.first(`SELECT COALESCE(SUM(${undeliveredSql('x')}), 0) u FROM reward x WHERE x.company_id = ? AND x.person_id = ? AND x.group_key = ? AND x.kind != 'reversal' AND x.reversed = 0`, companyId, personId, groupKey)).u;

const NEEDS_LIVE = 'r.person_id IN (SELECT id FROM app_user WHERE erased_at IS NULL)';
// A failed or partial event reward whose event is being reversed or was reversed is not listed: the reversal owns it (nothing to re-issue, re-issue answers 409 event_closed).
const EV_OPEN = "NOT EXISTS (SELECT 1 FROM event e WHERE e.id = r.event_id AND e.status IN ('reversal_pending','reversed'))";
const VOIDED_AT = "COALESCE(json_extract(r.note, '$.voided_at'), r.created_at)";
const COLS = `r.id, r.person_id, r.kind, r.amount, r.sent_amount, r.state, r.last_error AS reason, r.created_at, ${undeliveredSql('r')} AS missing`;
const eventsFrom = () => ({ where: `r.company_id = ? AND r.event_id IS NOT NULL AND r.amount > 0 AND r.reversed = 0 AND r.kind NOT IN ('reversal','penalty_return') AND (r.state = 'failed' OR (r.state = 'sent' AND r.last_error = 'partial_grant')) AND ${NEEDS_LIVE} AND ${EV_OPEN}`, params: [] });
const voidedFrom = (now) => ({ where: `r.company_id = ? AND r.event_id IS NOT NULL AND r.amount > 0 AND r.state = 'void' AND r.last_error IN ('no_season','season_closed','season_cap') AND ${VOIDED_AT} > ? AND ${NEEDS_LIVE} AND ${EV_OPEN}
    AND NOT EXISTS (SELECT 1 FROM reward y WHERE y.company_id = r.company_id AND y.event_id = r.event_id AND y.person_id = r.person_id AND y.kind = r.kind AND y.id != r.id AND y.state IN ${COUNT})`, params: [now - 30 * DAY] });
const groupsFrom = () => ({ where: `r.company_id = ? AND r.event_id IS NULL AND r.kind IN ('tier','streak','team') AND ${blockerSql('r')} AND ${NEEDS_LIVE} AND (json_extract(r.note, '$.owed') > 0 OR json_extract(r.note, '$.owed') IS NULL)`, params: [] });
/** COUNTS only (the overview): the same predicates as the lists, no rows. */
export async function needsAdminCounts(ctx, company) {
  const e = eventsFrom(), v = voidedFrom(ctx.now()), g = groupsFrom();
  const events = (await ctx.db.first(`SELECT COUNT(*) n FROM reward r WHERE ${e.where}`, company.id)).n;
  const events_voided = (await ctx.db.first(`SELECT COUNT(*) n FROM reward r WHERE ${v.where}`, company.id, ...v.params)).n;
  const groups = (await ctx.db.first(`SELECT COUNT(*) n FROM (SELECT 1 FROM reward r WHERE ${g.where} GROUP BY r.person_id, r.group_key)`, company.id)).n;
  return { events, events_voided, groups, total: events + events_voided + groups };
}
/**
 * What needs an admin in v1, derived from the rows (no extra table). Each list is paged (limit, default 200, and offset) and every answer carries the real totals:
 *  events: failed or partly granted EVENT rewards (can be re-issued); not listed once their event is being reversed or was reversed (the reversal owns them);
 *  events_voided: EVENT rewards the system voided (no season, season closed, cap met) in the last 30 days counted from the VOID, no live reward replaces them (read only);
 *  groups: period groups (tier, streak, team) the settle cannot pay because a row of the group blocks it (GROUP_BLOCKER) and something is still owed, delivered counted (a partly granted row counts what it delivered) (read only: fixed by hand outside the app; there is no dismiss).
 */
export async function needsAdmin(ctx, company, { limit = 200, offset = 0 } = {}) {
  limit = Math.max(1, Math.min(1000, Math.trunc(Number(limit)) || 200)); offset = Math.max(0, Math.min(1e9, Math.trunc(Number(offset)) || 0));
  const e = eventsFrom(), v = voidedFrom(ctx.now()), g = groupsFrom();
  const events = await ctx.db.all(`SELECT ${COLS} FROM reward r WHERE ${e.where} ORDER BY r.created_at DESC, r.id LIMIT ? OFFSET ?`, company.id, limit, offset);
  const events_voided = await ctx.db.all(`SELECT ${COLS} FROM reward r WHERE ${v.where} ORDER BY r.created_at DESC, r.id LIMIT ? OFFSET ?`, company.id, ...v.params, limit, offset);
  const groups = await ctx.db.all(`SELECT ${COLS}, r.group_key, json_extract(r.note, '$.owed') AS owed, MAX(r.created_at) AS latest FROM reward r WHERE ${g.where} GROUP BY r.person_id, r.group_key ORDER BY latest DESC, r.id LIMIT ? OFFSET ?`, company.id, limit, offset);
  const totals = await needsAdminCounts(ctx, company);
  return { events, events_voided, groups, total: totals.total, totals, limit, offset };
}
