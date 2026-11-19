// Event intake: checks, approval by trust level, apply (reward + board move), reversal.
import { settingsOf } from './config.js';
import { commit } from './audit.js';
import { ApiError, newId, normEmail, DAY, clean, defuse } from './util.js';
import { MAX_SINGLE_CREDIT } from './v1.js';
import { grant, reverseReward, seasonAt, capOf, voidFailedReward } from './rewards.js';
import { moveToken, die, bonusPct } from './board.js';
import { proposePenalty } from './penalty.js';

const SOURCES = ['manual', 'csv', 'api', 'game', 'request'];
const SYSTEM_SOURCES = ['api', 'game'];

export async function cardFor(ctx, companyId, type, stage, at) {
  return ctx.db.first('SELECT * FROM rate_card WHERE company_id=? AND event_type=? AND stage=? AND active_from <= ? AND (active_to IS NULL OR active_to > ?) ORDER BY version DESC LIMIT 1', companyId, type, stage, at, at);
}

/** Can this actor act for this person? admin: anyone. hr: anyone (view/approve). manager: own team only. employee: self (request only). */
export function canManage(actor, person, team) {
  if (actor.role === 'admin' || actor.role === 'hr') return true;
  if (actor.role === 'manager') return !!person.team_id && team?.manager_id === actor.id;
  return false;
}
async function teamOf(ctx, person) {
  return person.team_id ? ctx.db.first('SELECT * FROM team WHERE id = ?', person.team_id) : null;
}

/**
 * Submit one event. Returns { ok, status, id?, reason? }. A rejected event is not stored (it never counted) except
 * duplicates, which are only reported. `actor` is the app_user row (or {role:'system', id:'api'} for a signed system).
 */
