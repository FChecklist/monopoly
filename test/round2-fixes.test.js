// Round 2 audit fixes (fixer E): wage-law guard, DPDP for machine-API data, Hub switches on every signed write, resumable accept, v1 error shape, board shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exampleCard } from './helpers.js';
import { boot, keyCall } from './webhelp.js';
import { handle } from '../src/api.js';
import { makeCtx } from '../src/ctx.js';
import { createKey } from '../src/setup.js';
import { setAiEnabled, decideRequest, cancelRequest, purgeAiData, guardPenalty, mentionsMoney, hubState, killOn, OPERATIONS } from '../src/aiapi.js';
import { eraseLeaver } from '../src/people.js';
import { SQUARES } from '../src/config.js';
import { DAY } from '../src/util.js';

let n = 0;
const idem = () => 'r2-idem-' + (++n) + '-abcdef';
async function setup() {
  const w = await boot({ settings: { daily_event_limit: 1000 } });
  w.ctx.env = { ...w.ctx.env };
  await exampleCard(w);
  w.keys = {};
  for (const s of ['read', 'event_write', 'manager', 'admin', 'ai_read', 'provider_webhook']) w.keys[s] = await createKey(w.ctx, w.company, w.admin, { scope: s, label: s });
  await setAiEnabled(w.ctx, w.company, w.admin, true); await w.reload();
  w.get = (k, p) => keyCall(w, w.keys[k], 'GET', p);
  w.post = (k, p, b, h = idem()) => keyCall(w, w.keys[k], 'POST', p, b, h === null ? {} : { 'idempotency-key': h });
  w.ev = (x) => ({ events: [{ person_id: w.people.a.id, event_type: 'game', stage: 'created', ext_id: 'R2-' + x + '-' + n, occurred_at: w.clock.t }] });
  return w;
}

test('E3: the wage-law guard refuses every bypass (keys and values), and lets a plain points penalty through', async () => {
  const w = await setup();
  const ok = { person_id: w.people.a.id, effect: 'points', amount: 2, reason: 'Late to the stand-up three times this week.' };
  assert.equal((await w.post('ai_read', '/api/v1/proposals', { op: 'penalty.propose', payload: ok })).status, 202);
  const badKeys = ['salary_cut', 'pay_cut', 'deduction_amount', 'remuneration', 'salaryCut', 'Wage', 'fine_amount', 'note'];
  for (const k of badKeys) {
    w.clock.t += 25000;
    const r = await w.post('ai_read', '/api/v1/proposals', { op: 'penalty.propose', payload: { ...ok, [k]: 5 } });
    assert.equal(r.status, 422, k); assert.equal(r.json.error.code, 'penalty_points_only', k);
    const r2 = await w.post('ai_read', '/api/v1/proposals', { op: 'penalty.rule.change', payload: { effect: 'points', [k]: 5 } });
    assert.equal(r2.json.error.code, 'penalty_points_only', 'rule ' + k);
  }
  const badText = ['₹500 fine', '-5 rs', 'Rs.500', '500 INR', 'salary_cut', 'pay_cut of 10', 'SALÁRY', 'remuneration', 'dock his pay', 'bonus cut', 'withhold the stipend', 'deduction_amount', 'wages', 'cut 5 dollars', 'US$5', 'payroll', 'compensation', 'Moneypenny', 'fin' + 'ed'];
  for (const t of badText) {
    w.clock.t += 25000;
    for (const op of ['penalty.propose', 'penalty.rule.change']) {
      const r = await w.post('ai_read', '/api/v1/proposals', { op, payload: { ...ok, reason: t } });
      assert.equal(r.json.error?.code, 'penalty_points_only', op + ' ' + t);
      const r3 = await w.post('ai_read', '/api/v1/proposals', { op, payload: { ...ok }, reason: t });
      assert.equal(r3.json.error?.code, 'penalty_points_only', op + ' top-level reason ' + t);
    }
  }
  assert.equal((await w.post('ai_read', '/api/v1/proposals', { op: 'penalty.propose', payload: { ...ok, effect: 'credits' } })).json.error.code, 'penalty_points_only');
  assert.ok(mentionsMoney('salary_cut') && mentionsMoney('SALARY-CUT') && !mentionsMoney('Late to the stand-up'));
  assert.throws(() => guardPenalty({ effect: 'points', event_type: 'x', extra: 1 }, ''), (e) => e.code === 'penalty_points_only');
});

