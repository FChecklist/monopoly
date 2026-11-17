// The committed CONTRACT/openapi-v1.json must be exactly what the operations table generates, and must cover every registered /api/v1 route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { buildOpenApi, openApiText, OPERATIONS, HANDLERS, ERROR_CODES, PROPOSAL_OPS, TRUST_RULE } from '../src/aiapi.js';
import { registeredV1Routes } from '../src/api.js';
import { PRODUCT } from '../src/config.js';

const spec = buildOpenApi();
const ops = () => Object.entries(spec.paths).flatMap(([path, m]) => Object.entries(m).map(([method, o]) => ({ path, method: method.toUpperCase(), o })));

test('the committed CONTRACT/openapi-v1.json equals the generated one (run: node scripts/make-openapi.js)', () => {
  assert.equal(readFileSync('CONTRACT/openapi-v1.json', 'utf8'), openApiText());
  assert.equal(spec.openapi, '3.0.3');
});

test('every registered /api/v1 route is in the spec, with the same method, and the spec lists nothing that is not registered', () => {
  const reg = registeredV1Routes();
  assert.ok(reg.length >= 12);
  for (const r of reg) assert.ok(spec.paths[r.path]?.[r.method.toLowerCase()], `${r.method} ${r.path} is registered but missing from the spec`);
  const keys = new Set(reg.map((r) => `${r.method} ${r.path}`));
  for (const { path, method } of ops()) assert.ok(keys.has(`${method} ${path}`), `${method} ${path} is in the spec but not registered`);
  // the table and the handlers agree
  for (const o of OPERATIONS.filter((x) => !x.legacy)) assert.equal(typeof HANDLERS[o.id], 'function', o.id);
  for (const id of Object.keys(HANDLERS)) assert.ok(OPERATIONS.some((o) => o.id === id), id);
});

test('flags: read/write follows the method, money and ask-only are as designed, every write needs an idempotency key', () => {
  const reg = new Map(registeredV1Routes().map((r) => [`${r.method} ${r.path}`, r]));
  for (const { path, method, o } of ops()) {
    const r = reg.get(`${method} ${path}`);
    assert.equal(o['x-read-write'], method === 'GET' ? 'read' : 'write', `${method} ${path}`);
    assert.ok(['read', 'write'].includes(o['x-read-write']));
    assert.equal(typeof o['x-money'], 'boolean'); assert.equal(typeof o['x-ask-only'], 'boolean'); assert.ok(o['x-permission-level'], path);
    assert.equal(o['x-idempotency-required'], !r.legacy && o['x-read-write'] === 'write', `${method} ${path}`);
    if (o['x-read-write'] === 'read') assert.equal(o['x-money'], false, 'a read never moves money');
    assert.ok(o.description.length > 40 && o.summary, path);
    assert.ok(Array.isArray(o['x-untrusted-text-fields']) && Array.isArray(o['x-allowed-key-classes']));
    const okRes = o.responses['200'] ?? o.responses['202'];
    assert.ok(okRes.content['application/json'].example, `${path} response example`);
    if (method === 'POST') assert.ok(o.requestBody.content['application/json'].example, `${path} request example`);
    if (o['x-idempotency-required']) assert.ok(o.parameters.some((p) => p.$ref === '#/components/parameters/IdempotencyKey'), path);
    assert.ok(o.security[0].signature && o.security[0].keyId && o.security[0].timestamp);
  }
  const g = (m, p) => spec.paths[p][m];
  assert.equal(g('post', '/api/v1/events')['x-money'], true); assert.equal(g('post', '/api/v1/events/cancel')['x-money'], true);
  assert.equal(g('post', '/api/v1/proposals')['x-money'], false); assert.equal(g('post', '/api/v1/proposals')['x-ask-only'], true);
  assert.equal(g('post', '/api/v1/events')['x-ask-only'], false);
  const po = g('post', '/api/v1/proposals')['x-proposal-ops'];
  assert.deepEqual(Object.keys(po).sort(), Object.keys(PROPOSAL_OPS).sort());
  for (const k of ['event.submit', 'event.approve', 'reward.award', 'reward.reverse', 'ratecard.change', 'target.change']) assert.equal(po[k]['x-money'], true, k);
  for (const k of ['event.reject', 'penalty.propose', 'penalty.rule.change']) assert.equal(po[k]['x-money'], false, k);
  assert.deepEqual(Object.entries(po).filter(([, v]) => v.executed_by_system_on_accept).map(([k]) => k), ['event.submit'], 'only event.submit is ever carried out by the system');
  assert.deepEqual(g('get', '/api/v1/proposals')['x-allowed-key-classes'], ['ai_read', 'manager', 'admin']);
  assert.ok(!g('post', '/api/v1/events')['x-allowed-key-classes'].includes('ai_read'));
});

test('spec carries the error code list, the signing schemes and the untrusted-text rule; no brand string', () => {
  assert.deepEqual(spec.components.schemas.ErrorCode.enum, Object.keys(ERROR_CODES));
  for (const { o } of ops()) for (const e of o['x-errors']) assert.ok(ERROR_CODES[e], e);
  assert.deepEqual(Object.keys(spec.components.securitySchemes).sort(), ['keyId', 'signature', 'timestamp']);
  assert.equal(spec['x-untrusted-text-rule'], TRUST_RULE);
  assert.ok(spec['x-untrusted-text-fields'].includes('teams[].name') && spec['x-untrusted-text-fields'].includes('proposals[].payload'));
  assert.ok(spec['x-kill-switches'].length === 3);
  assert.match(spec.info.title, /\{product_name\}/);
  for (const f of readdirSync('CONTRACT')) {
    if (f === 'MAPPING-MONEYPENNY.md') continue;
    assert.ok(!readFileSync('CONTRACT/' + f, 'utf8').includes(PRODUCT.name), f + ' hard-codes the brand');
  }
  const ex = JSON.parse(readFileSync('CONTRACT/examples.json', 'utf8'));
  assert.equal(ex.widget_targets.response.product, '{product_name}'); assert.equal(ex.versions['ai-api'], 'v1'); assert.equal(ex.versions.signed, 'v1');
  assert.ok(ex.ai_proposal && ex.ai_penalty_refused && ex.ai_status);
});
