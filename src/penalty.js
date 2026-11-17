// Penalties: board steps, board points, or earned-and-unspent credits. Never pay, never salary, never a job effect.
// Flow: proposed -> HR approves -> 3 days notice -> applied. The person can appeal for 7 days; reviewers escalate; silence = reversed.
import { settingsOf } from './config.js';
import { commit } from './audit.js';
import { ApiError, newId, DAY, clean, monthKey } from './util.js';
import { ensureBoard, enterLane, checkReset, finishLaneTask } from './board.js';
import { accountRef, grant, earnedNet, sendReward, isTransient } from './rewards.js';
import { ProviderError } from './provider/errors.js';

export const NOTICE_DAYS = 3, APPEAL_DAYS = 7, L1_DAYS = 3, L2_DAYS = 3, L3_DAYS = 5; // 3 + 3 + 5 = 11 days in all
const EFFECTS = ['steps_back', 'points', 'credits', 'lane'];

export async function proposePenalty(ctx, company, actor, input, { fromRule = null } = {}) {
  const s = settingsOf(company);
  const person = await ctx.db.first("SELECT * FROM app_user WHERE id = ? AND company_id = ? AND status = 'active'", input.person_id, company.id);
  if (!person) throw new ApiError(404, 'no_person', 'No such person.');
  if (!EFFECTS.includes(input.effect)) throw new ApiError(400, 'bad_effect', 'Unknown penalty effect.');
  const amount = Number.isInteger(Number(input.amount)) ? Math.max(0, Number(input.amount)) : 0;
  if (actor.role === 'manager') {
    const team = person.team_id ? await ctx.db.first('SELECT * FROM team WHERE id = ?', person.team_id) : null;
    if (team?.manager_id !== actor.id || actor.id === person.id) throw new ApiError(403, 'not_allowed', 'You can only propose for your own team.');
  } else if (!['admin', 'hr', 'system'].includes(actor.role)) throw new ApiError(403, 'not_allowed', 'You cannot propose a penalty.');
  if (input.effect === 'credits') {
    if (!s.penalty_credit_loss) throw new ApiError(409, 'credit_loss_off', 'Credit-loss penalties are switched off for this company.');
    if (!(await ctx.provider(company).capabilities()).debit) throw new ApiError(409, 'unsupported', 'The credit provider cannot take back credits, so this penalty type is off.');
  }
  // Notice: the person must have acknowledged the penalty rules AFTER they were published (the latest publication for a manual proposal).
  const rule = fromRule ? await ctx.db.first('SELECT * FROM penalty_rule WHERE id = ? AND company_id = ?', fromRule, company.id) : null;
  const since = rule ? (rule.published_at ?? 0) : ((await ctx.db.first('SELECT MAX(published_at) m FROM penalty_rule WHERE company_id = ? AND active = 1 AND published_at IS NOT NULL', company.id))?.m ?? 0);
  const ack = await ctx.db.first("SELECT id FROM consent WHERE user_id = ? AND company_id = ? AND kind = 'penalty_rules' AND at >= ?", person.id, company.id, since);
  if (!ack) throw new ApiError(409, 'no_notice', 'This person has not acknowledged the current penalty rules, so no penalty can be proposed.');
  // A rule proposes at most one case per event, however often the event is applied again.
  if (fromRule && input.event_id) {
    const hit = await ctx.db.first('SELECT case_id FROM penalty_rule_hit WHERE event_id = ? AND rule_id = ?', input.event_id, fromRule);
    if (hit) return { id: hit.case_id, state: 'proposed', replay: true };
  }
  const id = newId('pc');
  const stmts = [];
  if (fromRule && input.event_id) stmts.push(['INSERT INTO penalty_rule_hit (event_id, rule_id, case_id, at) VALUES (?,?,?,?)', input.event_id, fromRule, id, ctx.now()]);
  stmts.push(["INSERT INTO penalty_case (id, company_id, person_id, proposer_id, event_id, effect, amount, reason, state, created_at) VALUES (?,?,?,?,?,?,?,?, 'proposed', ?)",
    id, company.id, person.id, actor.id, input.event_id ?? null, input.effect, amount, clean(input.reason, 300) || 'Rule applied', ctx.now()]);
  try {
    await commit(ctx, company.id, actor.id, 'penalty.propose', { id, person: person.id, effect: input.effect, amount, rule: fromRule }, stmts);
  } catch (e) {
    if (/penalty_rule_hit/i.test(String(e?.message))) { const hit = await ctx.db.first('SELECT case_id FROM penalty_rule_hit WHERE event_id = ? AND rule_id = ?', input.event_id, fromRule); return { id: hit?.case_id, state: 'proposed', replay: true }; }
    throw e;
  }
  return { id, state: 'proposed' };
}

