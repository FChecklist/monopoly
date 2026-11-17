// Writes CONTRACT/openapi-v1.json from the operations table in src/aiapi.js. `node scripts/make-openapi.js --check` only compares.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openApiText } from '../src/aiapi.js';

export const OUT = fileURLToPath(new URL('../CONTRACT/openapi-v1.json', import.meta.url));
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = openApiText();
  if (process.argv.includes('--check')) {
    let cur = '';
    try { cur = readFileSync(OUT, 'utf8'); } catch { /* missing */ }
    if (cur !== text) { console.error('CONTRACT/openapi-v1.json is out of date. Run: node scripts/make-openapi.js'); process.exit(1); }
    console.log('openapi-v1.json is up to date.');
  } else { writeFileSync(OUT, text); console.log('Wrote', OUT); }
}
