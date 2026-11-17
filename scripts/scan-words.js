// Fails if a shipped file (code, pages, schema, docs, tests) contains a word that belongs to somebody else's game or trade dress.
// The brand is only the product_name config string in src/config.js (allowed there, nowhere else).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The list is stored split (a | inside each long word) so this file does not contain the words it looks for and passes its own scan.
const PARTS = ['mo|nopoly', 'ha|sbro', 'ch|ance', 'co|mmunity ch|est', 'ja|il', 'fr|ee pa|rking', 'bo|ardwalk', 'pa|rk pl|ace', 'ma|yfair', 'ma|rvin ga|rdens', 'to|p ha|t', 'th|imble', 'wh|eelbarrow', 'pa|ss go', 'go to ja|il', 'lo|ttery', 'ja|ckpot', 'b|et', 'win ca|sh', 'fi|ned', 'rail|road', 'inc|ome tax', 'lux|ury tax', 'get ou|t of', 'board|walk', 'park pl|ace', 'mediter|ranean', 'bal|tic', 'marvin gar|dens', 'top h|at', 'scot|tie', 'thim|ble', 'wheel|barrow', 'battle|ship'];
export const FORBIDDEN = PARTS.map((w) => w.split('|').join(''));
const SHIPPED = ['src', 'public', 'migrations', 'functions', 'scripts', 'CONTRACT', 'docs', 'test', 'README.md', 'wrangler.toml', 'package.json'];

// Small explicit allowlist. Everything else is scanned.
const ALLOW_LINE = [
  { file: 'src/config.js', re: /^\s*name: 'Corporate Mon[a-z]+',\s*\/\/ product_name/ },          // the one brand string
  { file: 'docs/REGISTRY-NOTE.md', re: /trademark/i },                                         // the trademark-risk sentence
];
const ALLOW_FILE = [
  'wrangler.toml',            // owner-chosen project and database names (infrastructure, not screen text)
];

export function scan(root = '.') {
  const hits = [];
  const rootAbs = resolve(root);
  const walk = (p) => {
    const s = statSync(p);
    const rel = relative(rootAbs, p).split(sep).join('/');
    if (ALLOW_FILE.some((f) => rel === f || rel.startsWith(f + '/'))) return;
    if (s.isDirectory()) { for (const n of readdirSync(p)) if (n !== 'node_modules' && n !== '.git') walk(join(p, n)); return; }
    if (!/\.(js|json|html|css|svg|sql|toml|txt|md)$/i.test(p) && !/_headers$/.test(p)) return;
    readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
      if (ALLOW_LINE.some((a) => a.file === rel && a.re.test(line))) return;
      const low = line.toLowerCase();
      for (const w of FORBIDDEN) if (new RegExp('\\b' + w.replace(/ /g, '\\s+') + '\\b').test(low)) hits.push(`${rel}:${i + 1}: "${w}"`);
    });
  };
  for (const s of SHIPPED) { try { walk(resolve(rootAbs, s)); } catch { /* optional path */ } }
  return hits;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const hits = scan('.');
  if (hits.length) { console.error('Forbidden words found:\n' + hits.join('\n')); process.exit(1); }
  console.log('Word scan clean.');
}