export async function approvePenalty(ctx, company, actor, caseId) {
  const c = await ctx.db.first("SELECT * FROM penalty_case WHERE id = ? AND company_id = ? AND state = 'proposed'", caseId, company.id);
  if (!c) throw new ApiError(404, 'no_case', 'No proposed penalty with this id.');
  if (!['hr', 'admin'].includes(actor.role)) throw new ApiError(403, 'hr_only', 'HR or the company admin approves penalties.');
  if (actor.id === c.proposer_id || actor.id === c.person_id) throw new ApiError(403, 'second_person', 'A different person must approve.');
  const now = ctx.now();
  await commit(ctx, company.id, actor.id, 'penalty.approve', { id: c.id }, [
    ["UPDATE penalty_case SET state='pending', approver_id=?, approved_at=?, apply_at=?, appeal_by=? WHERE id=? AND state='proposed'", actor.id, now, now + NOTICE_DAYS * DAY, now + APPEAL_DAYS * DAY, c.id],
  ], { onlyIfChanged: true });
  return { id: c.id, state: 'pending', apply_at: now + NOTICE_DAYS * DAY };
}
export async function rejectPenalty(ctx, company, actor, caseId, note) {
  const c = await ctx.db.first("SELECT * FROM penalty_case WHERE id = ? AND company_id = ? AND state = 'proposed'", caseId, company.id);
  if (!c) throw new ApiError(404, 'no_case', 'No proposed penalty with this id.');
  if (!['hr', 'admin'].includes(actor.role)) throw new ApiError(403, 'hr_only', 'HR or the company admin decides.');
  await commit(ctx, company.id, actor.id, 'penalty.reject', { id: c.id }, [["UPDATE penalty_case SET state='rejected', decision_note=? WHERE id=? AND state='proposed'", clean(note, 200), c.id]], { onlyIfChanged: true });
  return { id: c.id, state: 'rejected' };
}

export async function appealPenalty(ctx, company, actor, caseId) {
  const c = await ctx.db.first('SELECT * FROM penalty_case WHERE id = ? AND company_id = ?', caseId, company.id);
  if (!c || c.person_id !== actor.id) throw new ApiError(404, 'no_case', 'No such penalty for you.');
  if (!['pending', 'applied'].includes(c.state)) throw new ApiError(409, 'not_appealable', 'This penalty cannot be appealed now.');
  if (ctx.now() > c.appeal_by) throw new ApiError(409, 'too_late', 'The 7 day appeal window is over.');
  const now = ctx.now();
  await commit(ctx, company.id, actor.id, 'penalty.appeal', { id: c.id }, [
    ["UPDATE penalty_case SET state='appealed', appeal_at=?, appeal_level=1, appeal_deadline=?, appeal_final=? WHERE id=? AND state IN ('pending','applied')", now, now + L1_DAYS * DAY, now + (L1_DAYS + L2_DAYS + L3_DAYS) * DAY, c.id],
  ], { onlyIfChanged: true });
  return { id: c.id, state: 'appealed', reviewer_level: 1 };
}

