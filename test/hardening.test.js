// Round 2 security fixes: HR privacy, DPDP erase/correct/retention, sealing and rotation, audit text, scopes, limits, names and links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exampleCard, ENV, T0 } from './helpers.js';
import { boot } from './webhelp.js';
import { handle } from '../src/api.js';
import { makeCtx } from '../src/ctx.js';
import { seal, unseal } from '../src/seal.js';
import { commit } from '../src/audit.js';
import { submitEvent } from '../src/events.js';
import { addPerson, createCompany, resealAll } from '../src/people.js';
import { createTeam, addDesk, createKey, keySecret } from '../src/setup.js';
import { DAY } from '../src/util.js';

test('seal: version tag and key id, record label is authenticated, older s1 values still read, short secrets refused', async () => {
  const keys = { id: 'k9', secret: 'x'.repeat(40), old: [] };
  const blob = await seal(keys, 'hello', 'app_user.name:u1');
  assert.match(blob, /^s2\.k9\./);
  assert.equal(await unseal(keys, blob, 'app_user.name:u1'), 'hello');
  assert.equal(await unseal(keys, blob), 'hello', 'a caller that passes no label still reads (label travels with the blob)');
  await assert.rejects(unseal(keys, blob, 'app_user.name:u2'), /another record/);
  // tamper with the label: authentication fails
  const p = blob.split('.'); p[2] = btoa('app_user.name:u2');
  await assert.rejects(unseal(keys, p.join('.')));
  // an s1 value written by the old code
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('seal:' + keys.secret));
  const k = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode('old value')));
  const b64 = (u) => btoa(String.fromCharCode(...u));
  assert.equal(await unseal(keys, 's1.' + b64(iv) + '.' + b64(ct)), 'old value');
  const w = await boot();
  assert.throws(() => makeCtx({ db: w.db, env: { SEAL_KEY: 'short-secret-0123456789', MASTER_SECRET: ENV.MASTER_SECRET } }), /32\+/);
  assert.throws(() => makeCtx({ db: w.db, env: { SEAL_KEY: ENV.SEAL_KEY, MASTER_SECRET: 'short' } }), /32\+/);
});

test('rotation: a new SEAL_KEY with the old one listed still reads, and reseal moves everything to the new key', async () => {
  const w = await boot();
  const key = await createKey(w.ctx, w.company, w.admin, { scope: 'read' });
  const before = (await w.db.first('SELECT name_sealed FROM app_user WHERE id = ?', w.people.a.id)).name_sealed;
  assert.match(before, /^s2\.k1\./);
  const ctx2 = makeCtx({ db: w.db, env: { ...ENV, SEAL_KEY: 'a-brand-new-seal-key-0123456789-abcdef', SEAL_KEY_ID: 'k2', SEAL_KEYS_OLD: 'k1:' + ENV.SEAL_KEY }, now: () => w.clock.t });
  const row = await w.db.first('SELECT * FROM app_user WHERE id = ?', w.people.a.id);
  assert.equal(await ctx2.unseal(row.name_sealed, 'app_user.name:' + row.id), 'a');
  const r = await resealAll(ctx2);
  assert.equal(r.sealed_with, 'k2'); assert.ok(r.people >= 6); assert.equal(r.keys, 1);
  const after = await w.db.first('SELECT name_sealed, email_sealed FROM app_user WHERE id = ?', w.people.a.id);
  assert.match(after.name_sealed, /^s2\.k2\./); assert.match(after.email_sealed, /^s2\.k2\./);
  // without the old key, the new one alone reads everything now
  const ctx3 = makeCtx({ db: w.db, env: { ...ENV, SEAL_KEY: 'a-brand-new-seal-key-0123456789-abcdef', SEAL_KEY_ID: 'k2' }, now: () => w.clock.t });
  assert.equal(await ctx3.unseal(after.name_sealed), 'a');
  // the signing secret of the key survived (still the same secret, now sealed under k2)
  const kr = await w.db.first('SELECT * FROM company_key WHERE key_id = ?', key.key_id);
  assert.match(kr.secret_sealed, /^s2\.k2\./);
  const { secretOfKey } = await import('../src/setup.js');
  assert.equal(await secretOfKey(ctx3, kr), key.secret);
});