export async function submitEvent(ctx, company, actor, input) {
  const s = settingsOf(company);
  const source = SOURCES.includes(input.source) ? input.source : 'manual';
  const type = clean(input.event_type, 60), stage = clean(input.stage, 40);
  let ext = clean(input.ext_id, 120);
  if (!type || !stage || !ext) return { ok: false, reason: 'missing_fields' };
  // An employee's own request lives in its own namespace: it can never take the id a real CRM or game event will use.
  if (actor.role === 'employee') ext = `emp:${actor.id}:${ext}`.slice(0, 160);
  const at = Number(input.occurred_at ?? ctx.now());
  if (!Number.isFinite(at) || at > ctx.now() + DAY) return { ok: false, reason: 'bad_date' };
  const value = Number.isInteger(Number(input.value)) ? Math.max(0, Number(input.value)) : 0;

  // 1. Who is it for? A person in this company only.
  let person = null;
  if (input.person_id) person = await ctx.db.first("SELECT * FROM app_user WHERE id = ? AND company_id = ? AND status = 'active'", input.person_id, company.id);
  else if (input.work_email) person = await ctx.db.first("SELECT * FROM app_user WHERE email_hash = ? AND company_id = ? AND status = 'active'", await ctx.hash('email', normEmail(input.work_email)), company.id);
  else if (input.work_id) person = await ctx.db.first("SELECT * FROM app_user WHERE company_id = ? AND status = 'active' AND work_id_hash = ?", company.id, await ctx.hash('workid', clean(input.work_id, 60))).catch(() => null);
  if (!person) return { ok: false, reason: 'unknown_person' };
  const team = await teamOf(ctx, person);

  // Who may enter it?
  if (actor.role === 'employee') {
    if (actor.id !== person.id) return { ok: false, reason: 'not_allowed' };
  } else if (actor.role === 'manager') {
    if (!canManage(actor, person, team) && !(actor.id === person.id)) return { ok: false, reason: 'not_your_team' };
  } else if (!['admin', 'hr', 'system'].includes(actor.role)) return { ok: false, reason: 'not_allowed' };
  const sysSource = SYSTEM_SOURCES.includes(source);
  if (sysSource && actor.role !== 'system') return { ok: false, reason: 'system_only' };
  if (!sysSource && actor.role === 'system') return { ok: false, reason: 'bad_source' };
  const finalSource = actor.role === 'employee' ? 'request' : source;

  // 2. Inside a published season?
  const season = await seasonAt(ctx, company.id, at);
  if (!season) return { ok: false, reason: 'outside_season' };
  // 3. Rate card for this type and stage?
  const card = await cardFor(ctx, company.id, type, stage, at);
  if (!card) return { ok: false, reason: 'no_rate_card' };
  if (card.state_needed === 'system' && !sysSource) return { ok: false, reason: 'needs_system_source' };
  // 4. Duplicate?
  const dupe = await ctx.db.first('SELECT id, status, person_id FROM event WHERE company_id=? AND event_type=? AND ext_id=? AND stage=?', company.id, type, ext, stage);
  if (dupe) {
    // Resumable: the event was stored but applying it did not finish (status still 'approved', e.g. the provider was down).
    // Sending the same event again finishes the job instead of reporting a dead-end duplicate. Anything else is a plain duplicate.
    if (dupe.status === 'approved' && dupe.person_id === person.id) {
      await applyEvent(ctx, company, dupe.id);
      const ev = await ctx.db.first('SELECT status, approvals_required FROM event WHERE id = ?', dupe.id);
      return { ok: true, id: dupe.id, status: ev.status, approvals_required: ev.approvals_required, resumed: true };
    }
    return { ok: false, reason: 'duplicate', existing_id: dupe.id };
  }
  // Unique-lead check at the first stage: a keyed hash of the prospect, never the prospect's details.
  let dedupe = null;
  // At the first stage a person's own request must name the prospect (a keyed hash is stored), or it could be repeated forever.
  if (actor.role === 'employee' && card.stage_no === 1 && !clean(input.dedupe_key, 200)) return { ok: false, reason: 'dedupe_key_required' };
  if (input.dedupe_key) {
    dedupe = await ctx.hash('lead:' + company.id, clean(input.dedupe_key, 200).toLowerCase());
    const dup = await ctx.db.first("SELECT id FROM event WHERE company_id=? AND event_type=? AND dedupe_hash=? AND status NOT IN ('rejected','reversed') AND created_at > ?", company.id, type, dedupe, ctx.now() - s.dedupe_window_days * DAY);
    if (dup && card.stage_no === 1) return { ok: false, reason: 'duplicate_lead' };
  }
  // 5. Plausible? Too many in a day is held for a person to look at.
  const dayStart = at - (at % DAY);
  const today = (await ctx.db.first("SELECT COUNT(*) n FROM event WHERE company_id=? AND person_id=? AND created_at >= ? AND status != 'rejected'", company.id, person.id, ctx.now() - DAY)).n;
  let status = 'pending', approvals = 1, held = false;
  if (today >= s.daily_event_limit) { held = true; status = 'held'; }
  // 6. Trust level decides who must approve.
  const backdated = at < ctx.now() - s.backdate_days * DAY;
  const big = card.credits > s.second_approver_over;
  const self = actor.id === person.id;
  if (sysSource && card.state_needed !== 'manager') approvals = 0;
  else if (card.state_needed === 'auto' && !self && !backdated && !big && actor.role !== 'employee') approvals = 0;
  else approvals = 1;
  // `rule2` = the SYSTEM's own rule demanded two approvers (backdated or big). Only that lifts the per-event cap,
  // never a min_approvals value that somebody typed in.
  const rule2 = !sysSource && (backdated || big);
  if (rule2) approvals = 2;
  if (held) approvals = Math.max(approvals, 1);
  if (input.min_approvals && actor.role !== 'employee') approvals = Math.max(approvals, Math.min(2, Number(input.min_approvals) || 0));
  if (approvals === 0 && !held) status = 'approved';
  const meta = input.note || rule2 ? JSON.stringify({ ...(input.note ? { note: clean(input.note, 300) } : {}), ...(rule2 ? { rule2: true } : {}) }) : null;

  const id = newId('ev');
  try {
    // Audit data: ids and numbers only. The external id and any note stay on the event row, never in the immutable chain.
    await commit(ctx, company.id, actor.id, 'event.submit', { id, person: person.id, type, stage, source: finalSource, approvals }, [
      ['INSERT INTO event (id, company_id, person_id, submitted_by, source, event_type, stage, ext_id, occurred_at, value, dedupe_hash, status, approvals_required, rate_card_id, season_id, meta, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        id, company.id, person.id, actor.id, finalSource, type, stage, ext, at, value, dedupe, status, approvals, card.id, season.id, meta, ctx.now()],
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message)) && /event/i.test(String(e?.message))) return { ok: false, reason: 'duplicate' };
    throw e;
  }
  if (status === 'approved') await applyEvent(ctx, company, id);
  const ev = await ctx.db.first('SELECT status FROM event WHERE id = ?', id);
  return { ok: true, id, status: ev.status, approvals_required: approvals };
}

