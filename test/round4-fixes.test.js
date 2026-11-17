// Round 4 audit fixes (fixer I): money-word spellings, unit-name guard, resume person check, work_id subject, OpenAPI text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exampleCard } from './helpers.js';
import { boot, keyCall } from './webhelp.js';
import { createKey } from '../src/setup.js';
import { setAiEnabled, mentionsMoney, guardPenalty, buildOpenApi } from '../src/aiapi.js';

test('I1: Indian-language, leet and letter-spaced money words are caught; clean words stay accepted', () => {
  for (const t of ['वेतन कटौती', 'तनख्वाह', 'जुर्माना', 'पगार', 'sa1ary cut', 'd0ck him', 'w@ges', 'p a y', 'f i n e', 'f.i.n.e', 'p-a-y', 'p*a*y', 'p4y cut', 'f1ne', 'sal4ry']) assert.equal(mentionsMoney(t), true, t);
  for (const t of ['points', 'steps', 'coaching note', 'team lunch', 'Lost 5 points for a late game', '3 steps back', 'payload review', 'refine the plan', 'Level 4 raid at 5pm', 'spay', 'a b test', 'Team 3 won']) assert.equal(mentionsMoney(t), false, t);
});

test('I2: an admin unit name of Points does not block every penalty proposal', () => {
  const ok = { person_id: 'u1', effect: 'points', amount: 5, reason: 'late' };
  assert.doesNotThrow(() => guardPenalty(ok, 'late', 'Points'));
  assert.doesNotThrow(() => guardPenalty({ person_id: 'u1', effect: 'steps_back', amount: 2 }, 'coaching note', 'Points'));
  assert.throws(() => guardPenalty({ ...ok, reason: 'lost points' }, 'lost points', 'Points'), (e) => e.code === 'penalty_points_only');
  assert.throws(() => guardPenalty({ ...ok, effect: 'points', reason: 'deduct' }, 'deduct wages', 'Points'), (e) => e.code === 'penalty_points_only');
});

test('I4: the OpenAPI text says the older widget routes carry meta and trust, and list hub errors', () => {
  const spec = buildOpenApi();
  const g = spec.paths['/api/v1/widgets/targets'].get;
  const ok = g.responses['200'];
  assert.ok(!/not on the older/.test(ok.headers['x-content-trust'].description));
  assert.ok(ok.content['application/json'].example.meta);
  assert.ok(g['x-errors'].includes('hub_off') && g['x-errors'].includes('hub_action_disabled'));
  assert.equal(readFileSync('CONTRACT/openapi-v1.json', 'utf8').includes('not on the older widget routes'), false);
});

let n = 0;
const idem = () => 'r4-idem-' + (++n) + '-abcdef';
test('I3 and I5: resume/existing id must be the same person; work_id links idempotent answers to the person', async () => {
  const w = await boot({ settings: { daily_event_limit: 1000 } });
  w.ctx.env = { ...w.ctx.env };
  await exampleCard(w);
  const key = await createKey(w.ctx, w.company, w.admin, { scope: 'ai_read', label: 'ai' });
  await setAiEnabled(w.ctx, w.company, w.admin, true); await w.reload();
  const { decideRequest } = await import('../src/aiapi.js');
  const a = w.people.a.id, b = w.people.b.id;
  const mk = async (person, ext) => {
    w.clock.t += 25000;
    const r = await keyCall(w, key, 'POST', '/api/v1/proposals', { op: 'event.submit', payload: { person_id: person, event_type: 'game', stage: 'created', ext_id: ext } }, { 'idempotency-key': idem() });
    return r.json.proposal?.id ?? r.json.id;
  };
  const id1 = await mk(a, 'same-ext-1');
  const d1 = await decideRequest(w.ctx, w.company, w.admin, id1, true);
  assert.equal(d1.result.executed, true);
  const id2 = await mk(b, 'same-ext-1');
  const d2 = await decideRequest(w.ctx, w.company, w.admin, id2, true);
  assert.equal(d2.result.executed, false);
  assert.equal(d2.result.refused, 'person_mismatch');
  assert.notEqual(d2.result.resumed, true);
  // the same person again is still found, not made twice
  const id3 = await mk(a, 'same-ext-1');
  const d3 = await decideRequest(w.ctx, w.company, w.admin, id3, true);
  assert.equal(d3.result.executed, true); assert.equal(d3.result.event_id, d1.result.event_id);
});