test('keys: the signing secret is random and sealed, an older derived key still works, scopes are validated', async () => {
  const w = await boot();
  const k = await createKey(w.ctx, w.company, w.admin, { scope: 'event_write', label: 'crm' });
  assert.notEqual(k.secret, await keySecret(w.ctx.master, k.key_id), 'not derived');
  const row = await w.db.first('SELECT * FROM company_key WHERE key_id = ?', k.key_id);
  assert.ok(row.secret_sealed.startsWith('s2.')); assert.ok(!JSON.stringify(row).includes(k.secret));
  // an older key (no sealed secret, scope from before): derived secret
  await w.db.run("INSERT INTO company_key (key_id, company_id, scope, label, created_at) VALUES ('fk_old', ?, 'read', 'old', 1)", w.company.id);
  const old = { key_id: 'fk_old', secret: await keySecret(w.ctx.master, 'fk_old') };
  const { keyCall } = await import('./webhelp.js');
  assert.equal((await keyCall(w, old, 'GET', '/api/v1/widgets/board-summary')).status, 200);
  await assert.rejects(createKey(w.ctx, w.company, w.admin, { scope: 'root' }), /Scope is one of/);
  assert.equal((await createKey(w.ctx, w.company, w.admin, { scope: 'ingest' })).scope, 'event_write', 'older names map to the new classes');
  assert.equal((await createKey(w.ctx, w.company, w.admin, { scope: 'widgets' })).scope, 'read');
  // through the admin route
  await w.login('admin');
  assert.equal((await w.call('admin', 'POST', '/api/admin/keys', { scope: 'ai_read', label: 'agent' })).status, 200);
  assert.equal((await w.call('admin', 'POST', '/api/admin/keys', { scope: 'god' })).status, 400);
  const list = await w.call('admin', 'GET', '/api/admin/keys');
  assert.ok(list.json.keys.every((x) => x.class === x.scope), 'rows carry class');
  assert.ok(!JSON.stringify(list.json).includes('secret'));
});

test('audit data holds ids and codes only: free text and names are replaced before they are chained', async () => {
  const w = await boot();
  await commit(w.ctx, w.company.id, 'u_x', 'test.text', { reason: 'Ravi Kumar was rude to a customer', note: 'x@y.example', id: 'ev_123', n: 4, nested: { text: 'two words' }, code: 'no_notice' });
  const row = await w.db.first("SELECT data FROM audit WHERE action = 'test.text'");
  const d = JSON.parse(row.data);
  assert.equal(d.reason, '[text omitted]'); assert.equal(d.note, '[text omitted]'); assert.equal(d.nested.text, '[text omitted]');
  assert.equal(d.id, 'ev_123'); assert.equal(d.n, 4); assert.equal(d.code, 'no_notice');
});

test('HR sees person ids only in the events list; a name appears only for an open case, and that look is logged', async () => {
  const w = await boot(); await exampleCard(w);
  await submitEvent(w.ctx, w.company, w.people.mgr, { person_id: w.people.a.id, event_type: 'game', stage: 'created', ext_id: 'h1', source: 'manual', occurred_at: w.clock.t });
  await w.login('hr'); await w.login('mgr'); await w.login('admin');
  const hr = await w.call('hr', 'GET', '/api/events');
  assert.equal(hr.status, 200); assert.ok(hr.json.events.length >= 1);
  assert.ok(hr.json.events.every((e) => e.person === undefined && e.person_id), 'ids only');
  assert.ok(!JSON.stringify(hr.json).includes('"a"'), 'no real name');
  const mg = await w.call('mgr', 'GET', '/api/events');
  assert.ok(mg.json.events.every((e) => e.person), 'a manager sees names for the own team');
  await w.db.run("INSERT INTO penalty_case (id, company_id, person_id, proposer_id, effect, amount, reason, state, created_at) VALUES ('pc1', ?, ?, ?, 'points', 5, 'late', 'pending', 1)", w.company.id, w.people.a.id, w.people.mgr.id);
  const open = await w.call('hr', 'GET', '/api/events');
  assert.ok(open.json.events.some((e) => e.person === 'a'), 'name for an open case');
  const audit = await w.call('admin', 'GET', '/api/admin/audit?limit=500');
  assert.ok(audit.json.rows.some((r) => r.action === 'view.person' && r.actor === w.people.hr.id), 'logged');
});