export async function approveEvent(ctx, company, actor, eventId) {
  const ev = await ctx.db.first('SELECT * FROM event WHERE id = ? AND company_id = ?', eventId, company.id);
  if (!ev) throw new ApiError(404, 'no_event', 'No such event.');
  if (!['pending', 'held'].includes(ev.status)) throw new ApiError(409, 'not_pending', 'This event is not waiting for approval.');
  const person = await ctx.db.first('SELECT * FROM app_user WHERE id = ?', ev.person_id);
  const team = await teamOf(ctx, person);
  if (!['manager', 'hr', 'admin'].includes(actor.role) || !canManage(actor, person, team)) throw new ApiError(403, 'not_allowed', 'You cannot approve this.');
  // Nobody approves their own event or one they entered themselves.
  if (actor.id === ev.person_id || actor.id === ev.submitted_by) throw new ApiError(403, 'self_approval', 'You cannot approve your own event or one you entered.');
  const done = ev.approvals_done;
  if (ev.approvals_required >= 2 && done >= 1 && !['hr', 'admin'].includes(actor.role)) throw new ApiError(403, 'second_approver', 'The second approval must come from HR or the company admin.');
  try {
    await commit(ctx, company.id, actor.id, 'event.approve', { id: ev.id, step: done + 1 }, [
      ["INSERT INTO approval (id, event_id, approver_id, decision, at) VALUES (?,?,?,'approve',?)", newId('ap'), ev.id, actor.id, ctx.now()],
      ['UPDATE event SET approvals_done = approvals_done + 1 WHERE id = ?', ev.id],
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) throw new ApiError(409, 'already_approved', 'You already approved this.');
    throw e;
  }
  const now = await ctx.db.first('SELECT * FROM event WHERE id = ?', ev.id);
  if (now.approvals_done >= Math.max(1, now.approvals_required)) {
    await ctx.db.run("UPDATE event SET status = 'approved' WHERE id = ? AND status IN ('pending','held')", ev.id);
    await applyEvent(ctx, company, ev.id);
  }
  return ctx.db.first('SELECT id, status, approvals_done, approvals_required FROM event WHERE id = ?', ev.id);
}

export async function rejectEvent(ctx, company, actor, eventId, reason) {
  const ev = await ctx.db.first('SELECT * FROM event WHERE id = ? AND company_id = ?', eventId, company.id);
  if (!ev || !['pending', 'held'].includes(ev.status)) throw new ApiError(409, 'not_pending', 'This event is not waiting.');
  const person = await ctx.db.first('SELECT * FROM app_user WHERE id = ?', ev.person_id);
  if (!['manager', 'hr', 'admin'].includes(actor.role) || !canManage(actor, person, await teamOf(ctx, person))) throw new ApiError(403, 'not_allowed', 'You cannot reject this.');
  const res = await commit(ctx, company.id, actor.id, 'event.reject', { id: ev.id }, [["UPDATE event SET status='rejected', reason=? WHERE id=? AND status IN ('pending','held')", clean(reason ?? 'not counted', 200), ev.id]], { onlyIfChanged: true });
  if (res[0].changes === 0) { const now = await ctx.db.first('SELECT status FROM event WHERE id = ?', ev.id); throw new ApiError(409, 'not_pending', `This event is already ${now?.status ?? 'gone'}.`); }
  return { id: ev.id, status: 'rejected' };
}

/** Pay and move for an approved event. Safe to run twice: rewards, moves and penalty proposals are idempotent. */
export async function applyEvent(ctx, company, eventId) {
  const ev = await ctx.db.first('SELECT * FROM event WHERE id = ?', eventId);
  if (!ev || !['approved', 'applied'].includes(ev.status)) return null;
  const s = settingsOf(company);
  const card = await ctx.db.first('SELECT * FROM rate_card WHERE id = ?', ev.rate_card_id);
  const person = await ctx.db.first('SELECT * FROM app_user WHERE id = ?', ev.person_id);
  const season = await ctx.db.first('SELECT * FROM season WHERE id = ?', ev.season_id);
  let meta = {};
  try { meta = JSON.parse(ev.meta || '{}') ?? {}; } catch { meta = {}; }
  const out = { paid: 0, bonus: 0 };
  if (card.mode !== 'team' && card.credits > 0) {
    const dice = season.mode === 'dice';
    // Dice bonus: base and the TOP of the bonus range are reserved together, so the bonus can never be left waiting for budget.
    const top = dice ? Math.min(company.provider === 'moneypenny' ? MAX_SINGLE_CREDIT : Infinity, Math.max(1, Math.ceil((card.credits * s.bonus_max_pct) / 100))) : 0; // a dice bonus is one credit: never above the provider's single maximum
    const g = await grant(ctx, company, {
      person, kind: 'event', amount: card.credits, idem: `event:${ev.id}:${ev.stage}`, groupKey: `card:${ev.event_type}:${ev.stage}`,
      at: ev.occurred_at, eventId: ev.id, card, capMonth: card.cap_month, capDay: card.cap_day,
      // Only the system's own two-approver rule (backdated or big) lifts the per-event cap, never a typed-in min_approvals.
      capEvent: meta.rule2 ? 0 : capOf(s, 'cap_event'), reserve: top, actor: 'system', // a 0 or junk cap_event falls back to the default; only the system's two-approver rule lifts it
    });
    if (g.reason === 'busy') return null; // not decided yet: the event stays 'approved' and the tick runs it again
    out.paid = g.paid;
    if (dice && g.paid > 0) {
      // Bonus roll: the base is already decided. The die only sizes a bonus on top, inside [floor, max], at least 1 credit.
      const d = await die(ctx, person.id, ev.id, 99);
      const pct = bonusPct(s.bonus_floor_pct, s.bonus_max_pct, d);
      const bonus = Math.min(top, Math.max(1, Math.floor((g.paid * pct) / 100)));
      const b = await grant(ctx, company, { person, kind: 'bonus_roll', amount: bonus, idem: `bonus:${ev.id}:${ev.stage}`, groupKey: `bonus:${ev.event_type}:${ev.stage}`, at: ev.occurred_at, eventId: ev.id, card, actor: 'system' });
      if (b.reason === 'busy') return null;
      out.bonus = b.paid; out.roll = { die: d, pct };
    }
  }
  const mv = await moveToken(ctx, company, { person, event: ev, card, season });
  // A rule that removes anything is never applied by a signed system: it only creates a proposed penalty for HR.
  // One bad rule (no acknowledgement yet, credit loss switched off, ...) is skipped; it never stops the event or the tick.
  for (const pr of await ctx.db.all('SELECT * FROM penalty_rule WHERE company_id = ? AND event_type = ? AND active = 1 AND published_at IS NOT NULL AND published_at <= ?', company.id, ev.event_type, ev.occurred_at)) {
    try {
      await proposePenalty(ctx, company, { id: 'system', role: 'system' }, { person_id: person.id, effect: pr.effect, amount: pr.amount, reason: `Rule for ${ev.event_type}`, event_id: ev.id }, { fromRule: pr.id });
    } catch (e) { out.skipped_rules = (out.skipped_rules ?? 0) + 1; }
  }
  await commit(ctx, company.id, 'system', 'event.apply', { id: ev.id, ...out }, [["UPDATE event SET status='applied', applied_at = COALESCE(applied_at, ?) WHERE id = ? AND status IN ('approved','applied')", ctx.now(), ev.id]]);
  return { ...out, move: mv };
}

/** Run approved-but-unfinished events again (after a crash or a provider outage). One bad event never stops the others. */
export async function resumeApproved(ctx, company) {
  let n = 0;
  for (const e of await ctx.db.all("SELECT id FROM event WHERE company_id = ? AND status = 'approved'", company.id)) {
    try { await applyEvent(ctx, company, e.id); n++; } catch { /* left 'approved'; tried again at the next tick */ }
  }
  return n;
}

// ---------- Reversal of a cancelled lead or game ----------
/**
 * System-confirmed (billing refund, CRM loss): reverses automatically after a notice period.
 * Manager-recorded (fake lead): needs a second approver (HR or admin) who is not the one who recorded it.
 * Either way the person can appeal, which freezes the reversal and any correction.
 */
export async function requestReversal(ctx, company, actor, eventId, { reason, kind }) {
  const s = settingsOf(company);
  const ev = await ctx.db.first('SELECT * FROM event WHERE id = ? AND company_id = ?', eventId, company.id);
  if (!ev || ev.status !== 'applied') throw new ApiError(409, 'not_reversible', 'Only a counted event can be reversed.');
  const person = await ctx.db.first('SELECT * FROM app_user WHERE id = ?', ev.person_id);
  const sys = actor.role === 'system';
  if (!sys && !(['manager', 'hr', 'admin'].includes(actor.role) && canManage(actor, person, await teamOf(ctx, person)))) throw new ApiError(403, 'not_allowed', 'You cannot reverse this.');
  if (!sys && actor.id === ev.person_id) throw new ApiError(403, 'self', 'You cannot reverse your own event.');
  const k = sys ? 'system' : 'manager';
  if (kind === 'refund' && ev.applied_at && ctx.now() - ev.applied_at > s.reversal_window_days * DAY) throw new ApiError(409, 'window_over', 'The refund window for this event is over.');
  const due = k === 'system' ? ctx.now() + s.reversal_notice_days * DAY : null;
  await commit(ctx, company.id, actor.id, 'event.reversal_request', { id: ev.id, kind: k, due }, [
    ["UPDATE event SET status='reversal_pending', reversal_kind=?, reversal_due=?, reversal_by=?, reversal_reason=? WHERE id=? AND status='applied'", k, due, actor.id, clean(reason ?? 'cancelled', 200), ev.id],
  ], { onlyIfChanged: true });
  return { id: ev.id, status: 'reversal_pending', due };
}
export async function approveReversal(ctx, company, actor, eventId) {
  const ev = await ctx.db.first("SELECT * FROM event WHERE id = ? AND company_id = ? AND status = 'reversal_pending' AND reversal_kind = 'manager'", eventId, company.id);
  if (!ev) throw new ApiError(404, 'no_request', 'No manager-recorded reversal waiting.');
  if (!['hr', 'admin'].includes(actor.role) || actor.id === ev.reversal_by || actor.id === ev.person_id) throw new ApiError(403, 'second_approver', 'A different HR or admin person must approve.');
  if (ev.reversal_appeal) throw new ApiError(409, 'appealed', 'The person has appealed. Decide the appeal first.');
  const out = await executeReversal(ctx, company, ev.id, actor.id);
  if (out.aborted) throw new ApiError(409, 'changed', REVERSAL_CHANGED);
  return out;
}
const hasReversalRows = async (ctx, eventId) => !!(await ctx.db.first("SELECT 1 x FROM reward WHERE event_id = ? AND kind = 'reversal'", eventId));
export async function appealReversal(ctx, company, actor, eventId) {
  const ev = await ctx.db.first("SELECT * FROM event WHERE id = ? AND company_id = ? AND status = 'reversal_pending'", eventId, company.id);
  if (!ev || ev.person_id !== actor.id) throw new ApiError(404, 'no_request', 'Nothing to appeal.');
  if (ev.reversal_kind === 'system' && ev.reversal_due && ctx.now() > ev.reversal_due) throw new ApiError(409, 'too_late', 'The notice period is over.');
  if (await hasReversalRows(ctx, ev.id) || (ev.reversal_kind === 'manager' && ev.reversal_due)) throw new ApiError(409, 'already_reversing', 'The reversal has already started and can no longer be appealed.');
  // One guarded statement: it only lands while the reversal has not started (no due set yet for a manager request, notice still running for a system one, no reversal row).
  // The correction freeze rides in the same batch and only applies if the event is still pending an appealed reversal.
  const pend = "EXISTS (SELECT 1 FROM event WHERE id = ? AND status = 'reversal_pending' AND reversal_appeal = 1)";
  const res = await commit(ctx, company.id, actor.id, 'event.reversal_appeal', { id: ev.id }, [
    ["UPDATE event SET reversal_appeal = 1 WHERE id = ? AND status = 'reversal_pending' AND (reversal_due IS NULL OR reversal_due > ?) AND NOT EXISTS (SELECT 1 FROM reward WHERE event_id = ? AND kind = 'reversal')", ev.id, ctx.now(), ev.id],
    [`UPDATE correction SET state='frozen' WHERE event_id = ? AND state = 'open' AND ${pend}`, ev.id, ev.id],
  ], { onlyIf: { sql: "SELECT 1 FROM event WHERE id = ? AND status = 'reversal_pending' AND reversal_appeal = 1 AND (reversal_due IS NULL OR reversal_due > ?)", params: [ev.id, ctx.now()] } });
  if (res[0].changes === 0 && !(await ctx.db.first("SELECT 1 x FROM event WHERE id = ? AND reversal_appeal = 1 AND status = 'reversal_pending'", ev.id))) throw new ApiError(409, 'already_reversing', 'The reversal has already started and can no longer be appealed.');
  return { id: ev.id, appealed: true };
}
export async function decideReversalAppeal(ctx, company, actor, eventId, uphold) {
  const ev = await ctx.db.first("SELECT * FROM event WHERE id = ? AND company_id = ? AND status = 'reversal_pending' AND reversal_appeal = 1", eventId, company.id);
  if (!ev) throw new ApiError(404, 'no_appeal', 'No appeal waiting.');
  if (!['hr', 'admin'].includes(actor.role) || actor.id === ev.reversal_by || actor.id === ev.person_id) throw new ApiError(403, 'not_allowed', 'A different HR or admin person decides, and never the person concerned.');
  if (uphold) {
    const out = await executeReversal(ctx, company, ev.id, actor.id, { upheld: true });
    if (out.aborted) throw new ApiError(409, 'changed', REVERSAL_CHANGED);
    return out;
  }
  if (await hasReversalRows(ctx, ev.id)) throw new ApiError(409, 'already_reversing', 'Part of this reversal is already done; it can only be upheld.');
  const res = await commit(ctx, company.id, actor.id, 'event.reversal_denied', { id: ev.id }, [
    ["UPDATE event SET status='applied', reversal_kind=NULL, reversal_due=NULL, reversal_appeal=0 WHERE id=? AND status='reversal_pending' AND reversal_appeal=1 AND NOT EXISTS (SELECT 1 FROM reward WHERE event_id = ? AND kind = 'reversal')", ev.id, ev.id],
    ["UPDATE correction SET state='open' WHERE event_id = ? AND state = 'frozen' AND EXISTS (SELECT 1 FROM event WHERE id = ? AND status = 'applied' AND reversal_kind IS NULL AND reversal_appeal = 0)", ev.id, ev.id],
  ], { onlyIf: { sql: "SELECT 1 FROM event WHERE id = ? AND status = 'applied' AND reversal_kind IS NULL AND reversal_appeal = 0", params: [ev.id] } });
  if (res[0].changes === 0) throw new ApiError(409, 'already_reversing', 'The reversal has already started; it can only be upheld.');
  return { id: ev.id, status: 'applied' };
}
const REVERSAL_CHANGED = 'This reversal was changed (appealed, denied or done) while you were deciding. Nothing was reversed.';
async function executeReversal(ctx, company, eventId, actorId, { upheld = false } = {}) {
  // Mark it as started BEFORE any row is reversed: a retriable error half way (or a crash) leaves a due reversal that the next tick retries
  // (manager kind too), and nobody can appeal or deny it away once a reward may already be voided.
  // The claim only lands while the event is still reversal_pending and either not appealed or this is the decision that upholds the appeal.
  // If it changes nothing (denied, appealed, or done by somebody else in the meantime) no reward is touched.
  const claim = await ctx.db.run("UPDATE event SET reversal_due=?, reversal_appeal=0 WHERE id=? AND status='reversal_pending' AND (reversal_appeal=0 OR ?=1)", ctx.now(), eventId, upheld ? 1 : 0);
  if (claim.changes === 0) return { id: eventId, status: (await ctx.db.first('SELECT status FROM event WHERE id = ?', eventId))?.status ?? 'gone', aborted: true };
  const ev = await ctx.db.first('SELECT * FROM event WHERE id = ?', eventId);
  const rows = await ctx.db.all("SELECT * FROM reward WHERE company_id = ? AND event_id = ? AND reversed = 0 AND amount > 0 AND kind IN ('event','bonus_roll','lap','note')", company.id, eventId);
  const total = { reversed: 0, owed: 0 };
  let pending = 0;
  for (const r of rows) {
    if (r.state === 'failed') { await voidFailedReward(ctx, company, r); continue; } // never sent: voided, so a later admin revive cannot pay a reversed event
    const o = await reverseReward(ctx, company, r, { reason: ev.reversal_reason ?? 'cancelled', actor: actorId, eventId });
    total.reversed += o.reversed; total.owed += o.owed;
    if (o.pending) pending++; // the provider has not confirmed this credit yet: it may still go out, so it is not resolved
  }
  // Only when EVERY row is resolved does the event become 'reversed'. Otherwise it stays 'reversal_pending' and the next tick retries.
  if (pending > 0) return { id: eventId, status: 'reversal_pending', pending, ...total };
  await commit(ctx, company.id, actorId, 'event.reverse', { id: eventId, ...total }, [["UPDATE event SET status='reversed', reversed_at=? WHERE id=? AND status='reversal_pending'", ctx.now(), eventId]], { onlyIfChanged: true });
  return { id: eventId, status: 'reversed', ...total };
}
/** Run due system reversals. Skips any that were appealed. */
export async function processReversals(ctx, company) {
  let n = 0;
  for (const e of await ctx.db.all("SELECT id FROM event WHERE company_id=? AND status='reversal_pending' AND reversal_due IS NOT NULL AND reversal_due <= ? AND (reversal_kind='manager' OR reversal_appeal=0)", company.id, ctx.now())) {
    try { if ((await executeReversal(ctx, company, e.id, 'system')).status === 'reversed') n++; } catch { /* a provider error on one event never stops the others; it is tried again at the next tick */ }
  }
  return n;
}

// ---------- CSV ----------
/** Minimal CSV reader (quotes, commas, newlines). Every cell is defused against spreadsheet formulas. */
export function parseCsv(text, maxRows = 2000) {
  const rows = []; let row = [], cell = '', q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((x) => x.trim())) rows.push(row); row = []; if (rows.length > maxRows + 1) throw new ApiError(413, 'too_many_rows', `At most ${maxRows} rows per file.`); }
    else cell += c;
  }
  row.push(cell); if (row.some((x) => x.trim())) rows.push(row);
  if (rows.length > maxRows + 1) throw new ApiError(413, 'too_many_rows', `At most ${maxRows} rows per file.`);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'));
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, defuse((r[i] ?? '').trim())])));
}

