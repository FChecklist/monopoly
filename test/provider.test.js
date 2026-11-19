// Border tests: the same contract suite against the demo provider and against the Moneypenny adapter (fake server that
// verifies the real signing scheme), plus outage and retry behaviour. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contractSuite } from './contract.js';
import { openDb, migrate } from '../src/db.js';
import { StubProvider } from '../src/provider/stub.js';
import { MoneypennyProvider } from '../src/provider/moneypenny.js';
import { ProviderError } from '../src/provider/errors.js';
import { getProvider } from '../src/provider/index.js';
import { hmacHex, sha256Hex } from '../src/util.js';
import { world, exampleCard, SYSTEM } from './helpers.js';
import { submitEvent } from '../src/events.js';
import { retryQueued } from '../src/rewards.js';

const SECRET = 'mnp-test-secret-0123456789';
/** A fake Moneypenny: checks signature, timestamp, nonce and idempotency exactly as API.md says. */
function fakeMoneypenny({ down = false } = {}) {
  const bal = new Map(), seenNonce = new Set(), idem = new Map(), holds = new Map();
  let calls = 0;
  const impl = async (url, init) => {
    calls++;
    if (impl.down) throw new Error('network');
    const u = new URL(url), path = u.pathname + u.search, h = init.headers, body = init.body ?? '';
    const expect = await hmacHex(SECRET, [h['x-mnp-timestamp'], h['x-mnp-nonce'], init.method, path, await sha256Hex(body), h['idempotency-key'] ?? ''].join('\n'));
    const reply = (status, j, extra = {}) => ({ ok: status < 300, status, headers: { get: (k) => extra[k] ?? null }, json: async () => { if (j === undefined) throw new SyntaxError('not json'); return j; } });
    if (impl.override) { const o = impl.override(u.pathname, init, reply); if (o) return o; } // tests: force a status / body
    if (h['x-mnp-key'] !== 'mk_test' || h['x-mnp-signature'] !== expect) return reply(401, { ok: false, error: { code: 'bad_signature' } });
    if (Math.abs(Date.now() - Number(h['x-mnp-timestamp'])) > 300000) return reply(401, { ok: false, error: { code: 'stale_timestamp' } });
    if (seenNonce.has(h['x-mnp-nonce'])) return reply(401, { ok: false, error: { code: 'replayed' } });
    seenNonce.add(h['x-mnp-nonce']);
    const j = body ? JSON.parse(body) : {};
    if (init.method !== 'GET') {
      const k = h['idempotency-key'];
      if (!k) return reply(400, { ok: false, error: { code: 'idempotency_key_required' } });
      if (idem.has(k + u.pathname)) return reply(200, idem.get(k + u.pathname), { 'idempotent-replay': 'true' });
    }
    const done = (r) => { if (init.method !== 'GET') idem.set(h['idempotency-key'] + u.pathname, r); return reply(200, r); };
    if (u.pathname === '/v1/balance') return reply(200, { ok: true, balance: bal.get(u.searchParams.get('email')) ?? 0, display: { label: 'Moneypenny Credits' } });
    if (u.pathname === '/v1/credit') { bal.set(j.email, (bal.get(j.email) ?? 0) + j.amount); return done({ ok: true, granted: j.amount }); }
    if (u.pathname === '/v1/history') return reply(200, { ok: true, entries: [{ id: 1, kind: 'bonus', delta: 10, ext_ref: 'x', at: 0 }] });
    if (u.pathname === '/v1/spend/reserve_item') {
      if ((bal.get(j.email) ?? 0) < j.credits) return reply(402, { ok: false, error: { code: 'insufficient_credits' } });
      bal.set(j.email, bal.get(j.email) - j.credits);
      const id = 'hold_' + holds.size; holds.set(id, { email: j.email, credits: j.credits });
      return done({ ok: true, hold_id: id, credits: j.credits });
    }
    if (u.pathname === '/v1/spend/capture') return done({ ok: true, status: 'captured' });
    if (u.pathname === '/v1/spend/release') { const x = holds.get(j.hold_id); if (x && !x.released) { x.released = true; bal.set(x.email, bal.get(x.email) + x.credits); } return done({ ok: true, status: 'released' }); }
    return reply(404, { ok: false, error: { code: 'not_found' } });
  };
  impl.down = down; impl.calls = () => calls;
  return impl;
}
const mnp = (f = fakeMoneypenny()) => new MoneypennyProvider({ baseUrl: 'https://mnp.test', keyId: 'mk_test', secret: SECRET }, { fetchImpl: f });

