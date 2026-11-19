// The per-tick query budget. A tick is ONE invocation of the worker, and a free Cloudflare D1 plan allows only a few dozen queries per invocation: every stage of the clock must stop cleanly
// when the budget is used up and pick up at the next tick. The budget counts calls at the database port (first / all / run / batch each count one).
export class BudgetReached extends Error {
  constructor() { super('tick budget reached'); this.code = 'budget_reached'; }
}
/** limit <= 0 (or not a number): unlimited, only counted. */
export function makeBudget(limit) {
  const n = Number(limit);
  const unlimited = !(n > 0);
  return { limit: unlimited ? Infinity : Math.trunc(n), cap: unlimited ? Infinity : Math.trunc(n), used: 0, hit: 0, backlog: 0, sweepLeft: 0, unlimited, left() { return this.cap - this.used; }, gate() { if (this.used >= this.cap) { this.hit++; throw new BudgetReached(); } this.used++; } };
}
/** The budget limit of a deployment: TICK_QUERY_BUDGET, default 40 (a free D1 plan allows about 50 queries per invocation), 0 = unlimited (tests, a paid plan). */
export function budgetLimit(env) {
  const raw = env?.TICK_QUERY_BUDGET;
  if (raw === undefined || raw === null || raw === '') return 40;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : 40;
}
/** A database port that counts, and throws BudgetReached instead of running a query beyond the cap. */
export function budgetDb(db, b) {
  const gate = () => b.gate();
  return {
    raw: db.raw, stats: db.stats,
    async first(...a) { gate(); return db.first(...a); },
    async all(...a) { gate(); return db.all(...a); },
    async run(...a) { gate(); return db.run(...a); },
    async batch(...a) { gate(); return db.batch(...a); },
    async reads(...a) { gate(); return db.reads(...a); },
    exec: (...a) => db.exec?.(...a),
  };
}
/** The same context, with a counted database port. Everything a stage does goes through it. */
export function withBudget(ctx, b) {
  const t = Object.create(ctx);
  t.db = budgetDb(ctx.db, b); t.budget = b; t.rawDb = ctx.rawDb ?? ctx.db;
  // A call to the provider is a subrequest of the same invocation: it counts like a query (and is refused the same way).
  t.provider = (company) => new Proxy(ctx.provider(company), { get(target, k) { const v = Reflect.get(target, k, target); return typeof v === 'function' && k !== 'then' ? (...a) => { b.gate(); b.provCalls = (b.provCalls ?? 0) + 1; if (k === 'credit') b.credits = (b.credits ?? 0) + 1; return v.apply(target, a); } : v; } });
  return t;
}
export const budgetLeft = (ctx) => (ctx.budget ? ctx.budget.left() : Infinity);

/**
 * A READ-ONLY database port that gathers every SELECT started in the same round (the same synchronous stretch of code, e.g. inside one Promise.all) into ONE batch of the underlying port.
 * D1 counts one batch as one query, so a page that asks for thirty numbers costs a few calls. Anything that is not a SELECT is passed through untouched.
 */
export function coalescingDb(db) {
  let queue = [];
  const isSelect = (sql) => /^\s*(SELECT|WITH)\b/i.test(sql);
  const flush = () => {
    const batch = queue; queue = [];
    db.reads(batch.map((x) => [x.sql, ...x.p])).then((rs) => batch.forEach((x, i) => x.ok(rs[i])), (e) => batch.forEach((x) => x.fail(e)));
  };
  const add = (sql, p) => new Promise((ok, fail) => { if (!queue.length) queueMicrotask(flush); queue.push({ sql, p, ok, fail }); });
  return {
    raw: db.raw, stats: db.stats,
    first: (sql, ...p) => (isSelect(sql) ? add(sql, p).then((r) => r[0] ?? null) : db.first(sql, ...p)),
    all: (sql, ...p) => (isSelect(sql) ? add(sql, p) : db.all(sql, ...p)),
    run: (...a) => db.run(...a),
    batch: (...a) => db.batch(...a),
    reads: (...a) => db.reads(...a),
    exec: (...a) => db.exec?.(...a),
  };
}

// ---------- the invocation limit (routes that do a variable amount of work) ----------
/** What ONE invocation of the worker may query: INVOCATION_QUERY_LIMIT when set, else 50 (Cloudflare free) unless the deployment says it has no budget (TICK_QUERY_BUDGET=0: paid plan, tests). Infinity = unbounded. */
export function invocationLimit(env) {
  const e = Number(env?.INVOCATION_QUERY_LIMIT);
  if (e > 0) return Math.trunc(e);
  return budgetLimit(env) <= 0 ? Infinity : 50;
}
export const ROUTE_MARGIN = 4; // calls of the invocation a route never uses
/**
 * A route that works through a list (event intake, CSV import) asks this gate before each item: the item is started only when the invocation can pay for the
 * most expensive one seen so far. The first item always runs (so a call always makes progress). Whole items only: an item is never cut in the middle by this gate.
 */
export function batchGate(ctx, { estimate = 30, margin = ROUTE_MARGIN } = {}) {
  const lim = invocationLimit(ctx.env);
  const used = () => ctx.budget?.used ?? 0;
  let worst = 0, started = 0, at = 0;
  return {
    limit: lim,
    /** How many items one call can take now (an estimate for the contract: max_per_call). null = no bound. */
    maxPerCall: () => (Number.isFinite(lim) ? Math.max(1, Math.floor((lim - margin - used()) / estimate)) : null),
    canTake() { return !Number.isFinite(lim) || started === 0 || lim - margin - used() >= (worst || estimate); },
    begin() { started++; at = used(); },
    end() { worst = Math.max(worst, used() - at); },
  };
}
