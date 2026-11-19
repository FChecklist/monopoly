// Append-only, hash-chained audit trail, one chain per company. Triggers in the schema block UPDATE and DELETE.
// Audit data holds ids and numbers only, never names, e-mails or lead details.
import { sha256Hex } from './util.js';

/** Audit data holds ids, codes and numbers only. Any string that is not an id or a code (free text, names, e-mails) is replaced before it is chained. */
const CODE = /^[A-Za-z0-9_.:/-]{0,80}$/;
export function scrubAudit(v, depth = 0) {
  if (typeof v === 'string') return CODE.test(v) ? v : '[text omitted]';
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (depth > 4) return '[deep]';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => scrubAudit(x, depth + 1));
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 50).map(([k, x]) => [k, scrubAudit(x, depth + 1)]));
  return null;
}

const GENESIS = '0'.repeat(64);

async function nextRow(db, companyId, actor, action, data, at, { onlyIfChanged = false, onlyIf = null } = {}) {
  const last = await db.first('SELECT n, hash FROM audit WHERE company_id = ? ORDER BY n DESC LIMIT 1', companyId);
  const n = (last?.n ?? 0) + 1, prev = last?.hash ?? GENESIS;
  const body = JSON.stringify(scrubAudit(data ?? {}));
  const hash = await sha256Hex([prev, n, actor ?? '', action, body, at].join('|'));
  const head = 'INSERT INTO audit (company_id, n, actor, action, data, prev_hash, hash, at) ';
  const vals = [companyId, n, actor ?? null, action, body, prev, hash, at];
  // Conditional lines. A skipped line consumes no number: n is only used when the row is really inserted, and
  // a concurrent writer that took the same n still makes the insert fail (PK) and the whole batch is retried.
  // onlyIf: { sql, params } - written only when `SELECT 1 FROM (sql)` finds a row at that point in the batch. Use a
  //   query that proves THIS batch's guarded write happened (e.g. the row carries a token this batch put there).
  // onlyIfChanged: written only when the statement just before it changed a row. Valid only when that guarded
  //   statement is the LAST one before the audit line.
  if (onlyIf) return [head + 'SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (' + onlyIf.sql + ')', ...vals, ...(onlyIf.params ?? [])];
  if (onlyIfChanged) return [head + 'SELECT ?,?,?,?,?,?,?,? WHERE changes() > 0', ...vals];
  return [head + 'VALUES (?,?,?,?,?,?,?,?)', ...vals];
}

/** Write `stmts` and the audit line in ONE batch. Retries only when another writer took the same audit number. */
export async function commit(ctx, companyId, actor, action, data, stmts = [], opts = {}) {
  for (let i = 0; i < 10; i++) {
    const row = await nextRow(ctx.db, companyId, actor, action, data, ctx.now(), opts);
    try {
      return await ctx.db.batch([...stmts, row]);
    } catch (e) {
      if (!/audit/i.test(String(e?.message)) || !/UNIQUE|constraint|PRIMARY/i.test(String(e?.message))) throw e;
      await new Promise((r) => setTimeout(r, 1 + Math.floor(Math.random() * 4 * (i + 1)))); // small randomised back-off; the number is read again on the next loop
    }
  }
  throw new Error('audit chain is busy');
}

export async function verifyChain(db, companyId) {
  const rows = await db.all('SELECT * FROM audit WHERE company_id = ? ORDER BY n', companyId);
  let prev = GENESIS, n = 0;
  for (const r of rows) {
    n++;
    if (r.n !== n || r.prev_hash !== prev) return { ok: false, brokenAt: r.n, rows: rows.length };
    const h = await sha256Hex([prev, r.n, r.actor ?? '', r.action, r.data, r.at].join('|'));
    if (h !== r.hash) return { ok: false, brokenAt: r.n, rows: rows.length };
    prev = r.hash;
  }
  return { ok: true, rows: rows.length };
}

/** Several audit lines (same actor) in ONE batch: the tip is read once and the lines are chained in order. Retries like commit() when another writer took a number. */
export async function commitMany(ctx, companyId, actor, lines) {
  if (!lines.length) return [];
  for (let i = 0; i < 10; i++) {
    const last = await ctx.db.first('SELECT n, hash FROM audit WHERE company_id = ? ORDER BY n DESC LIMIT 1', companyId);
    let n = last?.n ?? 0, prev = last?.hash ?? GENESIS;
    const rows = [];
    for (const { action, data } of lines) {
      n++;
      const body = JSON.stringify(scrubAudit(data ?? {}));
      const at = ctx.now();
      const hash = await sha256Hex([prev, n, actor ?? '', action, body, at].join('|'));
      rows.push(['INSERT INTO audit (company_id, n, actor, action, data, prev_hash, hash, at) VALUES (?,?,?,?,?,?,?,?)', companyId, n, actor ?? null, action, body, prev, hash, at]);
      prev = hash;
    }
    try { return await ctx.db.batch(rows); } catch (e) {
      if (!/audit/i.test(String(e?.message)) || !/UNIQUE|constraint|PRIMARY/i.test(String(e?.message))) throw e;
      await new Promise((r) => setTimeout(r, 1 + Math.floor(Math.random() * 4 * (i + 1))));
    }
  }
  throw new Error('audit chain is busy');
}