test('DPDP: a leaver is scrubbed (name, e-mail, work id, e-mail hash), the ledger stays, the e-mail can be used again', async () => {
  const w = await boot(); await exampleCard(w);
  const { user } = await addPerson(w.ctx, w.company, w.admin, { email: 'leaver@acme.test', name: 'Leaving Person', work_id: 'EMP-9' });
  await submitEvent(w.ctx, w.company, w.people.hr, { person_id: user.id, event_type: 'game', stage: 'created', ext_id: 'lv1', source: 'manual', occurred_at: w.clock.t });
  await w.login('admin'); await w.login('hr');
  assert.equal((await w.call('admin', 'POST', `/api/admin/people/${user.id}/erase`)).status, 409, 'still active');
  assert.equal((await w.call('admin', 'POST', `/api/admin/people/${user.id}/remove`)).status, 200);
  assert.equal((await w.call('a', 'POST', `/api/admin/people/${user.id}/erase`)).status, 401, 'no session');
  const r = await w.call('hr', 'POST', `/api/admin/people/${user.id}/erase`);
  assert.equal(r.status, 200); assert.match(r.json.note, /retention/);
  const row = await w.db.first('SELECT * FROM app_user WHERE id = ?', user.id);
  assert.equal(row.name_sealed, null); assert.equal(row.email_sealed, ''); assert.equal(row.work_id_sealed, null); assert.equal(row.work_id_hash, null);
  assert.equal(row.email_hash, 'erased:' + user.id); assert.ok(row.erased_at);
  assert.equal((await w.db.first('SELECT COUNT(*) n FROM event WHERE person_id = ?', user.id)).n, 1, 'events stay');
  const again = await addPerson(w.ctx, w.company, w.admin, { email: 'leaver@acme.test', name: 'Back Again' });
  assert.ok(again.user.id, 'the same e-mail can register again');
  const log = await w.db.all("SELECT data FROM audit WHERE action = 'person.erase'");
  assert.ok(log.length === 1 && !/leaver|Leaving/.test(log[0].data));
});

