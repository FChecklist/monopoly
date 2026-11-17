// Local server: node:sqlite file in .data, the same API code, static files from public/. No cloud, no cost.
// Fails closed: without SEAL_KEY and MASTER_SECRET (32+ characters each) it only starts when NODE_ENV=dev, with throw-away dev secrets.
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, extname, resolve, relative, isAbsolute } from 'node:path';
import { openDb, migrate, migrateDev } from '../src/db.js';
import { makeCtx } from '../src/ctx.js';
import { handle } from '../src/api.js';
import { createCompany } from '../src/people.js';

const dev = process.env.NODE_ENV === 'dev';
const SEAL_KEY = process.env.SEAL_KEY ?? (dev ? 'dev-only-seal-key-change-me-0123456789abcdef' : '');
const MASTER_SECRET = process.env.MASTER_SECRET ?? (dev ? 'dev-only-master-secret-change-me-0123456789ab' : '');
if (SEAL_KEY.length < 32 || MASTER_SECRET.length < 32) {
  console.error('Refusing to start: set SEAL_KEY and MASTER_SECRET (32+ characters each), or run with NODE_ENV=dev for throw-away dev secrets.');
  process.exit(1);
}
const MAX_BODY = 1_500_000;
mkdirSync('.data', { recursive: true });
const db = openDb('.data/dev.sqlite');
migrate(db);
migrateDev(db); // demo-provider tables: local harness only
const env = { SEAL_KEY, MASTER_SECRET, ALLOW_DEMO_PROVIDER: dev ? '1' : process.env.ALLOW_DEMO_PROVIDER, PLATFORM_TOKEN: process.env.PLATFORM_TOKEN, AI_KILL: process.env.AI_KILL, HUB_STATUS_URL: process.env.HUB_STATUS_URL, HUB_PRODUCT_CODE: process.env.HUB_PRODUCT_CODE };
const ctx = makeCtx({ db, env });
if (!(await db.first('SELECT id FROM company LIMIT 1'))) {
  const r = await createCompany(ctx, { name: 'Demo Company', slug: 'demo', adminEmail: 'admin@demo.test' });
  console.log('Demo admin: admin@demo.test  code:', r.code);
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const root = resolve('public');
/** The file for a URL path, only if it is inside public/. Anything else (including sibling folders like public-old) gets the front page. */
function fileFor(pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname); } catch { return join(root, 'index.html'); }
  const p = resolve(join(root, rel));
  const r = relative(root, p);
  if (!r || r.startsWith('..') || isAbsolute(r) || !existsSync(p) || !statSync(p).isFile()) return join(root, 'index.html');
  return p;
}
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:8788');
  if (url.pathname.startsWith('/api/')) {
    let body;
    if (!['GET', 'HEAD'].includes(req.method)) {
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_BODY) { res.writeHead(413, { 'content-type': 'application/json' }); return res.end('{"ok":false,"error":{"code":"too_big","message":"Request is too large."}}'); }
      body = await new Promise((r) => { const parts = []; let n = 0; req.on('data', (d) => { n += d.length; if (n <= MAX_BODY + 1) parts.push(d); }); req.on('end', () => r(Buffer.concat(parts).toString('utf8'))); });
    }
    const out = await handle(ctx, new Request(url, { method: req.method, headers: req.headers, body }));
    res.writeHead(out.status, Object.fromEntries(out.headers));
    return res.end(await out.text());
  }
  const p = fileFor(url.pathname);
  res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' });
  res.end(readFileSync(p));
}).listen(8788, '127.0.0.1', () => console.log('http://localhost:8788'));