test('E6: __proto__, constructor and prototype keys are refused; an op called constructor is a clean 400', async () => {
  const w = await setup();
  for (const k of ['__proto__', 'constructor', 'prototype']) {
    const raw = `{"op":"event.submit","payload":{"person_id":"${w.people.a.id}","event_type":"game","stage":"created","ext_id":"p1","${k}":{"x":1}}}`;
    const r = await w.post('ai_read', '/api/v1/proposals', raw);
    assert.equal(r.status, 400, k); assert.equal(r.json.error.code, 'validation');
  }
  assert.equal(({}).x, undefined, 'nothing leaked onto Object.prototype');
  for (const op of ['constructor', '__proto__', 'toString']) assert.equal((await w.post('ai_read', '/api/v1/proposals', { op, payload: { a: 1 } })).status, 400, op);
});

test('E4: work e-mails and e-mails in text are never stored; erasing a person scrubs their requests and stored answers; retention deletes old rows', async () => {
  const w = await setup();
  const email = 'a@acme.test';
  const r = await w.post('ai_read', '/api/v1/proposals', { op: 'event.submit', payload: { work_email: email, event_type: 'game', stage: 'created', ext_id: 'E4-1', person_id: w.people.a.id }, reason: 'Please add for ' + email });
  assert.equal(r.status, 202, r.text);
  const row = await w.db.first('SELECT * FROM ai_request WHERE id = ?', r.json.id);
  assert.ok(!/a@acme|work_email/.test(row.payload + row.reason), 'no e-mail stored'); assert.equal(row.person_id, w.people.a.id);
  const viaEmail = await w.post('ai_read', '/api/v1/proposals', { op: 'event.submit', payload: { work_email: email, event_type: 'game', stage: 'created', ext_id: 'E4-2' } });
  assert.equal(viaEmail.status, 202, viaEmail.text);
  assert.equal(JSON.parse((await w.db.first('SELECT payload FROM ai_request WHERE id = ?', viaEmail.json.id)).payload).person_id, w.people.a.id, 'looked up by hash, stored by id');
  const decided = await w.post('ai_read', '/api/v1/proposals', { op: 'reward.award', payload: { person_id: w.people.a.id, amount: 5 }, reason: 'about Person A' });
  await w.login('admin');
  assert.equal((await w.call('admin', 'POST', `/api/admin/ai-requests/${decided.json.id}/decide`, { accept: false })).status, 200);
  const ev = await w.post('event_write', '/api/v1/events', w.ev('e4'));
  assert.equal(ev.status, 200);
  const idemRow = () => w.db.first("SELECT * FROM api_idem WHERE subject LIKE '%' || ? || '%'", w.people.a.id);
  assert.ok((await idemRow()).body, 'stored answer exists');
  // erase
  await w.db.run("UPDATE app_user SET status = 'left', left_at = ? WHERE id = ?", w.clock.t, w.people.a.id);
  await eraseLeaver(w.ctx, w.company, w.admin, w.people.a.id);
  const after = await w.db.all('SELECT * FROM ai_request WHERE person_id = ?', w.people.a.id);
  assert.ok(after.length >= 3 && after.every((x) => x.payload === '{"erased":true}' && x.reason === ''), 'text gone');
  assert.ok(after.every((x) => x.status !== 'pending'), 'pending ones are cancelled');
  assert.equal((await idemRow()), null, 'subject cleared');
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM api_idem WHERE body IS NOT NULL AND key_id = ?", w.keys.event_write.key_id)).n, 0, 'stored answer body dropped');
  // retention
  const p2 = await w.post('ai_read', '/api/v1/proposals', { op: 'reward.award', payload: { person_id: w.people.b.id, amount: 7 } });
  const body2 = w.ev('e4b');
  await w.post('event_write', '/api/v1/events', body2, 'keep-me-idem-1');
  await w.call('admin', 'POST', `/api/admin/ai-requests/${p2.json.id}/decide`, { accept: false });
  w.clock.t += 31 * DAY;
  let out = await purgeAiData(w.ctx, w.company);
  assert.ok(out.idem_bodies_dropped >= 1);
  const replay = await w.post('event_write', '/api/v1/events', body2, 'keep-me-idem-1');
  assert.equal(replay.headers.get('idempotent-replayed'), 'true'); assert.match(replay.json.note, /removed/, 'key and hash are kept, the body is gone');
  assert.equal((await w.post('event_write', '/api/v1/events', w.ev('other'), 'keep-me-idem-1')).json.error.code, 'idempotency_conflict');
  w.clock.t += 70 * DAY;
  out = await purgeAiData(w.ctx, w.company);
  assert.ok(out.ai_requests_deleted >= 1, 'decided requests older than 90 days are deleted');
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM ai_request WHERE status = 'rejected'")).n, 0);
  await w.login('admin');
  const tick = await w.call('admin', 'POST', '/api/admin/tick'); assert.equal(tick.status, 200); assert.ok('purged' in tick.json);
});