test('DPDP: correction endpoint, rights requests really do the work, retention list', async () => {
  const w = await boot();
  await w.login('a'); await w.login('admin'); await w.login('hr');
  const fix = await w.call('a', 'PUT', '/api/me/details', { name: 'A Corrected', work_id: 'W-1' });
  assert.equal(fix.status, 200);
  const me = await w.call('a', 'GET', '/api/me');
  assert.equal(me.json.user.name, 'A Corrected'); assert.equal(me.json.user.work_id, 'W-1');
  assert.equal((await w.call('a', 'PUT', '/api/me/details', { email: 'boss@acme.test' })).status, 409, 'cannot take another person\'s e-mail');
  assert.equal((await w.call('a', 'PUT', '/api/me/details', {})).status, 400);
  // rights: access hands over data, admin only
  await w.call('a', 'POST', '/api/me/rights', { kind: 'access' });
  await w.call('a', 'POST', '/api/me/rights', { kind: 'correction', note: 'my name' });
  const list = await w.call('admin', 'GET', '/api/admin/rights');
  const acc = list.json.requests.find((x) => x.kind === 'access'), cor = list.json.requests.find((x) => x.kind === 'correction');
  assert.equal((await w.call('hr', 'POST', `/api/admin/rights/${acc.id}/resolve`)).status, 403, 'HR does not get the person\'s data');
  const done = await w.call('admin', 'POST', `/api/admin/rights/${acc.id}/resolve`);
  assert.equal(done.json.ok, true); assert.equal(done.json.result.export.profile.name, 'A Corrected');
  assert.equal((await w.call('admin', 'POST', `/api/admin/rights/${cor.id}/resolve`)).status, 400, 'a correction needs the corrected details');
  assert.equal((await w.call('admin', 'POST', `/api/admin/rights/${cor.id}/resolve`, { name: 'A Final' })).json.ok, true);
  assert.equal((await w.call('a', 'GET', '/api/me')).json.user.name, 'A Final');
  // end of use: removed and scrubbed
  await w.call('a', 'POST', '/api/me/rights', { kind: 'end_use' });
  const eu = (await w.call('admin', 'GET', '/api/admin/rights')).json.requests.find((x) => x.kind === 'end_use');
  assert.equal((await w.call('admin', 'POST', `/api/admin/rights/${eu.id}/resolve`)).json.ok, true);
  const row = await w.db.first('SELECT * FROM app_user WHERE id = ?', w.people.a.id);
  assert.equal(row.status, 'left'); assert.ok(row.erased_at); assert.equal(row.name_sealed, null);
  assert.equal((await w.call('a', 'GET', '/api/me')).status, 401, 'sessions are gone');
  // retention list: leavers past retention_days
  await w.db.run("UPDATE app_user SET status = 'left', left_at = ? WHERE id = ?", w.clock.t - 400 * DAY, w.people.b.id);
  const due = await w.call('admin', 'GET', '/api/admin/retention');
  assert.deepEqual(due.json.due.map((x) => x.id), [w.people.b.id]); assert.match(due.json.note, /retention/);
});

test('authority: a manager clears lane tasks and decides appeals only for their own team; nobody decides their own appeal', async () => {
  const w = await boot(); await exampleCard(w);
  const m2 = await addPerson(w.ctx, w.company, w.admin, { email: 'm2@acme.test', name: 'm2', role: 'manager' });
  await createTeam(w.ctx, w.company, w.admin, { name: 'Ops', manager_id: m2.user.id });
  await w.db.run("UPDATE app_user SET team_id = (SELECT id FROM team WHERE manager_id = ?) WHERE id = ?", m2.user.id, m2.user.id);
  await w.login('m2'); await w.login('mgr'); await w.login('a');
  await w.db.run("INSERT INTO lane_task (id, company_id, person_id, task, created_at) VALUES ('lt1', ?, ?, 'catch up', 1)", w.company.id, w.people.a.id);
  assert.equal((await w.call('m2', 'POST', '/api/lane/lt1/finish')).status, 403, 'another team');
  await w.db.run("INSERT INTO penalty_case (id, company_id, person_id, proposer_id, effect, amount, reason, state, appeal_level, appeal_by, created_at) VALUES ('pc9', ?, ?, ?, 'points', 5, 'late', 'appealed', 1, 9999999999999, 1)", w.company.id, w.people.a.id, w.people.hr.id);
  assert.equal((await w.call('m2', 'POST', '/api/penalties/pc9/decide', { for_person: true })).status, 403, 'another team');
  assert.equal((await w.call('a', 'POST', '/api/penalties/pc9/decide', { for_person: true })).status, 403, 'not your own appeal');
  assert.equal((await w.call('mgr', 'POST', '/api/penalties/pc9/decide', { for_person: false, note: 'ok' })).status, 200, 'the own manager may');
  // a person cannot decide an appeal about their own event
  await w.db.run("INSERT INTO event (id, company_id, person_id, source, event_type, stage, ext_id, occurred_at, status, created_at, reversal_appeal) VALUES ('evx', ?, ?, 'api', 'game', 'created', 'x1', 1, 'reversal_pending', 1, 1)", w.company.id, w.people.mgr.id);
  assert.equal((await w.call('mgr', 'POST', '/api/events/evx/reverse/decide', { uphold: true })).status, 403);
});

