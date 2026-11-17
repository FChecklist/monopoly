// Database port: first / all / run / batch. Local harness = node:sqlite. Cloudflare = d1.js.
// batch() is all-or-nothing. Anything that must be atomic goes in one batch.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));

export function openDb(path = ':memory:') {
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA foreign_keys = ON');
  let lock = Promise.resolve();
  return {
    raw,
    async first(sql, ...p) { return raw.prepare(sql).get(...p) ?? null; },
    async all(sql, ...p) { return raw.prepare(sql).all(...p); },
    async run(sql, ...p) { return { changes: Number(raw.prepare(sql).run(...p).changes) }; },
    /** stmts: array of [sql, ...params]. Returns array of {changes}. */
    async batch(stmts) {
      const prev = lock;
      let release;
      lock = new Promise((r) => (release = r));
      await prev;
      try {
        raw.exec('BEGIN IMMEDIATE');
        try {
          const out = stmts.map(([sql, ...p]) => ({ changes: Number(raw.prepare(sql).run(...p).changes) }));
          raw.exec('COMMIT');
          return out;
        } catch (e) {
          raw.exec('ROLLBACK');
          throw e;
        }
      } finally {
        release();
      }
    },
    exec(sql) { raw.exec(sql); },
  };
}
function runDir(db, dirName) {
  const dir = join(here, '..', dirName);
  db.exec('CREATE TABLE IF NOT EXISTS _migration (name TEXT PRIMARY KEY, at INTEGER NOT NULL)');
  const done = new Set(db.raw.prepare('SELECT name FROM _migration').all().map((r) => r.name));
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    const key = dirName === 'migrations' ? f : dirName + '/' + f;
    if (done.has(key)) continue;
    db.exec(readFileSync(join(dir, f), 'utf8'));
    db.raw.prepare('INSERT INTO _migration (name, at) VALUES (?, ?)').run(key, Date.now());
  }
}
/** PRODUCTION schema: runs every migrations/*.sql in name order, each once (recorded in _migration). Reads ONLY migrations/ (same set D1 gets). */
export function migrate(db) { runDir(db, 'migrations'); }
/** LOCAL HARNESS ONLY: demo-provider tables from migrations-dev/. Never applied to D1. The stub provider calls this itself. */
export function migrateDev(db) { runDir(db, 'migrations-dev'); }