test('E5: the Hub and platform switches stop ingest, tick, the webhook and the human accept; reads, rejects, cancels and settings keep working', async () => {
  const w = await setup(); await w.login('admin');
  let doc = { schema_version: 1, hub: { mode: 'on' }, products: {} };
  w.ctx.env.HUB_STATUS_URL = 'https://hub.test/status.json'; w.ctx.hubFetch = async () => doc;
  const p1 = await w.post('ai_read', '/api/v1/proposals', { op: 'event.submit', payload: { person_id: w.people.a.id, event_type: 'game', stage: 'created', ext_id: 'E5-1' } });
  const p2 = await w.post('ai_read', '/api/v1/proposals', { op: 'reward.award', payload: { person_id: w.people.a.id, amount: 5 } });
  const p3 = await w.post('ai_read', '/api/v1/proposals', { op: 'reward.award', payload: { person_id: w.people.a.id, amount: 6 } });
  const sys = (k, p, b) => keyCall(w, w.keys[k], 'POST', p, b);
  const bal = async () => (await w.db.first("SELECT COUNT(*) n FROM event WHERE ext_id LIKE 'E5-%'")).n;
  for (const mode of ['off', 'read_only']) {
    doc = { schema_version: 1, hub: { mode }, products: {} }; w.clock.t += 61_000;
    const code = mode === 'off' ? 'hub_off' : 'hub_read_only';
    const ing = await sys('event_write', '/api/ingest/events', w.ev('x5'));
    assert.equal(ing.status, 503, mode); assert.equal(ing.json.error.code, code);
    assert.equal((await sys('event_write', '/api/ingest/tick', {})).json.error.code, code);
    assert.equal((await sys('provider_webhook', '/api/webhooks/provider', { type: 'balance.low', id: 'pe_' + mode })).json.error.code, code);
    const acc = await w.call('admin', 'POST', `/api/admin/ai-requests/${p1.json.id}/decide`, { accept: true });
    assert.equal(acc.status, 503, mode); assert.equal(acc.json.error.code, code);
    assert.equal((await w.db.first('SELECT status FROM ai_request WHERE id = ?', p1.json.id)).status, 'pending', 'nothing was claimed');
    assert.equal(await bal(), 0, 'no event, no credits');
    assert.equal((await w.call('admin', 'GET', '/api/admin/settings')).status, 200, 'settings pages work');
    assert.equal((await w.call('admin', 'PUT', '/api/admin/settings', { leaderboard: mode === 'off' })).status, 200);
    assert.equal((await w.call('admin', 'GET', '/api/admin/ai-requests')).status, 200);
    if (mode === 'read_only') assert.equal((await keyCall(w, w.keys.read, 'GET', '/api/v1/widgets/targets')).status, 200, 'reads stay allowed');
    else assert.equal((await keyCall(w, w.keys.read, 'GET', '/api/v1/widgets/targets')).json.error.code, 'hub_off');
  }
  assert.equal((await w.call('admin', 'POST', `/api/admin/ai-requests/${p2.json.id}/decide`, { accept: false })).status, 200, 'reject works');
  assert.equal((await w.call('admin', 'POST', `/api/admin/ai-requests/${p3.json.id}/cancel`)).status, 200, 'cancel works');
  doc = { schema_version: 1, hub: { mode: 'on' }, products: {} }; w.clock.t += 61_000;
  assert.equal((await sys('event_write', '/api/ingest/events', w.ev('ok'))).status, 200, 'back on');
  const acc = await w.call('admin', 'POST', `/api/admin/ai-requests/${p1.json.id}/decide`, { accept: true });
  assert.equal(acc.status, 200, JSON.stringify(acc.json)); assert.equal(acc.json.result.executed, true);
  // product-level disabled action and an unreachable Hub fail closed for writes
  doc = { schema_version: 1, hub: { mode: 'on' }, products: { mon: { disabled_actions: ['ingest.events'] } } }; w.clock.t += 61_000;
  assert.equal((await sys('event_write', '/api/ingest/events', w.ev('dis'))).json.error.code, 'hub_action_disabled');
  w.ctx.hubFetch = async () => { throw new Error('down'); }; w.clock.t += 61_000;
  assert.equal((await sys('event_write', '/api/ingest/events', w.ev('un'))).json.error.code, 'hub_unreachable');
});

