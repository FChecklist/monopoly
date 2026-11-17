// Simple secret scan for everything that would be committed. Run before every push (gitleaks is run as well when present).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\bghp_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/, 'GitHub token'],
  [/\bsk-[A-Za-z0-9]{20,}\b/, 'API key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'cloud key id'],
  [/\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\b/, 'JWT'],
  [/\b(cfut_|cfat_)[A-Za-z0-9]{20,}\b/, 'Cloudflare token'],
  [/(secret|token|password|api[_-]?key)\s*[:=]\s*['"][A-Za-z0-9+/_-]{24,}['"]/i, 'assigned secret'],
  [/\b[0-9a-f]{64}\b/, 'long hex string'],
  [/[A-Za-z0-9._%+-]+@(?!acme\.test|demo\.test|other\.test|newco\.test|x\.test|y\.test|test\.example|example\.(com|org)|acme\.example)[A-Za-z0-9.-]+\.[a-z]{2,}/i, 'e-mail address'],
];
const SKIP_DIRS = new Set(['node_modules', '.git', '.data', '.wrangler']);

export function scan(root = '.') {
  const hits = [];
  const walk = (p) => {
    const s = statSync(p);
    if (s.isDirectory()) { for (const n of readdirSync(p)) if (!SKIP_DIRS.has(n)) walk(join(p, n)); return; }
    if (s.size > 2_000_000) return;
    const rel = relative(root, p).replace(/\\/g, '/');
    if (/^\.env/.test(rel.split('/').pop())) hits.push(`${rel}: env file must not be committed`);
    const text = readFileSync(p, 'utf8');
    text.split('\n').forEach((line, i) => {
      for (const [re, name] of PATTERNS) {
        const m = line.match(re);
        if (!m) continue;
        if (name === 'long hex string' && /sha256|hash|\.hash|digest|0{64}/i.test(line)) continue;
        if (rel.startsWith('test/') && ['assigned secret', 'e-mail address', 'long hex string'].includes(name)) continue; // obvious fixtures
        if (name === 'e-mail address' && /hello@lucifertech\.com|noreply@anthropic\.com/.test(line)) continue;
        hits.push(`${rel}:${i + 1}: ${name}`);
      }
    });
  };
  walk(resolve(root));
  return hits;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const hits = scan('.');
  if (hits.length) { console.error('Possible secrets:\n' + hits.join('\n')); process.exit(1); }
  console.log('Secret scan clean.');
}