test('HR audit view hides board resets; the manager view of a person shows no reset count; remove only touches own company sessions', async () => {
  const w = await boot();
  await commit(w.ctx, w.company.id, w.people.a.id, 'board.reset', { person: w.people.a.id });
  await w.login('hr'); await w.login('admin'); await w.login('mgr');
  assert.ok((await w.call('admin', 'GET', '/api/admin/audit?limit=500')).json.rows.some((r) => r.action === 'board.reset'));
  assert.ok(!(await w.call('hr', 'GET', '/api/admin/audit?limit=500')).json.rows.some((r) => r.action === 'board.reset'));
  const sum = await w.call('mgr', 'GET', `/api/people/${w.people.a.id}/summary`);
  assert.equal(sum.json.board.resets, undefined);
  // limit is clamped: a negative limit is not "everything"
  const neg = await w.call('admin', 'GET', '/api/admin/audit?limit=-1');
  assert.equal(neg.status, 200); assert.equal(neg.json.rows.length, 1);
  // a session row with the same user id but another company is not deleted by remove
  await w.db.run("INSERT INTO session (token_hash, user_id, company_id, expires_at) VALUES ('other-co', ?, 'co_other', ?)", w.people.c.id, w.clock.t + 1e9);
  await w.call('admin', 'POST', `/api/admin/people/${w.people.c.id}/remove`);
  assert.ok(await w.db.first("SELECT 1 x FROM session WHERE token_hash = 'other-co'"));
});

test('company checks: a desk target and a team must belong to this company; adding a person gives one answer for any taken e-mail', async () => {
  const w = await boot();
  const other = await createCompany(w.ctx, { name: 'Other Co', slug: 'other', adminEmail: 'x@other.test' });
  const { addTarget } = await import('../src/setup.js');
  const t = await addTarget(other.admin && w.ctx, other.company, other.admin, { name: 'Theirs', period: 'month', event_type: 'game', stage: 'completed', tiers: [{ count: 1, bonus: 1 }] });
  await assert.rejects(addDesk(w.ctx, w.company, w.admin, { square_idx: 2, name: 'Desk', target_id: t.id }), /No such target/);
  let here, there;
  try { await addPerson(w.ctx, w.company, w.admin, { email: 'a@acme.test', name: 'dup' }); } catch (e) { here = e; }
  try { await addPerson(w.ctx, w.company, w.admin, { email: 'x@other.test', name: 'dup' }); } catch (e) { there = e; }
  assert.equal(here.code, there.code); assert.equal(here.message, there.message);
});

test('HTTP limits: Origin null is refused (not a 500), a too-large body is refused before it is read, a bad JSON body is a 400', async () => {
  const w = await boot(); await w.login('a');
  const nul = await handle(w.ctx, new Request('https://floor.test/api/me/profile', { method: 'PUT', headers: { cookie: 'floor_session=' + w.sessions.a, 'x-floor': '1', origin: 'null' }, body: '{"hide_name":true}' }));
  assert.equal(nul.status, 403);
  const open = await handle(w.ctx, new Request('https://floor.test/api/auth/request-code', { method: 'POST', headers: { origin: 'null' }, body: '{}' }));
  assert.equal(open.status, 403);
  const big = await handle(w.ctx, new Request('https://floor.test/api/events', { method: 'POST', headers: { 'content-length': '99999999', cookie: 'floor_session=' + w.sessions.a, 'x-floor': '1' }, body: '{}' }));
  assert.equal(big.status, 413);
  const huge = await handle(w.ctx, new Request('https://floor.test/api/auth/request-code', { method: 'POST', body: JSON.stringify({ email: 'x'.repeat(1_600_000) }) }));
  assert.equal(huge.status, 413);
  const bad = await handle(w.ctx, new Request('https://floor.test/api/auth/request-code', { method: 'POST', body: '{nope' }));
  assert.equal(bad.status, 400);
});

