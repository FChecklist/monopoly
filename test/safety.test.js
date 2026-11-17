// Safety nets: forbidden words, secrets, audit chain, shop, rights, consent, the single-door rule for credit providers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { world, exampleCard, SYSTEM } from './helpers.js';
import { scan as scanWords } from '../scripts/scan-words.js';
import { scan as scanSecrets } from '../scripts/scan-secrets.js';
import { verifyChain } from '../src/audit.js';
import { submitEvent } from '../src/events.js';
import { addItem, placeOrder, decideOrder } from '../src/setup.js';
import { recordConsent } from '../src/people.js';
import { PRODUCT } from '../src/config.js';

test('word scan: no other maker\'s words anywhere in shipped files; the brand is one config string', () => {
  assert.deepEqual(scanWords('.'), []);
  assert.ok(typeof PRODUCT.name === 'string' && PRODUCT.name.length > 0, 'the brand is a config string');
  assert.equal(PRODUCT.slug, 'floor', 'neutral code name');
});
test('secret scan is clean', () => assert.deepEqual(scanSecrets('.'), []));
test('single door: only src/provider and src/ctx.js may import a provider class', () => {
  for (const f of readdirSync('src', { recursive: true }).filter((x) => String(x).endsWith('.js'))) {
    const p = String(f).replace(/\\/g, '/');
    if (p.startsWith('provider/') || p === 'ctx.js') continue;
    const t = readFileSync('src/' + f, 'utf8');
    assert.ok(!/from '\.\/provider\/(stub|moneypenny)\.js'|from '\.\.\/provider\/(stub|moneypenny)/.test(t), `${p} imports a provider directly`);
    assert.ok(!/stub_(account|entry|hold)/.test(t), `${p} touches demo provider tables`);
  }
});
test('audit chain verifies, and tampering or deleting a row is blocked or detected', async () => {
  const w = await world(); await exampleCard(w);
  await submitEvent(w.ctx, w.company, w.people.mgr, { person_id: w.people.a.id, event_type: 'game', stage: 'created', ext_id: 'au1', source: 'manual', occurred_at: w.clock.t });
  const v = await verifyChain(w.db, w.company.id);
  assert.equal(v.ok, true); assert.ok(v.rows > 5);
  await assert.rejects(w.db.run("UPDATE audit SET action = 'x' WHERE n = 2"), /cannot change/);
  await assert.rejects(w.db.run('DELETE FROM audit WHERE n = 2'), /cannot be deleted/);
  w.db.exec('DROP TRIGGER audit_no_update');
  w.db.exec("UPDATE audit SET data = '{}' WHERE n = 3");
  assert.equal((await verifyChain(w.db, w.company.id)).ok, false, 'a changed row is detected');
});
test('audit rows never hold names or e-mails', async () => {
  const w = await world(); await exampleCard(w);
  const dump = JSON.stringify(await w.db.all('SELECT actor, action, data FROM audit'));
  assert.ok(!/@acme|boss@|"name"/.test(dump));
});
test('personal fields are sealed at rest: no plain name, e-mail or work id in the database', async () => {
  const w = await world();
  const { addPerson } = await import('../src/people.js');
  await addPerson(w.ctx, w.company, w.admin, { email: 'sealed.person@acme.test', name: 'Sealed Person', work_id: 'EMP-4471' });
  const rows = JSON.stringify(await w.db.all('SELECT * FROM app_user'));
  for (const s of ['Sealed Person', 'sealed.person', 'EMP-4471']) assert.ok(!rows.includes(s), s);
  const u = await w.db.first('SELECT * FROM app_user WHERE work_id_hash IS NOT NULL');
  assert.equal(await w.ctx.unseal(u.name_sealed), 'Sealed Person');
});
test('consent: never pre-ticked, must be true from the person', async () => {
  const w = await world();
  await assert.rejects(recordConsent(w.ctx, w.company, w.people.a, 'terms', undefined), /never pre-ticked/);
  await assert.rejects(recordConsent(w.ctx, w.company, w.people.a, 'terms', 'true'), /never pre-ticked/);
  await recordConsent(w.ctx, w.company, w.people.a, 'terms', true);
});
test('shop: reserve then capture takes credits, decline releases them, not enough credits is refused, nothing is transferred between people', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  const { ctx, company, admin } = w, a = w.people.a;
  await submitEvent(ctx, company, SYSTEM, { person_id: a.id, event_type: 'game', stage: 'completed', ext_id: 's1', source: 'api', occurred_at: w.clock.t });
  const it = await addItem(ctx, company, admin, { name: 'Team lunch', credits: 30 });
  const prov = ctx.provider(company);
  const bal = async () => (await prov.getBalance({ accountRef: 'acct_' + a.id })).balance;
  const o1 = await placeOrder(ctx, company, a, it.id);
  assert.equal(o1.state, 'reserved'); assert.equal((await prov.getBalance({ accountRef: 'acct_' + a.id })).spendable, 10);
  await decideOrder(ctx, company, admin, o1.id, false);
  assert.equal((await prov.getBalance({ accountRef: 'acct_' + a.id })).spendable, 40);
  const o2 = await placeOrder(ctx, company, a, it.id);
  await decideOrder(ctx, company, admin, o2.id, true);
  assert.equal(await bal(), 10);
  await assert.rejects(placeOrder(ctx, company, a, it.id), /Not enough credits/);
  await assert.rejects(decideOrder(ctx, company, w.people.a, o1.id, true), /cannot do this/);
});
test('rate-limits and caps in the schema: unique keys exist for events, rewards, approvals', async () => {
  const w = await world();
  const idx = await w.db.all("SELECT sql FROM sqlite_master WHERE sql LIKE '%UNIQUE%'");
  const all = idx.map((i) => i.sql).join('\n');
  assert.match(all, /idem_key TEXT NOT NULL UNIQUE/); assert.match(all, /UNIQUE \(company_id, event_type, ext_id, stage\)/); assert.match(all, /UNIQUE \(event_id, approver_id\)/);
});