export async function decideAppeal(ctx, company, actor, caseId, forPerson, note) {
  const c = await ctx.db.first("SELECT * FROM penalty_case WHERE id = ? AND company_id = ? AND state = 'appealed'", caseId, company.id);
  if (!c) throw new ApiError(404, 'no_appeal', 'No appeal waiting.');
  if (actor.id === c.proposer_id || actor.id === c.person_id) throw new ApiError(403, 'not_allowed', 'The proposer cannot review the appeal.');
  const level = c.appeal_level;
  let ok = level === 2 ? ['hr', 'admin'].includes(actor.role) : level === 3 ? actor.role === 'admin' : false;
  if (level === 1) {
    // Level 1 is the person's OWN manager, or HR. Any other manager has no say over someone else's team.
    if (actor.role === 'hr') ok = true;
    else if (actor.role === 'manager') {
      const person = await ctx.db.first('SELECT team_id FROM app_user WHERE id = ? AND company_id = ?', c.person_id, company.id);
      const team = person?.team_id ? await ctx.db.first('SELECT manager_id FROM team WHERE id = ? AND company_id = ?', person.team_id, company.id) : null;
      ok = !!team && team.manager_id === actor.id;
    }
  }
  if (!ok) throw new ApiError(403, 'wrong_level', 'This appeal is with a different reviewer level.');
  const text = clean(note, 200);
  if (forPerson) return reversePenalty(ctx, company, c, actor.id, text || 'Appeal won', 'appeal_won');
  const up = await commit(ctx, company.id, actor.id, 'penalty.upheld', { id: c.id }, [["UPDATE penalty_case SET state='upheld', decision_note=? WHERE id=? AND state='appealed'", text, c.id]], { onlyIfChanged: true });
  // An appeal made inside the notice window and then upheld was never applied: apply it now (the tick retries if this fails).
  if (up[0].changes > 0 && !c.applied_at) { try { await applyPenalty(ctx, company, c); } catch { /* the tick applies upheld-and-unapplied cases */ } }
  return { id: c.id, state: 'upheld' };
}

// A case is applied only while it is 'pending' (notice over) or 'upheld' and not yet applied; never while 'appealed'.
const OPEN_SQL = "state IN ('pending','upheld') AND applied_at IS NULL";
const LIVE = `EXISTS (SELECT 1 FROM penalty_case WHERE id = ? AND ${OPEN_SQL})`;

/**
 * Apply a penalty after its notice. Every board change sits in ONE batch with the state change and is guarded on the
 * case still being pending/appealed, so two ticks at once cannot take anything twice.
 */