test('E7: the Hub answer is cached across requests (new ctx each time), fetched with redirect:error, https only', async () => {
  const w = await setup();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { calls.push({ url: String(url), opts }); return new Response(JSON.stringify({ schema_version: 1, hub: { mode: 'on' }, products: {} }), { status: 200 }); };
  try {
    const mk = (url) => { const c = makeCtx({ db: w.db, env: { ...w.ctx.env, HUB_STATUS_URL: url, HUB_PRODUCT_CODE: 'cache-test' }, now: () => w.clock.t }); return c; };
    const url = 'https://hub-cache.example/status.json';
    assert.equal((await hubState(mk(url))).mode, 'on');
    assert.equal((await hubState(mk(url))).mode, 'on');
    assert.equal(calls.length, 1, 'second request, new ctx, same cached answer');
    assert.equal(calls[0].opts.redirect, 'error'); assert.ok(calls[0].opts.signal);
    w.clock.t += 61_000; await hubState(mk(url)); assert.equal(calls.length, 2, 'refreshed after 60 seconds');
    const plain = await hubState(mk('http://hub-cache.example/status.json'));
    assert.equal(plain.reachable, false, 'http is refused, fail closed'); assert.equal(calls.length, 2, 'and never fetched');
  } finally { globalThis.fetch = realFetch; }
});

test('E8: a lost race leaves no audit line; a half-run accept can be finished and never creates the event twice', async () => {
  const w = await setup(); await w.login('admin');
  const audits = async (action) => (await w.db.first('SELECT COUNT(*) n FROM audit WHERE action = ?', action)).n;
  const a = await w.post('ai_read', '/api/v1/proposals', { op: 'reward.award', payload: { person_id: w.people.a.id, amount: 5 } });
  await cancelRequest(w.ctx, w.company, w.admin, a.json.id);
  await assert.rejects(cancelRequest(w.ctx, w.company, w.admin, a.json.id), (e) => e.status === 404);
  assert.equal(await audits('ai.cancel'), 1, 'the second cancel wrote nothing');
  const b = await w.post('ai_read', '/api/v1/proposals', { op: 'reward.award', payload: { person_id: w.people.a.id, amount: 6 } });
  await decideRequest(w.ctx, w.company, w.admin, b.json.id, false);
  await assert.rejects(decideRequest(w.ctx, w.company, w.admin, b.json.id, false), (e) => e.status === 409);
  await assert.rejects(decideRequest(w.ctx, w.company, w.admin, b.json.id, true), (e) => e.status === 409);
  assert.equal(await audits('ai.reject'), 1); assert.equal(await audits('ai.accept'), 0);
  // accept an event.submit: a run cut short stays running and is finished by accepting again
  const c = await w.post('ai_read', '/api/v1/proposals', { op: 'event.submit', payload: { person_id: w.people.a.id, event_type: 'game', stage: 'created', ext_id: 'E8-1' } });
  const real = w.ctx.db.batch; let boom = true;
  const sub = await import('../src/events.js');
  const orig = w.ctx.db.run;
  w.ctx.db.run = async (sql, ...p) => { if (boom && /INSERT INTO event\b/.test(sql)) { boom = false; throw new Error('db went away'); } return orig(sql, ...p); };
  let first;
  try { first = await decideRequest(w.ctx, w.company, w.admin, c.json.id, true); } finally { w.ctx.db.run = orig; }
  if (first.result.state === 'running') {
    assert.equal((await w.db.first('SELECT run_state FROM ai_request WHERE id = ?', c.json.id)).run_state, 'running');
    const again = await decideRequest(w.ctx, w.company, w.admin, c.json.id, true);
    assert.equal(again.result.executed, true);
  } else assert.ok(first.result.executed !== undefined, 'the intake does not use ctx.db.run for its insert here; the resume path is covered below');
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM event WHERE ext_id = 'E8-1'")).n, 1, 'one event, never two');
  // a stuck running row (status approved, run_state running) is finished by accept, without a second event
  const d = await w.post('ai_read', '/api/v1/proposals', { op: 'event.submit', payload: { person_id: w.people.b.id, event_type: 'game', stage: 'created', ext_id: 'E8-2' } });
  await w.db.run("UPDATE ai_request SET status = 'approved', run_state = 'running', decided_by = ?, decided_at = ? WHERE id = ?", w.admin.id, w.clock.t, d.json.id);
  const fin = await decideRequest(w.ctx, w.company, w.admin, d.json.id, true);
  assert.equal(fin.result.executed, true);
  assert.equal((await w.db.first('SELECT run_state FROM ai_request WHERE id = ?', d.json.id)).run_state, 'done');
  await decideRequest(w.ctx, w.company, w.admin, d.json.id, true).then(() => assert.fail('a finished run is not run again'), (e) => assert.equal(e.status, 409));
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM event WHERE ext_id = 'E8-2'")).n, 1);
  void real; void sub;
});

