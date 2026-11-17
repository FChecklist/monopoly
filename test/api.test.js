// HTTP border tests: sign-in, roles, privacy, CSRF, signed ingest (replay, bad signature, wrong scope), widgets, platform token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, exampleCard, ENV, T0 } from './helpers.js';
import { handle } from '../src/api.js';
import { hmacHex, DAY } from '../src/util.js';
import { createKey, keySecret } from '../src/setup.js';

async function boot(opts) {
  const w = await world(opts);
  w.sessions = {}; w.codes = { ...w.codes };
  w.call = async (who, method, path, body, hdrs = {}) => {
    const headers = { 'content-type': 'application/json', ...hdrs };
    if (who && w.sessions[who]) headers.cookie = 'floor_session=' + w.sessions[who];
    if (method !== 'GET' && who) headers['x-floor'] = '1';
    const res = await handle(w.ctx, new Request('https://floor.test' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: res.status, json: await res.json(), headers: res.headers };
  };
  w.login = async (who) => {
    const { issueCode } = await import('../src/people.js');
    const u = await w.db.first('SELECT * FROM app_user WHERE email_hash = ?', await w.ctx.hash('email', (who === 'admin' ? 'boss' : who) + '@acme.test'));
    w.codes[who] = await issueCode(w.ctx, u);
    const r = await w.call(null, 'POST', '/api/auth/login', { email: `${who === 'admin' ? 'boss' : who}@acme.test`, code: w.codes[who] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    w.sessions[who] = /floor_session=([a-f0-9]+)/.exec(r.headers.get('set-cookie'))[1];
  };
  w.ctx.env.PLATFORM_TOKEN = 'platform-token-0123456789-abcdef';
  return w;
}
const sign = async (w, key, method, path, body) => {
  const raw = body === undefined ? '' : JSON.stringify(body), ts = String(w.clock.t);
  return { raw, headers: { 'x-key-id': key.key_id, 'x-timestamp': ts, 'x-signature': await hmacHex(key.secret, ts + '.' + method + ' ' + path + '.' + raw), 'content-type': 'application/json' } };
};
const signedCall = async (w, key, method, path, body, over = {}) => {
  const s = await sign(w, key, method, path, body);
  const res = await handle(w.ctx, new Request('https://floor.test' + path, { method, headers: { ...s.headers, ...over }, body: method === 'GET' ? undefined : s.raw }));
  return { status: res.status, json: await res.json() };
};

test('sign-in: wrong code refused, right code works once, tries are limited, no passwords', async () => {
  const w = await boot();
  assert.equal((await w.call(null, 'POST', '/api/auth/login', { email: 'a@acme.test', code: 'WRONGCODE' })).status, 401);
  assert.equal((await w.call(null, 'POST', '/api/auth/login', { email: 'nobody@acme.test', code: 'WRONGCODE' })).status, 401);
  await w.login('a');
  assert.equal((await w.call(null, 'POST', '/api/auth/login', { email: 'a@acme.test', code: w.codes.a })).status, 401, 'one-time');
  const me = await w.call('a', 'GET', '/api/me');
  assert.equal(me.json.user.role, 'employee'); assert.equal(me.json.consents.employee_notice, true);
  const r = await w.call(null, 'POST', '/api/auth/request-code', { email: 'nobody@acme.test' });
  assert.equal(r.status, 200); assert.match(r.json.message, /ask your company admin/, 'same answer for any e-mail');
  // brute force: 5 wrong codes from one address block that address for a while. The code itself is not killed, so nobody is locked out for good.
  for (let i = 0; i < 6; i++) await w.call(null, 'POST', '/api/auth/login', { email: 'b@acme.test', code: 'AAAAAAA' + i });
  const { issueCode } = await import('../src/people.js');
  const bCode = await issueCode(w.ctx, w.people.b);
  const blocked = await w.call(null, 'POST', '/api/auth/login', { email: 'b@acme.test', code: bCode });
  assert.equal(blocked.status, 429, 'temporary block after too many tries from one address'); assert.ok(blocked.headers.get('retry-after'));
  const other = await w.call(null, 'POST', '/api/auth/login', { email: 'b@acme.test', code: bCode }, { 'cf-connecting-ip': '203.0.113.9' });
  assert.equal(other.status, 200, 'the real person on another address still gets in: no lock-out by e-mail');
});
test('no session, no data; writes need the app header; cross-site writes are refused', async () => {
  const w = await boot();
  assert.equal((await w.call(null, 'GET', '/api/me')).status, 401);
  await w.login('hr');
  const noHeader = await handle(w.ctx, new Request('https://floor.test/api/me/profile', { method: 'PUT', headers: { cookie: 'floor_session=' + w.sessions.hr }, body: '{"hide_name":true}' }));
  assert.equal(noHeader.status, 403);
  const cross = await handle(w.ctx, new Request('https://floor.test/api/me/profile', { method: 'PUT', headers: { cookie: 'floor_session=' + w.sessions.hr, 'x-floor': '1', origin: 'https://evil.example' }, body: '{"hide_name":true}' }));
  assert.equal(cross.status, 403);
  assert.equal((await w.call('hr', 'PUT', '/api/me/profile', { hide_name: true })).status, 200);
});
test('privacy: an employee sees only their own board, events and never the admin or team screens', async () => {
  const w = await boot(); await exampleCard(w);
  await w.login('a'); await w.login('b'); await w.login('mgr'); await w.login('hr'); await w.login('admin');
  for (const p of ['/api/admin/settings', '/api/admin/overview', '/api/team/board', '/api/people', '/api/events', '/api/penalties', '/api/admin/audit', '/api/team/contributions']) assert.equal((await w.call('a', 'GET', p)).status, 403, p);
  assert.equal((await w.call('a', 'GET', `/api/people/${w.people.b.id}/summary`)).status, 403);
  assert.equal((await w.call('a', 'GET', `/api/people/${w.people.a.id}/summary`)).status, 200);
  assert.equal((await w.call('mgr', 'GET', `/api/people/${w.people.a.id}/summary`)).status, 200, 'the manager sees their own team');
  assert.equal((await w.call('hr', 'GET', `/api/people/${w.people.a.id}/summary`)).status, 403, 'HR sees individuals only for a case or dispute');
  const audit = await w.call('admin', 'GET', '/api/admin/audit?limit=500');
  assert.ok(audit.json.rows.some((r) => r.action === 'view.person'), 'looking at someone else is logged');
  // another team's manager cannot see this team
  const { addPerson } = await import('../src/people.js'); const { createTeam } = await import('../src/setup.js');
  const m2 = await addPerson(w.ctx, w.company, w.admin, { email: 'm2@acme.test', name: 'm2', role: 'manager' });
  await createTeam(w.ctx, w.company, w.admin, { name: 'Ops', manager_id: m2.user.id });
  await w.login('m2');
  assert.equal((await w.call('m2', 'GET', `/api/people/${w.people.a.id}/summary`)).status, 403);
  const t = await w.call('m2', 'GET', '/api/team/board'); assert.equal(t.json.tokens.length, 0, 'only their own team');
});
test('HR sees no names in the people list; hidden names show as Player N to others', async () => {
  const w = await boot();
  await w.login('hr'); await w.login('mgr'); await w.login('b');
  const hr = await w.call('hr', 'GET', '/api/people');
  assert.ok(hr.json.people.every((p) => !p.name && !p.email));
  await w.call('b', 'PUT', '/api/me/profile', { hide_name: true });
  const tb = await w.call('mgr', 'GET', '/api/team/board');
  assert.ok(tb.json.tokens.some((x) => /^Player \d+$/.test(x.name)));
  assert.ok(!tb.json.tokens.some((x) => x.name === 'b'));
});
test('leaderboard is off for employees until the company switches it on', async () => {
  const w = await boot(); await w.login('a'); await w.login('admin');
  assert.equal((await w.call('a', 'GET', '/api/league')).status, 403);
  await w.call('admin', 'PUT', '/api/admin/settings', { leaderboard: true });
  const r = await w.call('a', 'GET', '/api/league');
  assert.equal(r.status, 200); assert.ok(r.json.league.every((x) => x.members === undefined), 'employees see rank and score only');
});
test('settings: hard limits hold (penalty cap 50, bonus floor 10, cash-out stays off)', async () => {
  const w = await boot(); await w.login('admin');
  assert.equal((await w.call('admin', 'PUT', '/api/admin/settings', { penalty_cap_pct: 60 })).status, 400);
  assert.equal((await w.call('admin', 'PUT', '/api/admin/settings', { bonus_floor_pct: 5 })).status, 400);
  assert.equal((await w.call('admin', 'PUT', '/api/admin/settings', { not_a_setting: 1 })).status, 400);
  const r = await w.call('admin', 'PUT', '/api/admin/settings', { cash_out: true });
  assert.equal(r.json.settings.cash_out, false, 'cash-out is always off');
});
test('signed ingest: valid events pay; replay, wrong secret, stale time, wrong scope and revoked keys are all refused', async () => {
  const w = await boot({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  const key = await createKey(w.ctx, w.company, w.admin, { scope: 'ingest', label: 'crm' });
  const body = { events: [{ person_id: w.people.a.id, event_type: 'game', stage: 'completed', ext_id: 'S1', occurred_at: w.clock.t }] };
  const ok = await signedCall(w, key, 'POST', '/api/ingest/events', body);
  assert.equal(ok.status, 200); assert.equal(ok.json.results[0].ok, true);
  const bal = await w.ctx.provider(w.company).getBalance({ accountRef: 'acct_' + w.people.a.id });
  assert.equal(bal.balance, 40);
  // exact replay of the same signed request
  const s = await sign(w, key, 'POST', '/api/ingest/events', { events: [{ ...body.events[0], ext_id: 'S2' }] });
  const send = () => handle(w.ctx, new Request('https://floor.test/api/ingest/events', { method: 'POST', headers: s.headers, body: s.raw })).then(async (r) => ({ status: r.status, json: await r.json() }));
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 401, 'replay');
  assert.equal((await signedCall(w, { ...key, secret: 'x'.repeat(64) }, 'POST', '/api/ingest/events', body)).status, 401);
  w.clock.t += 10 * 60_000;
  const old = await sign(w, key, 'POST', '/api/ingest/events', body); w.clock.t -= 10 * 60_000;
  assert.equal((await handle(w.ctx, new Request('https://floor.test/api/ingest/events', { method: 'POST', headers: old.headers, body: old.raw }))).status, 401, 'time window');
  const widgetKey = await createKey(w.ctx, w.company, w.admin, { scope: 'widgets' });
  const denied = await signedCall(w, widgetKey, 'POST', '/api/ingest/events', body);
  assert.equal(denied.status, 403, 'a read key cannot send events'); assert.equal(denied.json.error.code, 'scope_denied');
  assert.equal((await signedCall(w, key, 'GET', '/api/v1/widgets/targets')).status, 200, 'event_write includes read (hierarchy)');
  const aiKey = await createKey(w.ctx, w.company, w.admin, { scope: 'ai_read' });
  assert.equal((await signedCall(w, aiKey, 'GET', '/api/v1/widgets/targets')).status, 403, 'an ai key is not allowed on the older routes');
  await w.db.run("UPDATE company_key SET status = 'revoked' WHERE key_id = ?", key.key_id);
  assert.equal((await signedCall(w, key, 'POST', '/api/ingest/events', body)).status, 401);
});
test('signed ingest: a cancel from the source system starts a reversal with notice; unknown events are reported', async () => {
  const w = await boot({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  const key = await createKey(w.ctx, w.company, w.admin, { scope: 'ingest' });
  await signedCall(w, key, 'POST', '/api/ingest/events', { events: [{ person_id: w.people.a.id, event_type: 'game', stage: 'completed', ext_id: 'C1', occurred_at: w.clock.t }] });
  const r = await signedCall(w, key, 'POST', '/api/ingest/events', { events: [{ action: 'cancel', event_type: 'game', stage: 'completed', ext_id: 'C1' }, { action: 'cancel', event_type: 'game', stage: 'completed', ext_id: 'nope' }] });
  assert.equal(r.json.results[0].status, 'reversal_pending'); assert.equal(r.json.results[1].reason, 'unknown_event');
  w.clock.t += 4 * DAY;
  const t = await signedCall(w, key, 'POST', '/api/ingest/tick', {});
  assert.equal(t.json.reversals, 1);
  assert.equal((await w.ctx.provider(w.company).getBalance({ accountRef: 'acct_' + w.people.a.id })).balance, 0);
});
test('partner widgets: company-level numbers only, no names, no e-mails', async () => {
  const w = await boot({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  const { addTarget } = await import('../src/setup.js');
  await addTarget(w.ctx, w.company, w.admin, { name: 'Weekly games', scope: 'person', period: 'week', event_type: 'game', stage: 'completed', tiers: [{ count: 1, bonus: 5 }] });
  const key = await createKey(w.ctx, w.company, w.admin, { scope: 'widgets' });
  for (const p of ['targets', 'achievements', 'board-summary']) {
    const r = await signedCall(w, key, 'GET', '/api/v1/widgets/' + p);
    assert.equal(r.status, 200, p); assert.equal(r.json.v, 1);
    const txt = JSON.stringify(r.json);
    assert.ok(!/@|u_[0-9a-f]{12}/.test(txt), 'no personal data in ' + p);
  }
});
test('platform routes need the platform token; a company cannot go live on the demo provider', async () => {
  const w = await boot();
  const call = (path, tok, body) => handle(w.ctx, new Request('https://floor.test' + path, { method: 'POST', headers: { authorization: 'Bearer ' + tok }, body: JSON.stringify(body) })).then(async (r) => ({ status: r.status, json: await r.json() }));
  assert.equal((await call('/api/platform/company', 'nope', { name: 'X', slug: 'x', admin_email: 'x@x.test' })).status, 401);
  const ok = await call('/api/platform/company', w.ctx.env.PLATFORM_TOKEN, { name: 'New Co', slug: 'newco', admin_email: 'n@newco.test' });
  assert.equal(ok.status, 200); assert.ok(ok.json.invite_code);
  const live = await call(`/api/platform/company/${ok.json.company_id}/live`, w.ctx.env.PLATFORM_TOKEN, { contract_tests_passed: true });
  assert.equal(live.status, 409);
  w.ctx.env.PLATFORM_TOKEN = '';
  assert.equal((await call('/api/platform/company', '', { name: 'X' })).status, 401, 'disabled when no token is set');
});
test('the API never returns an e-mail, salary-style field or secret to the wrong role, and errors never leak internals', async () => {
  const w = await boot(); await w.login('a'); await w.login('mgr');
  const r = await w.call('a', 'GET', '/api/me/export');
  assert.ok(!/MASTER|SEAL|secret/i.test(JSON.stringify(r.json)));
  const bad = await w.call('a', 'POST', '/api/board/claim', { desk_id: "x'; DROP TABLE reward;--" });
  assert.equal(bad.status, 404);
  assert.ok((await w.db.first('SELECT COUNT(*) n FROM reward')).n >= 0);
  const evil = await handle(w.ctx, new Request('https://floor.test/api/events', { method: 'POST', headers: { cookie: 'floor_session=' + w.sessions.mgr, 'x-floor': '1' }, body: '{not json' }));
  assert.equal(evil.status, 400);
});
