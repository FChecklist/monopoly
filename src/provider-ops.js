// ONE state machine for every outbound provider operation whose reply can be lost (debit, restore, reverse, hold reserve and release, order reserve and decision).
// See docs/design/PROVIDER-OPS.md. Short version:
//   intend()  writes the operation row BEFORE the call, keyed by the idempotency key; params are fixed here and never recomputed.
//   run()     claims the row (a lease: overlapping workers cannot both decide), makes the call, and records landed / refused / unknown.
//   A refusal (a definitive 4xx) is believed ONLY on the very first try. After any earlier try (it may have landed) a refusal leaves the state 'unknown'
//   and the same key is replayed (bounded by `budget`), until the provider says what happened. An admin can raise the budget (retryOps).
//   Finishers (the tick) drive every unsettled row to landed/refused and the caller's record to match it, then mark it settled.
import { newId } from './util.js';
import { ProviderError } from './provider/errors.js';

export const MAX_TRIES = 5;
const LEASE = 60_000;
const SLOW = 24 * 3600_000; // an exhausted operation is retried once per day by itself
const parse = (op) => (op ? { ...op, params: safe(op.params), result: safe(op.result) } : null);
const safe = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };

export async function getOp(ctx, companyId, key) {
  return parse(await ctx.db.first('SELECT * FROM provider_op WHERE company_id = ? AND key = ?', companyId, key));
}
/** The INSERT as a statement, so a caller can make it part of its own atomic commit. */
export function intendStmt(ctx, company, { kind, key, subject = null, params = {} }, guard = null) {
  const t = ctx.now();
  const cols = 'INSERT OR IGNORE INTO provider_op (id, company_id, kind, key, subject, params, state, tries, budget, settled, claim_until, created_at, updated_at) ';
  const vals = [newId('po'), company.id, kind, key, subject, JSON.stringify(params), 'intended', MAX_TRIES, t, t];
  if (!guard) return [cols + 'VALUES (?,?,?,?,?,?,?,0,?,0,0,?,?)', ...vals];
  return [cols + 'SELECT ?,?,?,?,?,?,?,0,?,0,0,?,? WHERE ' + guard.sql, ...vals, ...guard.params]; // only when the guard holds (used inside an atomic commit)
}
/** Write the intent (once per key) and return the row. The first writer's params win: every worker uses the stored ones. */
export async function intend(ctx, company, spec) {
  const [sql, ...p] = intendStmt(ctx, company, spec);
  await ctx.db.run(sql, ...p);
  return getOp(ctx, company.id, spec.key);
}
/** true only for the caller that settled it (so a log line is written once). */
export const settleOp = async (ctx, op) => (await ctx.db.run('UPDATE provider_op SET settled = 1, updated_at = ? WHERE id = ? AND settled = 0', ctx.now(), op.id)).changes > 0;

/**
 * Drive one call. call(params) must use op.key as the idempotency key.
 * Returns { state, result, code, busy, exhausted }. state is the row's state afterwards. Never throws a ProviderError.
 * okCodes: provider codes that mean "it is done" (e.g. hold_expired on a release).
 */
export async function run(ctx, company, op, call, { okCodes = [], believeRefusal = true } = {}) {
  let cur = parse(await ctx.db.first('SELECT * FROM provider_op WHERE id = ?', op.id));
  if (cur.state === 'landed' || cur.state === 'refused') return { state: cur.state, result: cur.result, code: cur.last_code };
  if (cur.tries >= cur.budget) {
    // Out of tries: surfaced (openOps) and, until an admin retries (retryOps), given ONE slow try per day so a long outage is never a permanent give-up.
    const t = ctx.now();
    const slow = await ctx.db.run('UPDATE provider_op SET budget = budget + 1, updated_at = ? WHERE id = ? AND state = ? AND tries >= budget AND updated_at <= ?', t, op.id, 'unknown', t - SLOW);
    if (slow.changes === 0) return { state: 'unknown', code: cur.last_code, exhausted: true };
    cur = parse(await ctx.db.first('SELECT * FROM provider_op WHERE id = ?', op.id));
  }
  const now = ctx.now();
  const claim = await ctx.db.run("UPDATE provider_op SET tries = tries + 1, claim_until = ?, updated_at = ? WHERE id = ? AND state IN ('intended','unknown') AND claim_until <= ? AND tries < budget", now + LEASE, now, op.id, now);
  if (claim.changes === 0) { cur = parse(await ctx.db.first('SELECT * FROM provider_op WHERE id = ?', op.id)); return { state: cur.state, result: cur.result, code: cur.last_code, busy: cur.state !== 'landed' && cur.state !== 'refused' }; }
  const before = parse(await ctx.db.first('SELECT * FROM provider_op WHERE id = ?', op.id)).tries - 1; // tries before THIS call
  const done = (state, result, code) => ctx.db.run('UPDATE provider_op SET state = ?, result = ?, last_code = ?, claim_until = 0, updated_at = ? WHERE id = ?', state, result === undefined ? null : JSON.stringify(result), code ?? null, ctx.now(), op.id);
  try {
    const result = await call(cur.params);
    await done('landed', result ?? {}, null);
    return { state: 'landed', result: result ?? {} };
  } catch (e) {
    if (!(e instanceof ProviderError)) { await ctx.db.run('UPDATE provider_op SET claim_until = 0 WHERE id = ?', op.id); throw e; } // our own bug: the lease is released, the try stays counted
    if (okCodes.includes(e.code)) { await done('landed', { code: e.code }, e.code); return { state: 'landed', result: { code: e.code } }; }
    if (!e.retriable && before === 0 && believeRefusal) { await done('refused', { message: e.message }, e.code); return { state: 'refused', code: e.code, message: e.message }; } // a clear first "no": nothing happened
    await done('unknown', undefined, e.code); // an outage, or a "no" after an earlier try that may have landed: not believed, the same key is replayed
    return { state: 'unknown', code: e.code };
  }
}

/** Rows that used up their tries (admin overview). */
export const openOps = async (ctx, companyId, kinds) => (await ctx.db.first(`SELECT COUNT(*) n FROM provider_op WHERE company_id = ? AND state = 'unknown' AND settled = 0 AND tries >= budget AND kind IN (${kinds.map(() => '?').join(',')})`, companyId, ...kinds)).n;
/** Admin action: give every exhausted operation another MAX_TRIES calls. */
export async function retryOps(ctx, company) {
  const r = await ctx.db.run("UPDATE provider_op SET budget = budget + ?, claim_until = 0 WHERE company_id = ? AND state = 'unknown' AND settled = 0 AND tries >= budget", MAX_TRIES, company.id);
  return { retried: r.changes };
}
export const unsettled = async (ctx, companyId, kind) => (await ctx.db.all("SELECT * FROM provider_op WHERE company_id = ? AND kind = ? AND settled = 0 ORDER BY created_at", companyId, kind)).map(parse);
