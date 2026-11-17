// Round 3 audit fixes (fixer G): nested-value wage guard, widget meta and trust header, look-alike spellings, resume by another admin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exampleCard } from './helpers.js';
import { boot, keyCall } from './webhelp.js';
import { createKey } from '../src/setup.js';
import { setAiEnabled, decideRequest, mentionsMoney } from '../src/aiapi.js';

let n = 0;
const idem = () => 'r3-idem-' + (++n) + '-abcdef';
async function setup() {
  const w = await boot({ settings: { daily_event_limit: 1000 } });
  w.ctx.env = { ...w.ctx.env };
  await exampleCard(w);
  w.keys = {};
  for (const s of ['read', 'ai_read']) w.keys[s] = await createKey(w.ctx, w.company, w.admin, { scope: s, label: s });
  await setAiEnabled(w.ctx, w.company, w.admin, true); await w.reload();
  w.post = (k, p, b) => keyCall(w, w.keys[k], 'POST', p, b, { 'idempotency-key': idem() });
  return w;
}

test('G1: nested arrays and objects cannot smuggle a wage or salary ask into a penalty', async () => {
  const w = await setup();
  const p = w.people.a.id;
  const bad = [
    { op: 'penalty.propose', payload: { person_id: p, effect: 'points', amount: 5, reason: ['cut salary'] } },
    { op: 'penalty.propose', payload: { person_id: p, effect: 'points', amount: 5, event_type: { a: 'deduct wages' } } },
    { op: 'penalty.propose', payload: { person_id: p, effect: 'points', amount: '5' } },
    { op: 'penalty.rule.change', payload: { effect: 'points', reason: { x: ['cut salary'] } } },
    { op: 'penalty.rule.change', payload: { effect: 'points', event_type: ['deduct wages'] } },
  ];
  for (const b of bad) { w.clock.t += 25000; const r = await w.post('ai_read', '/api/v1/proposals', b); assert.equal(r.status, 422, JSON.stringify(b)); assert.equal(r.json.error.code, 'penalty_points_only'); }
});

test('G2: the older widget routes answer with meta and x-content-trust, errors included', async () => {
  const w = await setup();
  for (const p of ['targets', 'achievements', 'board-summary']) {
    const r = await keyCall(w, w.keys.read, 'GET', '/api/v1/widgets/' + p);
    assert.equal(r.status, 200); assert.equal(r.headers.get('x-content-trust'), 'untrusted-data', p);
    assert.equal(r.json.ok, true); assert.equal(r.json.v, 1); assert.ok(r.json.meta && r.json.meta.rule, p);
  }
  const t = await keyCall(w, w.keys.read, 'GET', '/api/v1/widgets/targets');
  assert.deepEqual(t.json.meta.untrusted_text_fields, ['targets[].name']);
  const denied = await keyCall(w, w.keys.ai_read, 'GET', '/api/v1/widgets/targets');
  assert.equal(denied.status, 403); assert.equal(denied.headers.get('x-content-trust'), 'untrusted-data'); assert.ok(denied.json.meta);
  const bad = await keyCall(w, { key_id: 'nope', secret: 'x' }, 'GET', '/api/v1/widgets/targets');
  assert.ok(bad.status >= 400); assert.equal(bad.headers.get('x-content-trust'), 'untrusted-data'); assert.ok(bad.json.meta);
});

test('G3: zero-width, soft-hyphen, spaced and look-alike spellings of money words are caught', () => {
  for (const t of ['sal\u200Bary cut', 'sal\u00ADary', 's a l a r y', 's.a-l_a.r y', 'sal\u0430ry', 'W\u0430ges', 'p\u0430yroll', 'd\u0435duct', 'sal\u03B1ry', 'wag\u0435s']) assert.equal(mentionsMoney(t), true, JSON.stringify(t));
  for (const t of ['Late to the stand-up', 'steps back two', 'repeated late entries']) assert.equal(mentionsMoney(t), false, t);
});

test('G4: an accepted request resumed by a different admin finds the existing event', async () => {
  const w = await setup();
  const d = await w.post('ai_read', '/api/v1/proposals', { op: 'event.submit', payload: { person_id: w.people.b.id, event_type: 'game', stage: 'created', ext_id: 'G4-1' }, reason: 'r' });
  const first = await decideRequest(w.ctx, w.company, w.admin, d.json.id, true);
  assert.equal(first.result.executed, true);
  await w.db.run("UPDATE ai_request SET run_state = 'running' WHERE id = ?", d.json.id);
  const other = await decideRequest(w.ctx, w.company, { id: 'usr_other_admin', role: 'admin' }, d.json.id, true);
  assert.equal(other.result.executed, true);
  assert.equal(other.result.event_id, first.result.event_id);
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM event WHERE ext_id = 'G4-1'")).n, 1);
});