test('names and links: the default unit is Moneypenny with real-price companion, terms_url is https only and comes back from /api/config', async () => {
  const w = await boot(); await w.login('admin'); await w.login('a');
  const anon = await w.call(null, 'GET', '/api/config');
  assert.equal(anon.json.unit_name, 'Moneypenny'); assert.equal(anon.json.unit_symbol, 'moneypenny'); assert.equal(anon.json.local_per_usd, 85);
  assert.equal(anon.json.terms_url, null); assert.match(anon.json.hide_name_notice, /manager, HR and the company admin/);
  for (const bad of ['http://x.example/terms', 'javascript:alert(1)', 'https://a b.example', 'ftp://x']) assert.equal((await w.call('admin', 'PUT', '/api/admin/settings', { terms_url: bad })).status, 400, bad);
  assert.equal((await w.call('admin', 'PUT', '/api/admin/settings', { terms_url: 'https://acme.example/terms', unit_name: 'Acme points' })).status, 200);
  const cfg = await w.call('a', 'GET', '/api/config');
  assert.equal(cfg.json.terms_url, 'https://acme.example/terms'); assert.equal(cfg.json.unit_name, 'Acme points');
  const me = await w.call('a', 'GET', '/api/me');
  assert.equal(me.json.company.terms_url, 'https://acme.example/terms'); assert.equal(me.json.company.local_per_usd, 85); assert.ok(me.json.hide_name_notice);
  assert.equal((await w.call('admin', 'PUT', '/api/admin/settings', { terms_url: '' })).status, 200);
  assert.equal((await w.call('a', 'GET', '/api/config')).json.terms_url, null);
});

test('login: a locked-out address does not lock the person out, and the block lifts when the window ends', async () => {
  const w = await boot();
  const { issueCode } = await import('../src/people.js');
  w.codes.c = await issueCode(w.ctx, w.people.c);
  for (let i = 0; i < 5; i++) await w.call(null, 'POST', '/api/auth/login', { email: 'c@acme.test', code: 'BADBADBA' }, { 'cf-connecting-ip': '198.51.100.1' });
  assert.equal((await w.call(null, 'POST', '/api/auth/login', { email: 'c@acme.test', code: w.codes.c }, { 'cf-connecting-ip': '198.51.100.1' })).status, 429);
  w.clock.t += 16 * 60_000;
  w.codes.c = await issueCode(w.ctx, w.people.c);
  assert.equal((await w.call(null, 'POST', '/api/auth/login', { email: 'c@acme.test', code: w.codes.c }, { 'cf-connecting-ip': '198.51.100.1' })).status, 200);
});

test('audit: a guarded write that changed nothing can leave no audit line (onlyIfChanged)', async () => {
  const w = await boot();
  const n0 = (await w.db.first('SELECT COUNT(*) n FROM audit')).n;
  await commit(w.ctx, w.company.id, 'sys', 'guard.lost', { id: 'x' }, [["UPDATE company SET name = name WHERE id = 'nope'"]], { onlyIfChanged: true });
  assert.equal((await w.db.first('SELECT COUNT(*) n FROM audit')).n, n0, 'nothing changed, no line');
  await commit(w.ctx, w.company.id, 'sys', 'guard.won', { id: 'x' }, [['UPDATE company SET name = name WHERE id = ?', w.company.id]], { onlyIfChanged: true });
  assert.equal((await w.db.first('SELECT COUNT(*) n FROM audit')).n, n0 + 1);
});
test('settings: caps have a hard ceiling', async () => {
  const w = await boot(); await w.login('admin');
  assert.equal((await w.call('admin', 'PUT', '/api/admin/settings', { cap_person_month: 5_000_000 })).status, 400);
  assert.equal((await w.call('admin', 'PUT', '/api/admin/settings', { cap_person_month: 900_000 })).status, 200);
});