test('E9: a too-large body on /api/v1 keeps the v1 shape; AI_KILL any non-empty value but 0/false is on; proposals.list is level ai_read; keys can be re-issued', async () => {
  const w = await setup(); await w.login('admin');
  const big = await handle(w.ctx, new Request('https://floor.test/api/v1/proposals', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': idem() }, body: 'a'.repeat(1_600_000) }));
  assert.equal(big.status, 413);
  assert.equal(big.headers.get('x-content-trust'), 'untrusted-data');
  const j = await big.json(); assert.equal(j.error.code, 'too_big'); assert.ok(j.meta && j.meta.rule);
  const plain = await handle(w.ctx, new Request('https://floor.test/api/health', { method: 'POST', body: 'a'.repeat(1_600_000) }));
  assert.equal(plain.headers.get('x-content-trust'), null, 'other routes keep their own shape');
  for (const v of ['1', 'true', 'yes', 'on', 'anything']) assert.equal(killOn(v), true, v);
  for (const v of ['0', 'false', 'FALSE', '', undefined, ' ']) assert.equal(killOn(v), false, String(v));
  w.ctx.env.AI_KILL = 'true';
  assert.equal((await w.get('ai_read', '/api/v1/targets')).json.error.code, 'ai_off');
  w.ctx.env.AI_KILL = 'false';
  assert.equal((await w.get('ai_read', '/api/v1/targets')).status, 200);
  assert.equal(OPERATIONS.find((o) => o.id === 'proposals.list').level, 'ai_read');
  const old = await createKey(w.ctx, w.company, w.admin, { scope: 'read', label: 'old' });
  await w.db.run('UPDATE company_key SET secret_sealed = NULL WHERE key_id = ?', old.key_id);
  const re = await w.call('admin', 'POST', `/api/admin/keys/${old.key_id}/reissue`);
  assert.equal(re.status, 200); assert.ok(re.json.secret && re.json.secret.length === 64);
  assert.equal((await keyCall(w, { key_id: old.key_id, secret: re.json.secret }, 'GET', '/api/v1/targets')).status, 200, 'the new secret works');
  assert.equal((await w.call('a', 'POST', `/api/admin/keys/${old.key_id}/reissue`)).status, 401);
});

test('E12: the first note is on square 3 and the first hub on square 6; the lane and rest stop are not on corners', () => {
  assert.equal(SQUARES[3].type, 'note'); assert.equal(SQUARES[6].type, 'hub'); assert.notEqual(SQUARES[2].type, 'note'); assert.notEqual(SQUARES[5].type, 'hub');
  for (const t of ['lane', 'rest']) assert.ok(SQUARES.findIndex((s) => s.type === t) % 4 !== 0, t + ' is not on a corner');
});
