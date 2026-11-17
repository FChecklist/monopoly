// Static checks on the browser files: no inline script or handlers, no markup strings, no hard-coded currency, no centre box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../public/' + p, import.meta.url), 'utf8');
const app = read('app.js'), board = read('board.js'), html = read('index.html'), css = read('style.css'), headers = read('_headers');

test('CSP: no inline script, handlers or style attributes in the page', () => {
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), 'inline script block');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'inline handler');
  assert.ok(!/\sstyle\s*=/i.test(html), 'inline style');
  assert.match(headers, /script-src 'self'/);
});
test('browser code builds the page with text nodes, never markup strings', () => {
  for (const [n, t] of [['app.js', app], ['board.js', board]]) {
    assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write|\beval\(|new Function\(/.test(t), n + ' uses markup strings');
  }
});
test('board is a six-sided track: no 7x7 grid, no centre box', () => {
  assert.ok(!/ctrbox/.test(board) && !/ctrbox/.test(css), 'centre box class is gone');
  assert.ok(!/width: 500, height: 500/.test(board), 'no big centre rectangle');
  assert.match(board, /HEX_R/);
  assert.match(board, /'class': 'badge'/, 'round soft badge in the middle');
});
test('currency is never hard-coded: names, symbols and rates come from settings', () => {
  assert.match(app, /credits_per_usd/);
  assert.match(app, /local_per_usd/);
  assert.ok(!/US\$\s*\d/.test(app), 'no fixed dollar amounts');
  assert.ok(!/'MP'|"MP"|'MC'|"MC"/.test(app), 'no fixed unit symbol');
});
test('terms link only for https urls from config', () => {
  assert.match(app, /terms_url/);
  assert.match(app, /\^https:/);
});
test('new screens are wired: swaps, buy, rights resolve, bonus roll, AI access', () => {
  for (const needle of ['/api/swaps', '/api/admin/buy', '/resolve', 'rollNote', '/api/admin/ai-requests', '/api/admin/ai/toggle']) assert.ok(app.includes(needle), needle);
});

// ---- round 2: every path the page calls exists on the server; the AI accept screen is complete; no bare currency words ----
const apiSrc = readFileSync(new URL('../src/api.js', import.meta.url), 'utf8');
const idSeg = (p) => p.split('/').map((x) => (x.startsWith(':') ? ':id' : x)).join('/');
const serverRoutes = [...apiSrc.matchAll(/route\('(GET|POST|PUT|DELETE)', '([^']+)'/g)].map((m) => [m[1], idSeg(m[2])]);
/** Reads every get(...) / post(...) / api('M', ...) / fetch(...) call: the first argument is split on top-level +, literals are kept, anything dynamic becomes :id. */
export function pagePaths(src) {
  const out = [];
  const re = /(?:\b(get|post)\(|\bapi\('(GET|POST|PUT|DELETE)',\s*|\bfetch\()\s*(?=')/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length, depth = 0;
    const parts = [];
    let cur = '';
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === "'") { const j = src.indexOf("'", i + 1); cur += src.slice(i, j + 1); i = j; continue; }
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) break; depth--; }
      if (ch === ',' && depth === 0) break;
      if (ch === '+' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    parts.push(cur.trim());
    let path = '';
    for (const part of parts) {
      if (/^'/.test(part)) path += part.slice(1, -1);
      else if (path.endsWith('/')) path += ':id';
    }
    path = path.split('?')[0];
    if (!path.startsWith('/api/')) continue;
    out.push([m[1] ? m[1].toUpperCase() : m[2] ? m[2] : 'GET', path]);
  }
  return out;
}
test('every path the page calls is a route the server registers (method and shape)', () => {
  const paths = pagePaths(app);
  assert.ok(paths.length > 60, 'found the calls: ' + paths.length);
  const missing = paths.filter(([m, p]) => !serverRoutes.some(([sm, sp]) => sm === m && sp === idSeg(p)));
  assert.deepEqual(missing, [], 'the page calls routes the server does not have');
  assert.ok(paths.some(([m, p]) => m === 'POST' && p === '/api/admin/ai/toggle'));
  assert.ok(!paths.some(([, p]) => p === '/api/admin/ai/enable'));
});
test('AI accept screen shows the operation, the money flag, the payload fields, the expiry and the key before Accept and Reject', () => {
  const i = app.indexOf("var reqs = panel('Requests waiting'"), j = app.indexOf('return [intro, master, keys, reqs]');
  const block = app.slice(i, j);
  for (const needle of ['opLabel(x.op)', 'x.money_op', 'payloadList(x)', 'x.expires_at', 'x.key_id', 'x.class', "'Accept'", "'Reject'"]) assert.ok(block.includes(needle), needle);
  assert.ok(block.indexOf('payloadList(x)') < block.indexOf("'Reject'"), 'details come before the buttons');
  assert.ok(!/'Person '\s*\+\s*tail\(x\.person_id\)/.test(block), 'no person line built from a possibly missing id');
  const pl = app.slice(app.indexOf('function payloadList'), app.indexOf('function adminAi'));
  assert.match(pl, /if \(v === null \|\| v === void 0 \|\| v === ''\) return;/, 'a missing field prints nothing (no "Person undefined")');
  assert.ok(!/innerHTML/.test(pl + block));
});
test('currency: no bare credits word, "$" or unit symbol in a visible string; every amount goes through cur()/curText()', () => {
  const body = app.split(String.fromCharCode(13, 10)).join(String.fromCharCode(10)).replace(/function priceOf[\s\S]*?\n {2}\}\n/, ''); // the one place that builds the real-money price text
  const lits = [...body.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)].map((m) => m[1]);
  assert.deepEqual(lits.filter((t) => /\bcredits\b/i.test(t) && t !== 'credits'), [], 'bare "credits" in visible text: use unitName()');
  assert.deepEqual(lits.filter((t) => /\$/.test(t)), [], 'bare $ in a visible string');
  assert.deepEqual(lits.filter((t) => /\b(MP|MC)\b/.test(t)), [], 'bare unit symbol');
  assert.ok(!/num\([^)]*\)\s*\+\s*' '\s*\+\s*unitName\(\)/.test(body.replace(/function curText[^\n]*\n/, '')), 'num(x) + unitName() glued by hand');
  for (const needle of ['cur(r.bonus)', 'cur(c.amount)', 'cur(r.total_credits)', 'cur(o.used_budget)', 'cur(b.spendable', "['Lap gift: ', cur(e.credits)"]) assert.ok(app.includes(needle), needle);
});