contractSuite((name, fn) => test('demo provider: ' + name, fn), async () => { const db = openDb(); migrate(db); return new StubProvider(db, 'co_1'); });
contractSuite((name, fn) => test('moneypenny adapter: ' + name, fn), async () => mnp());

test('the Moneypenny adapter signs every call exactly as the API says; a wrong secret is refused', async () => {
  const f = fakeMoneypenny();
  const bad = new MoneypennyProvider({ baseUrl: 'https://mnp.test', keyId: 'mk_test', secret: 'wrong-secret-wrong-secret' }, { fetchImpl: f });
  await assert.rejects(bad.getBalance({ accountRef: 'x@y.test' }), (e) => e instanceof ProviderError);
  assert.equal((await mnp(f).getBalance({ accountRef: 'x@y.test' })).balance, 0);
});
test('Moneypenny features it lacks are reported off and refused, never faked', async () => {
  const p = mnp();
  const c = await p.capabilities();
  assert.deepEqual([c.hold, c.debit, c.reverse, c.batch, c.cash_out], [false, false, false, false, false]);
  for (const m of ['debit', 'reverse', 'reserveBudget']) await assert.rejects(p[m]({}), (e) => e.code === 'unsupported');
});
test('an unsafe base address is refused', () => {
  assert.throws(() => new MoneypennyProvider({ baseUrl: 'http://evil.example', keyId: 'k', secret: 's' }), /https/);
});
test('the demo provider is refused for a live company and when switched off', () => {
  const db = openDb(); migrate(db);
  assert.throws(() => getProvider({ ALLOW_DEMO_PROVIDER: '1' }, db, { id: 'c', provider: 'stub', live: 1 }), /refused for a live/);
  assert.throws(() => getProvider({}, db, { id: 'c', provider: 'stub', live: 0 }), /switched off/);
});