async function applyPenalty(ctx, company, c0) {
  let dkey = null;
  const s = settingsOf(company);
  const c = await ctx.db.first(`SELECT * FROM penalty_case WHERE id = ? AND company_id = ? AND ${OPEN_SQL}`, c0.id, company.id);
  if (!c) return null;
  const gen = await restoresOf(ctx, company, c.id); // ONCE per apply: the debit key and any restore of it share this generation
  const b = await ensureBoard(ctx, company, c.person_id);
  const upd = { steps: 0, points: 0, credits: 0, prev: b.position };
  const stmts = [];
  if (c.effect === 'steps_back') {
    upd.steps = Math.min(c.amount, b.position);
    if (upd.steps > 0) stmts.push([`UPDATE board_state SET position = position - ?, updated_at = ? WHERE person_id = ? AND position >= ? AND ${LIVE}`, upd.steps, ctx.now(), c.person_id, upd.steps, c.id]);
  } else if (c.effect === 'points') {
    upd.points = Math.min(c.amount, b.points);
    if (upd.points > 0) stmts.push([`UPDATE board_state SET points = points - ?, updated_at = ? WHERE person_id = ? AND points >= ? AND ${LIVE}`, upd.points, ctx.now(), c.person_id, upd.points, c.id]);
  } else if (c.effect === 'lane') {
    stmts.push([`UPDATE board_state SET in_lane = 1, skip_roll = 1, updated_at = ? WHERE person_id = ? AND ${LIVE}`, ctx.now(), c.person_id, c.id]);
    stmts.push([`INSERT INTO lane_task (id, company_id, person_id, task, created_at) SELECT ?,?,?,?,? WHERE ${LIVE}`, newId('lt'), company.id, c.person_id, String(c.reason ?? 'One small coaching task').slice(0, 200), ctx.now(), c.id]);
  } else if (c.effect === 'credits') {
    // The setting and the provider's ability are checked again NOW, not only when it was proposed.
    const prov = ctx.provider(company);
    dkey = debitIdem(c.id, gen);
    // A debit that may already have landed (answer lost) is replayed with the SAME key and amount, never recomputed: the cap room moves once the debit exists.
    const pend = await pendingDebit(ctx, company, dkey);
    if ((pend || s.penalty_credit_loss) && (await prov.capabilities()).debit) {
      const person = await ctx.db.first('SELECT * FROM app_user WHERE id = ?', c.person_id);
      let ask, room;
      if (pend) { ask = pend.ask; room = pend.room; } else {
        const mk = monthKey(ctx.now());
        const earned = await earnedNet(ctx, company.id, c.person_id, mk);
        const already = (await ctx.db.first("SELECT COALESCE(SUM(applied_credits),0) s FROM penalty_case WHERE person_id = ? AND state IN ('applied','appealed','upheld') AND applied_at >= ?", c.person_id, ctx.now() - 31 * DAY)).s;
        const capPct = Math.min(50, s.penalty_cap_pct);
        room = Math.max(0, Math.floor((earned * capPct) / 100) - already);
        ask = Math.min(c.amount, room);
        if (ask > 0) await commit(ctx, company.id, 'system', 'penalty.debit_pending', { id: c.id, key: dkey, ask, room, gen }); // BEFORE the provider call
      }
      if (ask > 0) {
        try {
          const out = await prov.debit({ accountRef: await accountRef(ctx, company, person), amount: ask, reasonCode: 'penalty', ref: c.id, idem: dkey, monthlyCap: room });
          upd.credits = out.debited; // may be less than asked, never below zero, never spent credits
        } catch (e) {
          if (!(e instanceof ProviderError)) throw e;
          if (e.code === 'unsupported' || e.code === 'insufficient_credits') upd.nodebit = e.code; // no debit happened: the case is applied without credits and the reason is on the audit line
          else if (e.retriable || isTransient(e.code)) return null; // may have landed: the marker makes the retry replay it
          else upd.nodebit = e.code; // a definitive refusal
        }
      }
    }
  }
  stmts.push([`UPDATE penalty_case SET ${c.state === 'upheld' ? '' : "state='applied', "}applied_at=?, applied_steps=?, applied_points=?, applied_credits=?, prev_pos=? WHERE id=? AND ${OPEN_SQL}`, ctx.now(), upd.steps, upd.points, upd.credits, upd.prev, c.id]);
  const res = await commit(ctx, company.id, 'system', 'penalty.apply', { id: c.id, ...upd }, stmts, { onlyIfChanged: true });
  if (res[stmts.length - 1].changes === 0) { // somebody else applied or reversed it first
    try { await restoreDebit(ctx, company, c.id, upd.credits, gen); } catch { /* the debit_pending marker is still open: finishDebits (the tick) hands it back */ }
    return null;
  }
  if (dkey) await resolveDebit(ctx, company, c.id, dkey);
  if (c.effect === 'points') await checkReset(ctx, company, c.person_id);
  return upd;
}

/**
 * The debit at the provider went through but our claim on the case lost the race. Unless the winner recorded that very
 * debit (applied with credits > 0, the same idempotent key), hand the credits back so nothing is lost without a record.
 */
