// Cloudflare D1 behind the same port as db.js. batch() is D1's own atomic batch.
export function d1Port(d1) {
  const bind = (sql, p) => d1.prepare(sql).bind(...p.map((v) => (v === undefined ? null : v)));
  return {
    async first(sql, ...p) { return (await bind(sql, p).first()) ?? null; },
    async all(sql, ...p) { return (await bind(sql, p).all()).results ?? []; },
    async run(sql, ...p) { const r = await bind(sql, p).run(); return { changes: r.meta?.changes ?? 0 }; },
    async reads(stmts) { return (await d1.batch(stmts.map(([sql, ...p]) => bind(sql, p)))).map((r) => r.results ?? []); }, // one batch = ONE query against the per-invocation limit
    async batch(stmts) {
      const rs = await d1.batch(stmts.map(([sql, ...p]) => bind(sql, p)));
      return rs.map((r) => ({ changes: r.meta?.changes ?? 0 }));
    },
  };
}
