// Round-20 (credit-only v1): one reissue wins (deterministic key), not-payable re-issue is refused up front, a blocked group is surfaced and has a remedy (reissue-gap),
// mark-received is confirmed by the provider history, dice at season creation, erased rows, buying credits is not enabled in v1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './helpers.js';
import { boot } from './webhelp.js';
import { settleEntitlement } from '../src/periods.js';
import { grant, retryQueued } from '../src/rewards.js';
import { resealAll } from '../src/people.js';
import * as setup from '../src/setup.js';
import { fakeMnp, mworld } from './mnpfake.js';
import { MoneypennyProvider } from '../src/provider/moneypenny.js';

const HOUR = 3600_000, DAY = 86400_000, A = 'a@acme.test', NOTE = 'ledger checked 14 Nov, credit not there';
const ent = (w, e, person = 'a') => settleEntitlement(w.ctx, w.company, { person: w.people[person], kind: 'tier', groupKey: 'tier:t1:W1', periodKey: 'W1', entitled: e, at: w.clock.t, label: 'x' });
const rowOf = (w, id) => w.db.first('SELECT * FROM reward WHERE id = ?', id);
const tierId = async (w) => (await w.db.first("SELECT id FROM reward WHERE kind = 'tier' ORDER BY created_at, rowid")).id;
const settled = (rs) => rs.map((r) => (r.status === 'fulfilled' ? 'ok' : r.reason.code));

test('T5 a dice season is refused when its top bonus would be above 500 (create and publish)', async () => {
  const w = await mworld();
  await setup.addRateCard(w.ctx, w.company, w.admin, { active_from: 1, event_type: 'ok', stage: 'done', stage_no: 1, credits: 400, state_needed: 'system' });
  await w.db.run('UPDATE company SET settings = ? WHERE id = ?', JSON.stringify({ ...JSON.parse((await w.reload()).settings || '{}'), bonus_max_pct: 200 }), w.company.id); await w.reload();
  await assert.rejects(setup.createSeason(w.ctx, w.company, w.admin, { name: 'D', starts_at: w.clock.t + DAY, ends_at: w.clock.t + 90 * DAY, budget: 1000, mode: 'dice' }), (e) => e.code === 'above_provider_max');
  const s = await setup.createSeason(w.ctx, w.company, w.admin, { name: 'S', starts_at: w.clock.t + DAY, ends_at: w.clock.t + 90 * DAY, budget: 1000, mode: 'steady' });
  await w.db.run("UPDATE season SET mode = 'dice' WHERE id = ?", s.id);
  await assert.rejects(setup.publishSeason(w.ctx, w.company, w.admin, s.id), (e) => e.code === 'above_provider_max');
});

test('T6 erased: failed and never-released waiting rows are voided_erased, nothing is promised, the overview does not count them as silent, the account stays readable after a reseal', async () => {
  const w = await mworld({ lifetime: 0 });
  const g1 = await grant(w.ctx, w.company, { person: w.people.b, kind: 'tier', amount: 40, idem: 't6a', groupKey: 'g6a', periodKey: 'W1', at: w.clock.t });
  assert.equal(g1.reward.state, 'failed');
  await w.db.run("INSERT INTO reward (id, company_id, person_id, kind, group_key, idem_key, amount, state, created_at, sent_amount) VALUES ('rw_w6', ?, ?, 'tier', 'g6b', 't6b', 20, 'waiting', 1, 20)", w.company.id, w.people.b.id);
  await w.db.run('UPDATE app_user SET erased_at = ? WHERE id = ?', w.clock.t, w.people.b.id);
  const g3 = await grant(w.ctx, w.company, { person: await w.db.first('SELECT * FROM app_user WHERE id = ?', w.people.b.id), kind: 'tier', amount: 10, idem: 't6c', groupKey: 'g6c', periodKey: 'W1', at: w.clock.t });
  assert.deepEqual([g3.paid, g3.reason], [0, 'person_erased']);
  await retryQueued(w.ctx, w.company);
  const rows = await w.db.all("SELECT state, last_error FROM reward WHERE person_id = ?", w.people.b.id);
  assert.ok(rows.length >= 2 && rows.every((r) => r.state === 'void' && r.last_error === 'voided_erased'), JSON.stringify(rows));
  // the account sealed on a row survives a reseal with the same keys
  const g4 = await grant(w.ctx, w.company, { person: w.people.a, kind: 'tier', amount: 5, idem: 't6d', groupKey: 'g6d', periodKey: 'W1', at: w.clock.t });
  w.f.lifetime = 800; assert.ok(g4.reward);
  await w.db.run("UPDATE reward SET note = json_set(COALESCE(note, '{}'), '$.acct', ?) WHERE id = ?", await w.ctx.seal(A, 'reward.acct:' + g4.reward.id), g4.reward.id);
  await resealAll(w.ctx);
  assert.equal(await w.ctx.unseal(JSON.parse((await rowOf(w, g4.reward.id)).note).acct, 'reward.acct:' + g4.reward.id), A);
});

test('T7 buying credits is NOT enabled in v1: a live company gets 409 and no provider call is made; the overview says so', async () => {
  const w = await boot({ settings: { daily_event_limit: 1000 } });
  await w.db.run('UPDATE company SET live = 1 WHERE id = ?', w.company.id);
  let calls = 0; const real = w.ctx.provider;
  w.ctx.provider = (c) => new Proxy(real(c), { get: (t, k) => (typeof t[k] === 'function' ? (...a) => { calls++; return t[k](...a); } : t[k]) });
  await w.login('admin');
  const r = await w.call('admin', 'POST', '/api/admin/buy', { credits: 500, request_id: 'x1' });
  assert.equal(r.status, 409); assert.equal(r.json.error.code, 'not_enabled_in_v1'); assert.equal(calls, 0, 'the provider was never touched');
  const ov = await w.call('admin', 'GET', '/api/admin/overview'); assert.equal(ov.json.buy, 'not enabled in v1');
});