/** How many times the debit of this case was handed back (restoreDebit). Each hand-back ends a debit for good, so the next debit needs a new key. */
const restoresOf = async (ctx, company, caseId) => (await ctx.db.first("SELECT COUNT(*) n FROM audit WHERE company_id = ? AND action = 'penalty.restore' AND instr(data, ?) > 0", company.id, `"id":"${caseId}"`)).n;
/** The debit that was announced (debit_pending) and not yet settled (debit_resolved), or null. */
async function pendingDebit(ctx, company, key) {
  const m = await ctx.db.first("SELECT data FROM audit WHERE company_id = ? AND action = 'penalty.debit_pending' AND instr(data, ?) > 0 ORDER BY n DESC LIMIT 1", company.id, `"key":"${key}"`);
  if (!m) return null;
  if (await ctx.db.first("SELECT 1 x FROM audit WHERE company_id = ? AND action = 'penalty.debit_resolved' AND instr(data, ?) > 0", company.id, `"key":"${key}"`)) return null;
  try { return JSON.parse(m.data); } catch { return null; }
}
async function resolveDebit(ctx, company, id, key) { try { await commit(ctx, company.id, 'system', 'penalty.debit_resolved', { id, key }); } catch { /* the tick writes it */ } }
/**
 * An announced debit whose case was reversed (an appeal won) or closed before the debit was ever recorded on it: replay the SAME debit (same key and amount, so it
 * cannot take twice) to learn what it took, and give that back. If the debit never landed, replaying it and handing it back nets to zero.
 */
async function finishDebits(ctx, company) {
  let n = 0;
  const seen = new Set();
  for (const r of await ctx.db.all("SELECT data FROM audit WHERE company_id = ? AND action = 'penalty.debit_pending' ORDER BY n", company.id)) {
    let d; try { d = JSON.parse(r.data); } catch { continue; }
    if (!d?.key || seen.has(d.key)) continue; seen.add(d.key);
    if (!(await pendingDebit(ctx, company, d.key))) continue;
    const c = await ctx.db.first('SELECT state, applied_at, applied_credits, person_id FROM penalty_case WHERE id = ?', d.id);
    if (!c) continue;
    if (c.applied_credits > 0 || c.applied_at) { await resolveDebit(ctx, company, d.id, d.key); continue; }
    if (['proposed', 'pending', 'appealed', 'upheld'].includes(c.state)) continue; // will still be applied: that replays the marker
    const rk = 'penrestore:' + d.id + (d.gen ? ':g' + d.gen : '');
    if ((await ctx.db.first("SELECT COUNT(*) n FROM audit WHERE company_id = ? AND action = 'penalty.restore' AND instr(data, ?) > 0", company.id, `"key":"${rk}"`)).n > 0) { await resolveDebit(ctx, company, d.id, d.key); continue; }
    let took = 0;
    try {
      const person = await ctx.db.first('SELECT * FROM app_user WHERE id = ?', c.person_id);
      const prov = ctx.provider(company);
      if ((await prov.capabilities()).debit) took = (await prov.debit({ accountRef: await accountRef(ctx, company, person), amount: d.ask, reasonCode: 'penalty', ref: d.id, idem: d.key, monthlyCap: d.room })).debited ?? 0;
    } catch (e) { if (!(e instanceof ProviderError)) throw e; if (e.retriable || isTransient(e.code)) continue; }
    if (took > 0) await restoreDebit(ctx, company, d.id, took, d.gen ?? 0);
    await resolveDebit(ctx, company, d.id, d.key); n++;
  }
  return n;
}
const debitIdem = (caseId, g) => { return g ? `pen:${caseId}:g${g}` : 'pen:' + caseId; };

