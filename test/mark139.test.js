// Guard: every page source carries exactly one approved 139 mark, and the approved CSS is intact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../', import.meta.url).pathname;
function pages(dir) {
  let out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out = out.concat(pages(p));
    else if (/\.html?$/i.test(n)) out.push(p);
  }
  return out;
}
const files = pages(join(root, 'public'));
const MARK = '<div class="mark139" lang="hi" aria-hidden="true"><span>१३९</span></div>';

test('at least one page exists', () => assert.ok(files.length >= 1));
test('every page has exactly one approved mark as first child of body', () => {
  for (const f of files) {
    const t = readFileSync(f, 'utf8');
    assert.equal((t.match(/class="mark139"/g) || []).length, 1, f);
    assert.ok(t.includes(MARK), f + ' markup differs');
    assert.match(t, /<body[^>]*>\s*<div class="mark139"/, f + ' mark is not first in body');
  }
});
test('shared stylesheet holds the approved CSS once', () => {
  const css = readFileSync(join(root, 'public/style.css'), 'utf8');
  assert.equal((css.match(/\.mark139\{/g) || []).length, 1);
  const m = css.match(/\.mark139\{[^}]*\}/)[0];
  for (const s of ['position:absolute', 'top:0', 'pointer-events:none', 'user-select:none', 'font-size:6px', 'font-weight:700', 'color:#0B2A6B', 'text-align:center']) assert.ok(m.includes(s), s);
  const sp = css.match(/\.mark139 span\{[^}]*\}/)[0];
  assert.ok(sp.includes('border-bottom:.5px solid #7A1010') && sp.includes('padding-bottom:.5px'));
  for (const f of files) assert.match(readFileSync(f, 'utf8'), /href="\/style\.css"/, f + ' does not load style.css');
});
