// Cloudflare D1 behind the same port as db.js. batch() is D1's own atomic batch.
export function d1Port(d1) {
  const bind = (sql, p) => d1.prepare(sql).bind(...p.map((v) => (v === undefined ? null : v)));
  // D1 reports what each statement READ (rows scanned) and WROTE in meta; the free plan allows 5 million rows read and 100 thousand rows written per day.
  const stats = { rowsRead: 0, rowsWritten: 0 };
  const note = (meta) => { stats.rowsRead += meta?.rows_read ?? 0; stats.rowsWritten += meta?.rows_written ?? 0; };
  return {
    stats,
    async first(sql, ...p) { const r = await bind(sql, p).all(); note(r.meta); return r.results?.[0] ?? null; },
    async all(sql, ...p) { const r = await bind(sql, p).all(); note(r.meta); return r.results ?? []; },
    async run(sql, ...p) { const r = await bind(sql, p).run(); note(r.meta); return { changes: r.meta?.changes ?? 0 }; },
    async reads(stmts) { return (await d1.batch(stmts.map(([sql, ...p]) => bind(sql, p)))).map((r) => { note(r.meta); return r.results ?? []; }); }, // one batch = ONE query against the per-invocation limit
    async batch(stmts) {
      const rs = await d1.batch(stmts.map(([sql, ...p]) => bind(sql, p)));
      return rs.map((r) => { note(r.meta); return { changes: r.meta?.changes ?? 0 }; });
    },
  };
}