export async function restoreDebit(ctx, company, caseId, credits, gen) {
  if (!(credits > 0)) return;
  const now = await ctx.db.first('SELECT state, applied_credits, person_id FROM penalty_case WHERE id = ?', caseId);
  if (!now) return;
  if (['applied', 'appealed', 'upheld'].includes(now.state) && now.applied_credits > 0) return;
  if (now.state === 'reversed' && now.applied_credits > 0) return; // the winner recorded this debit; the penrev: hand-back owns it
  if (gen === undefined) gen = await restoresOf(ctx, company, caseId); // direct callers only; applyPenalty passes the generation it debited with
  const key = 'penrestore:' + caseId + (gen ? ':g' + gen : '');
  try {
    if ((await ctx.db.first("SELECT COUNT(*) n FROM audit WHERE company_id = ? AND action = 'penalty.restore' AND instr(data, ?) > 0", company.id, `"key":"${key}"`)).n > 0) return; // this restore is already recorded
    // The pending marker goes in BEFORE the credit (once per key): if the credit lands and our receipt then fails for any reason, the tick finishes it with the same key.
    if ((await ctx.db.first("SELECT COUNT(*) n FROM audit WHERE company_id = ? AND action = 'penalty.restore_pending' AND instr(data, ?) > 0", company.id, `"key":"${key}"`)).n === 0) await commit(ctx, company.id, 'system', 'penalty.restore_pending', { id: caseId, credits, key });
    const person = await ctx.db.first('SELECT * FROM app_user WHERE id = ?', now.person_id);
    await ctx.provider(company).credit({ accountRef: await accountRef(ctx, company, person), amount: credits, reasonCode: 'penalty_restore', ref: caseId, idem: key });
    await commit(ctx, company.id, 'system', 'penalty.restore', { id: caseId, credits, key }); // the debit is over: a later debit of this case is a NEW debit (new key)
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    // The pending marker already exists. A PERMANENT error is counted (penalty.restore_failed) so the tick stops after MAX_RESTORE_TRIES; a transient one is not logged at all.
    if (!e.retriable && !isTransient(e.code)) { try { await commit(ctx, company.id, 'system', 'penalty.restore_failed', { id: caseId, key, code: e.code }); } catch { /* the next try counts again */ } }
  }
}

const MAX_RESTORE_TRIES = 5;
const restoreTries = async (ctx, company, key) => (await ctx.db.first("SELECT COUNT(*) n FROM audit WHERE company_id = ? AND action = 'penalty.restore_failed' AND instr(data, ?) > 0", company.id, `"key":"${key}"`)).n;
/** Restores that gave up after MAX_RESTORE_TRIES permanent provider errors (admin overview: open_restores_failed). */
export async function openRestoresFailed(ctx, companyId) {
  const tries = new Map(), done = new Set();
  for (const r of await ctx.db.all("SELECT action, data FROM audit WHERE company_id = ? AND action IN ('penalty.restore_failed','penalty.restore','penalty.restore_skipped')", companyId)) {
    let d; try { d = JSON.parse(r.data); } catch { continue; }
    if (!d?.key) continue;
    if (r.action === 'penalty.restore_failed') tries.set(d.key, (tries.get(d.key) ?? 0) + 1); else done.add(d.key);
  }
  let n = 0; for (const [k, t] of tries) if (t >= MAX_RESTORE_TRIES && !done.has(k)) n++;
  return n;
}
/** Finish restores that were cut short (provider down while a lost-race debit was being handed back). Idempotent: same key as the first try. */
async function finishRestores(ctx, company) {
  let done = 0;
  const rows = await ctx.db.all("SELECT data FROM audit WHERE company_id = ? AND action = 'penalty.restore_pending' ORDER BY n", company.id);
  const seen = new Set();
  for (const r of rows) {
    let d; try { d = JSON.parse(r.data); } catch { continue; }
    if (!d?.key || seen.has(d.key)) continue; seen.add(d.key);
    if ((await restoreTries(ctx, company, d.key)) >= MAX_RESTORE_TRIES) continue; // gave up: shown as open_restores_failed
    if ((await ctx.db.first("SELECT COUNT(*) n FROM audit WHERE company_id = ? AND action IN ('penalty.restore','penalty.restore_skipped') AND instr(data, ?) > 0", company.id, `"key":"${d.key}"`)).n > 0) continue;
    const c = await ctx.db.first('SELECT state, applied_credits FROM penalty_case WHERE id = ?', d.id);
    if (!c || c.applied_credits > 0) { await commit(ctx, company.id, 'system', 'penalty.restore_skipped', { id: d.id, key: d.key }); continue; } // the winner recorded this debit: nothing to restore
    const g = d.key.includes(':g') ? Number(d.key.split(':g')[1]) : 0;
    await restoreDebit(ctx, company, d.id, d.credits, g);
    if ((await ctx.db.first("SELECT COUNT(*) n FROM audit WHERE company_id = ? AND action = 'penalty.restore' AND instr(data, ?) > 0", company.id, `"key":"${d.key}"`)).n > 0) done++;
  }
  return done;
}

