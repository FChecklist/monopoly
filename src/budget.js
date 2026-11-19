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
    raw: db.raw,
    async first(...a) { gate(); return db.first(...a); },
    async all(...a) { gate(); return db.all(...a); },
    async run(...a) { gate(); return db.run(...a); },
    async batch(...a) { gate(); return db.batch(...a); },
    exec: (...a) => db.exec?.(...a),
  };
}
/** The same context, with a counted database port. Everything a stage does goes through it. */
export function withBudget(ctx, b) {
  const t = Object.create(ctx);
  t.db = budgetDb(ctx.db, b); t.budget = b;
  // A call to the provider is a subrequest of the same invocation: it counts like a query (and is refused the same way).
  t.provider = (company) => new Proxy(ctx.provider(company), { get(target, k) { const v = Reflect.get(target, k, target); return typeof v === 'function' && k !== 'then' ? (...a) => { b.gate(); return v.apply(target, a); } : v; } });
  return t;
}
export const budgetLeft = (ctx) => (ctx.budget ? ctx.budget.left() : Infinity);