test('provider down: the reward stays "on its way", is retried with the same key, and never pays twice', async () => {
  const f = fakeMoneypenny();
  const w = await world({ providerOverride: () => mnp(f), settings: { daily_event_limit: 1000 } });
  await w.db.run("UPDATE company SET provider = 'moneypenny'");
  await w.reload(); await exampleCard(w);
  f.down = true;
  const r = await submitEvent(w.ctx, w.company, SYSTEM, { person_id: w.people.a.id, event_type: 'game', stage: 'completed', ext_id: 'out1', source: 'api', occurred_at: w.clock.t });
  assert.ok(r.ok);
  const row = await w.db.first("SELECT state, attempts, last_error FROM reward WHERE person_id = ?", w.people.a.id);
  assert.equal(row.state, 'queued'); assert.equal(row.last_error, 'provider_down');
  f.down = false;
  assert.equal((await retryQueued(w.ctx, w.company)).sent, 1);
  assert.equal((await retryQueued(w.ctx, w.company)).sent, 0, 'nothing left to send');
  assert.equal((await mnp(f).getBalance({ accountRef: 'a@acme.test' })).balance, 40);
});
test('no budget means waiting, not paying; raising the budget releases it', async () => {
  const w = await world({ budget: 30, settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  await submitEvent(w.ctx, w.company, SYSTEM, { person_id: w.people.a.id, event_type: 'game', stage: 'completed', ext_id: 'b1', source: 'api', occurred_at: w.clock.t });
  assert.equal((await w.db.first('SELECT state FROM reward')).state, 'waiting');
  await w.ctx.provider(w.company).ensureAccount({ externalRef: w.people.a.id });
  assert.equal((await w.ctx.provider(w.company).getBalance({ accountRef: 'acct_' + w.people.a.id })).balance, 0);
  const { raiseBudget } = await import('../src/setup.js');
  const { releaseWaiting } = await import('../src/rewards.js');
  await assert.rejects(raiseBudget(w.ctx, w.company, w.admin, w.season, 10), /only go up/);
  await raiseBudget(w.ctx, w.company, w.admin, w.season, 100);
  assert.equal((await releaseWaiting(w.ctx, w.company)).moved, 1);
  assert.equal((await w.ctx.provider(w.company).getBalance({ accountRef: 'acct_' + w.people.a.id })).balance, 40);
});
test('this product stores no credit balances: no balance column outside the demo provider tables', async () => {
  const w = await world();
  for (const t of await w.db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'stub_%' AND name NOT LIKE 'sqlite_%'")) {
    const cols = (await w.db.all(`PRAGMA table_info(${t.name})`)).map((c) => c.name);
    assert.ok(!cols.some((c) => /balance/i.test(c)), `${t.name} has a balance column`);
  }
});
test('a pending correction (credits already spent) is paid down by smaller later credits, max half of one reward, never a penalty', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  const { ctx, company } = w, a = w.people.a;
  const ev = await submitEvent(ctx, company, SYSTEM, { person_id: a.id, event_type: 'game', stage: 'completed', ext_id: 'sp1', source: 'api', occurred_at: w.clock.t });
  // the person spends all of it
  const prov = ctx.provider(company);
  const hold = await prov.reserveSpend({ accountRef: 'acct_' + a.id, amount: 40, ref: 'o', idem: 'o1' }); await prov.captureSpend({ holdId: hold.hold_id });
  const { requestReversal, processReversals } = await import('../src/events.js');
  await requestReversal(ctx, company, SYSTEM, ev.id, { reason: 'refund' });
  w.clock.t += 4 * 86400_000; await processReversals(ctx, company);
  const c = await w.db.first('SELECT amount, recovered, state FROM correction');
  assert.deepEqual({ ...c }, { amount: 40, recovered: 0, state: 'open' });
  await submitEvent(ctx, company, SYSTEM, { person_id: a.id, event_type: 'game', stage: 'completed', ext_id: 'sp2', source: 'api', occurred_at: w.clock.t });
  const c2 = await w.db.first('SELECT recovered, state FROM correction');
  assert.equal(c2.recovered, 20, 'half of the new 40');
  assert.equal((await prov.getBalance({ accountRef: 'acct_' + a.id })).balance, 20, 'a smaller credit was sent');
  await submitEvent(ctx, company, SYSTEM, { person_id: a.id, event_type: 'game', stage: 'completed', ext_id: 'sp3', source: 'api', occurred_at: w.clock.t });
  assert.equal((await w.db.first('SELECT state FROM correction')).state, 'cleared');
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM penalty_case")).n, 0, 'not counted as a penalty');
});

// ---- round 10: status mapping and the fate of queued rewards ----
import { reviveFailedRewards, openFailedRewards } from '../src/rewards.js';
const codeOf = async (f, over) => { f.override = over; try { await mnp(f).credit({ accountRef: 'x@y.test', amount: 5, ref: 'r', idem: 'k' + Math.random() }); return null; } catch (e) { return e; } finally { f.override = null; } };
const answer = (status, code) => (path, init, reply) => (path === '/v1/credit' ? reply(status, status < 300 ? undefined : { ok: false, error: code ? { code } : undefined }) : null);

test('R10-1: the adapter maps every status to a code the game classifies correctly', async () => {
  const table = [
    [401, undefined, 'unauthorized', true], [401, 'stale_timestamp', 'unauthorized', true], [401, 'replayed', 'unauthorized', true],
    [403, undefined, 'unauthorized', true], [408, undefined, 'unauthorized', true], [425, undefined, 'unauthorized', true],
    [403, 'account_frozen', 'account_closed', false],
    [404, undefined, 'misconfigured', true], [404, 'not_found', 'misconfigured', true], [409, undefined, 'misconfigured', true],
    [404, 'no_account', 'account_closed', false], [409, 'idempotency_conflict', 'idempotency_conflict', true],
    [402, undefined, 'insufficient_credits', false], [402, 'insufficient_credits', 'insufficient_credits', false],
    [429, undefined, 'rate_limited', true], [500, undefined, 'provider_down', true], [503, 'whatever', 'provider_down', true],
    [400, undefined, 'bad_request', false], [422, 'mystery', 'bad_request', false], [422, 'below_minimum', 'bad_request', false], [400, 'bad_email', 'bad_request', false],
  ];
  for (const [status, body, want, retriable] of table) {
    const e = await codeOf(fakeMoneypenny(), answer(status, body));
    assert.ok(e instanceof ProviderError, `${status}/${body}`);
    assert.equal(e.code, want, `${status}/${body}`); assert.equal(e.retriable, retriable, `${status}/${body} retriable`);
  }
});
test('R10-2: a timeout is "timeout" (transient) and a 200 that is not JSON is "bad_response" (transient), never a TypeError', async () => {
  const f = fakeMoneypenny();
  const t = await codeOf(f, () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); });
  assert.equal(t.code, 'timeout'); assert.equal(t.retriable, true);
  const n = await codeOf(f, (path, init, reply) => (path === '/v1/credit' ? reply(200, undefined) : null));
  assert.ok(n instanceof ProviderError); assert.equal(n.code, 'bad_response'); assert.equal(n.retriable, true);
});