const MAX_HANDBACK_TRIES = 5;
const PENREV_ROWS = "(r.idem_key = 'penrev:' || p.id OR r.idem_key LIKE 'penrev:' || p.id || ':g%')";
/** The idem key of the next hand-back try: a hand-back row that ended 'failed' (permanent provider error) replays forever, so each failed try moves to a new key. */
async function handBackIdem(ctx, caseId) {
  const n = (await ctx.db.first("SELECT COUNT(*) n FROM reward WHERE state = 'failed' AND (idem_key = ? OR idem_key LIKE ?)", 'penrev:' + caseId, 'penrev:' + caseId + ':g%')).n;
  return n ? `penrev:${caseId}:g${n}` : 'penrev:' + caseId;
}

/** Admin action: hand-backs that used up their 5 tries get another go (new key each, see handBackIdem). Returns how many were paid back. */
export async function retryExhaustedHandbacks(ctx, company) {
  let n = 0;
  for (const c of await ctx.db.all("SELECT * FROM penalty_case p WHERE p.company_id = ? AND p.state = 'reversed' AND p.applied_credits > 0 AND NOT EXISTS (SELECT 1 FROM reward r WHERE " + PENREV_ROWS + " AND r.state != 'failed')", company.id)) {
    try { if (await handBack(ctx, company, c, 'admin')) n++; } catch { /* stays open */ }
  }
  return { retried: n };
}
/** Leave the Catch-up Lane and pay the credits back. Both are idempotent, so running it twice is safe. */
async function handBack(ctx, company, c, actorId) {
  if (c.effect === 'lane') for (const t of await ctx.db.all("SELECT id FROM lane_task WHERE person_id = ? AND state = 'open'", c.person_id)) await finishLaneTask(ctx, company, t.id, 'system');
  if (c.applied_credits > 0) { // idempotent key: running twice pays back once
    const person = await ctx.db.first('SELECT * FROM app_user WHERE id = ?', c.person_id);
    let code = null;
    try {
      const g = await grant(ctx, company, { person, kind: 'penalty_return', amount: c.applied_credits, idem: await handBackIdem(ctx, c.id), groupKey: 'penrev', at: ctx.now(), bypassCaps: true, actor: actorId });
      if (!(g.paid > 0)) code = g.reason ?? 'not_paid'; // busy / failed / void: not handed back, so the tick tries again
    } catch (e) { if (!(e instanceof ProviderError)) throw e; code = e.code; }
    if (code) {
      try { await commit(ctx, company.id, 'system', 'penalty.handback_failed', { id: c.id, code }); } catch { /* the tick retries and logs again */ }
      return false;
    }
  }
  return true;
}

/** Give everything back: board steps, board points, credits, and leave the Catch-up Lane. Safe to run twice. */
async function reversePenalty(ctx, company, c0, actorId, note, code = 'custom') {
  const c = await ctx.db.first("SELECT * FROM penalty_case WHERE id = ? AND company_id = ? AND state IN ('pending','appealed','applied')", c0.id, company.id);
  if (!c) {
    const now = await ctx.db.first('SELECT * FROM penalty_case WHERE id = ?', c0.id);
    if (now?.state === 'reversed' && now.applied_at) await handBack(ctx, company, now, actorId); // idempotent: finishes a hand-back a crash cut short
    return { id: c0.id, state: now?.state ?? 'reversed' };
  }
  // Every write is guarded by the applied_at value we read: if the case was applied (or changed) since, nothing here lands and nothing is handed back.
  const open = "EXISTS (SELECT 1 FROM penalty_case WHERE id = ? AND state IN ('pending','appealed','applied') AND applied_at IS ?)";
  const stmts = [];
  if (c.applied_at && c.applied_steps) stmts.push([`UPDATE board_state SET position = (position + ?) % 24 WHERE person_id = ? AND ${open}`, c.applied_steps, c.person_id, c.id, c.applied_at]);
  if (c.applied_at && c.applied_points) stmts.push([`UPDATE board_state SET points = points + ? WHERE person_id = ? AND ${open}`, c.applied_points, c.person_id, c.id, c.applied_at]);
  stmts.push(["UPDATE penalty_case SET state='reversed', decision_note=? WHERE id=? AND state IN ('pending','appealed','applied') AND applied_at IS ?", note, c.id, c.applied_at]);
  // The audit line holds the case id and a code only. The free-text note stays on the case row.
  const res = await commit(ctx, company.id, actorId, 'penalty.reverse', { id: c.id, code }, stmts, { onlyIfChanged: true });
  if (res[res.length - 2].changes === 0) return { id: c.id, state: (await ctx.db.first('SELECT state FROM penalty_case WHERE id = ?', c.id)).state }; // lost a race: nothing was given back
  if (c.applied_at) await handBack(ctx, company, c, actorId); // on failure the tick repairs it (reversed + credits + no penrev: row)
  return { id: c.id, state: 'reversed' };
}

