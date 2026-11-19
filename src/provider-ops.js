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
const NOT_LANDED = new Set(['unauthorized', 'misconfigured', 'bad_config', 'rate_limited', 'unsupported']); // refused before reaching the books: such a try is not counted against the budget
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
  const reread = async () => parse(await ctx.db.first('SELECT * FROM provider_op WHERE id = ?', op.id));
  const view = (c, extra = {}) => ({ state: c.state, result: c.result, code: c.last_code, ...extra });
  const terminal = (c) => c.state === 'landed' || c.state === 'refused';
  let cur = await reread();
  if (terminal(cur)) return view(cur);
  const now = ctx.now();
  if (cur.tries >= cur.budget) {
    // Out of tries: surfaced (openOps) and, until an admin retries (retryOps), given ONE slow try per day so a long outage is never a permanent give-up.
    if (cur.claim_until > now) return view(cur, { busy: true });
    const slow = await ctx.db.run("UPDATE provider_op SET budget = budget + 1, updated_at = ? WHERE id = ? AND state IN ('intended','unknown') AND tries >= budget AND claim_until <= ? AND updated_at <= ?", now, op.id, now, now - SLOW);
    if (slow.changes === 0) return { state: 'unknown', code: cur.last_code, exhausted: true };
  }
  // The claim moves the row to 'unknown' at once: a worker that dies or hangs after the call leaves an op that is already treated as unknown (replayed, surfaced), never a silent 'intended'.
  const token = newId('ct');
  const claim = await ctx.db.run("UPDATE provider_op SET tries = tries + 1, state = 'unknown', claim_until = ?, claim_token = ?, updated_at = ? WHERE id = ? AND state IN ('intended','unknown') AND claim_until <= ? AND tries < budget", now + LEASE, token, now, op.id, now);
  if (claim.changes === 0) { cur = await reread(); return view(cur, { busy: !terminal(cur) }); }
  const before = (await reread()).tries - 1; // tries before THIS call
  // Only the holder of the claim token may record the answer, and only while the row is still open. A worker whose write changes nothing re-reads and acts on the STORED state, never on its own stale reply.
  const done = async (state, result, code, refund = false) => {
    const r = await ctx.db.run("UPDATE provider_op SET state = ?, result = ?, last_code = ?, claim_until = 0, tries = CASE WHEN ? THEN MAX(tries - 1, 0) ELSE tries END, updated_at = ? WHERE id = ? AND claim_token = ? AND state IN ('intended','unknown')", state, result === undefined ? null : JSON.stringify(result), code ?? null, refund ? 1 : 0, ctx.now(), op.id, token);
    return r.changes > 0;
  };
  const stored = async () => { const c = await reread(); return view(c, { busy: !terminal(c), lost: true }); };
  try {
    const result = await call(cur.params);
    if (await done('landed', result ?? {}, null)) return { state: 'landed', result: result ?? {} };
    return stored();
  } catch (e) {
    if (!(e instanceof ProviderError)) { await ctx.db.run('UPDATE provider_op SET claim_until = 0 WHERE id = ? AND claim_token = ?', op.id, token); throw e; } // our own bug: the lease is released, the row is already 'unknown', the try stays counted
    if (okCodes.includes(e.code)) return (await done('landed', { code: e.code }, e.code)) ? { state: 'landed', result: { code: e.code } } : stored();
    if (!e.retriable && before === 0 && believeRefusal) return (await done('refused', { message: e.message }, e.code)) ? { state: 'refused', code: e.code, message: e.message } : stored(); // a clear first "no": nothing happened
    // an outage, or a "no" after an earlier try that may have landed: not believed, the same key is replayed. A try that provably never reached the provider's books is not counted.
    if (await done('unknown', undefined, e.code, NOT_LANDED.has(e.code))) return { state: 'unknown', code: e.code };
    return stored();
  }
}

/** Rows that used up their tries (admin overview). */
export const openOps = async (ctx, companyId, kinds) => (await ctx.db.first(`SELECT COUNT(*) n FROM provider_op WHERE company_id = ? AND state IN ('intended','unknown') AND settled = 0 AND tries >= budget AND claim_until <= ${ctx.now()} AND kind IN (${kinds.map(() => '?').join(',')})`, companyId, ...kinds)).n;
/** Admin action: give every exhausted operation another MAX_TRIES calls. */
export async function retryOps(ctx, company) {
  const r = await ctx.db.run("UPDATE provider_op SET budget = budget + ? WHERE company_id = ? AND state IN ('intended','unknown') AND settled = 0 AND tries >= budget AND claim_until <= ?", MAX_TRIES, company.id, ctx.now());
  return { retried: r.changes };
}
export const unsettled = async (ctx, companyId, kind) => (await ctx.db.all("SELECT * FROM provider_op WHERE company_id = ? AND kind = ? AND settled = 0 ORDER BY created_at", companyId, kind)).map(parse);