/** CSV intake: always a preview first. commit=false changes nothing. Over the limit, every row needs a second approver. */
export async function importCsv(ctx, company, actor, text, { commit: doCommit = false } = {}) {
  const s = settingsOf(company);
  const rows = parseCsv(text, s.csv_max_rows);
  const report = { rows: rows.length, accepted: 0, rejected: [], total_credits: 0 };
  const plan = [];
  for (const [i, r] of rows.entries()) {
    const at = r.occurred_at ? Date.parse(r.occurred_at) : ctx.now();
    const card = await cardFor(ctx, company.id, r.event_type, r.stage, at);
    const person = r.work_email ? await ctx.db.first('SELECT id FROM app_user WHERE email_hash = ? AND company_id = ?', await ctx.hash('email', normEmail(r.work_email)), company.id) : null;
    if (!card || !person) { report.rejected.push({ row: i + 2, reason: !person ? 'unknown_person' : 'no_rate_card' }); continue; }
    report.accepted++; report.total_credits += card.credits;
    plan.push({ ...r, person_id: person.id, occurred_at: at, source: 'csv' });
  }
  report.needs_second_person = report.total_credits > s.second_approver_over * 5;
  if (!doCommit) return { ...report, committed: false };
  report.results = [];
  for (const e of plan) {
    const out = await submitEvent(ctx, company, actor, { ...e, min_approvals: report.needs_second_person ? 2 : 0 });
    report.results.push({ ext_id: e.ext_id, ok: out.ok, reason: out.reason, status: out.status });
  }
  return { ...report, committed: true };
}