/** Move the clock: apply after notice, escalate appeals, and reverse by silence. Run by the scheduled trigger and on each admin visit. */
export async function tickPenalties(ctx, company) {
  const now = ctx.now(), out = { applied: 0, escalated: 0, reversed: 0, errors: 0, repaired: 0 };
  // A reversal that committed but whose credit hand-back never landed (crash, contention): the penrev: reward is missing. Run it again (idempotent).
  try { out.repaired += await finishDebits(ctx, company); } catch { out.errors++; }
  try { out.repaired += await finishRestores(ctx, company); } catch { out.errors++; }
  for (const c of await ctx.db.all("SELECT * FROM penalty_case p WHERE p.company_id = ? AND p.state = 'reversed' AND p.applied_credits > 0 AND NOT EXISTS (SELECT 1 FROM reward r WHERE " + PENREV_ROWS + " AND r.state != 'failed') AND (SELECT COUNT(*) FROM reward r WHERE " + PENREV_ROWS + " AND r.state = 'failed') < " + MAX_HANDBACK_TRIES, company.id)) {
    try { if (await handBack(ctx, company, c, 'system')) out.repaired++; } catch (e) { out.errors++; }
  }
  // The hand-back credit is a queued penalty_return reward during an outage: this tick sends it itself, it does not rely on the rest of the tick.
  for (const r of await ctx.db.all("SELECT * FROM reward WHERE company_id = ? AND state = 'queued' AND kind = 'penalty_return'", company.id)) {
    try { if ((await sendReward(ctx, company, r)).state === 'sent') out.repaired++; } catch { out.errors++; }
  }
  for (const c of await ctx.db.all("SELECT * FROM penalty_case WHERE company_id = ? AND (state IN ('pending','appealed') OR (state = 'upheld' AND applied_at IS NULL))", company.id)) {
    try {
      if (c.state === 'upheld') { if (await applyPenalty(ctx, company, c)) out.applied++; continue; }
      if (c.state === 'pending' && now >= c.apply_at) { if (await applyPenalty(ctx, company, c)) out.applied++; continue; }
      if (c.state === 'appealed') {
        if (now >= c.appeal_final) { await reversePenalty(ctx, company, c, 'system', 'No decision in time: reversed in your favour', 'silence'); out.reversed++; continue; }
        const l2 = c.appeal_at + (L1_DAYS + L2_DAYS) * DAY;
        if (c.appeal_level === 1 && now >= c.appeal_deadline) { await ctx.db.run("UPDATE penalty_case SET appeal_level = 2, appeal_deadline = ? WHERE id = ? AND state = 'appealed' AND appeal_level = 1", c.appeal_at + (L1_DAYS + L2_DAYS) * DAY, c.id); out.escalated++; }
        else if (c.appeal_level === 2 && now >= l2) { await ctx.db.run("UPDATE penalty_case SET appeal_level = 3, appeal_deadline = ? WHERE id = ? AND state = 'appealed' AND appeal_level = 2", c.appeal_final, c.id); out.escalated++; }
      }
    } catch (e) { out.errors++; } // one bad case never stops the clock for the others
  }
  return out;
}