test('R10-3: config / auth / clock faults keep event rewards queued (one audit line per code), and they are paid once after recovery', async () => {
  for (const [name, over] of [['401', answer(401, 'stale_timestamp')], ['403', answer(403)], ['404', answer(404)], ['409', answer(409)], ['408', answer(408)], ['402', answer(402, 'insufficient_credits')], ['429', answer(429)], ['500', answer(500)],
    ['timeout', () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }], ['non-json', (p, i, reply) => (p === '/v1/credit' ? reply(200, undefined) : null)]]) {
    const f = fakeMoneypenny();
    const w = await world({ providerOverride: () => mnp(f), settings: { daily_event_limit: 1000 } });
    await w.db.run("UPDATE company SET provider = 'moneypenny'"); await w.reload(); await exampleCard(w);
    f.override = over;
    const r = await submitEvent(w.ctx, w.company, SYSTEM, { person_id: w.people.a.id, event_type: 'game', stage: 'completed', ext_id: 'cfg' + name, source: 'api', occurred_at: w.clock.t });
    assert.ok(r.ok, name);
    for (let i = 0; i < 4; i++) await retryQueued(w.ctx, w.company);
    const row = await w.db.first('SELECT state, last_error, attempts FROM reward WHERE person_id = ?', w.people.a.id);
    assert.equal(row.state, 'queued', name + ' stays queued'); assert.ok(row.attempts >= 4);
    assert.equal((await w.db.first("SELECT COUNT(*) n FROM audit WHERE action='reward.send_error'")).n, 1, name + ': bounded audit');
    f.override = null;
    assert.equal((await retryQueued(w.ctx, w.company)).sent, 1, name);
    assert.equal((await retryQueued(w.ctx, w.company)).sent, 0);
    assert.equal((await mnp(f).getBalance({ accountRef: 'a@acme.test' })).balance, 40, name + ': paid once');
  }
});

test('R10-4: a permanent 400 fails an event reward visibly; the admin revive pays it once, with the same key', async () => {
  const f = fakeMoneypenny();
  const w = await world({ providerOverride: () => mnp(f), settings: { daily_event_limit: 1000 } });
  await w.db.run("UPDATE company SET provider = 'moneypenny'"); await w.reload(); await exampleCard(w);
  f.override = answer(422, 'mystery');
  const r = await submitEvent(w.ctx, w.company, SYSTEM, { person_id: w.people.a.id, event_type: 'game', stage: 'completed', ext_id: 'perm', source: 'api', occurred_at: w.clock.t });
  assert.ok(r.ok);
  const row = await w.db.first('SELECT id, state, last_error, idem_key FROM reward WHERE person_id = ?', w.people.a.id);
  assert.equal(row.state, 'failed'); assert.equal(row.last_error, 'bad_request');
  assert.equal(await openFailedRewards(w.ctx, w.company.id), 1);
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM audit WHERE action='reward.failed'")).n, 1);
  f.override = null;
  const out = await reviveFailedRewards(w.ctx, w.company);
  assert.equal(out.revived, 1);
  const after = await w.db.first('SELECT state, idem_key FROM reward WHERE id = ?', row.id);
  assert.equal(after.state, 'sent'); assert.equal(after.idem_key, row.idem_key, 'same key: cannot pay twice');
  assert.equal(await openFailedRewards(w.ctx, w.company.id), 0);
  assert.equal((await reviveFailedRewards(w.ctx, w.company)).revived, 0);
  assert.equal((await mnp(f).getBalance({ accountRef: 'a@acme.test' })).balance, 40);
});

test('R5: a 200 that is not {"ok":true,...} with a number "granted" is never counted as a sent credit', async () => {
  for (const body of [{}, [], { ok: true }, { ok: true, granted: 'x' }, { ok: false }]) {
    const e = await codeOf(fakeMoneypenny(), (path, init, reply) => (path === '/v1/credit' ? reply(200, body) : null));
    assert.ok(e instanceof ProviderError, JSON.stringify(body)); assert.equal(e.retriable, true);
  }
});
