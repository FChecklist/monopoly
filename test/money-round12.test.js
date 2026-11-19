// Round-12 money findings (audit 11B). Each test pins one failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, exampleCard, SYSTEM } from './helpers.js';
import { submitEvent } from '../src/events.js';
import { settleEntitlement } from '../src/periods.js';
import { accountRef, retryQueued, reviveFailedRewards } from '../src/rewards.js';
import { ProviderError } from '../src/provider/errors.js';
import { proposePenalty, approvePenalty, tickPenalties } from '../src/penalty.js';
import * as setup from '../src/setup.js';
import { tick } from '../src/api.js';

const DAY = 86400_000;
const wrap = (real, over) => new Proxy(real, { get: (t, k) => (k in over ? over[k] : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
const entitle = (w, e, gk = 'tier:t1:W1', person = 'a') => settleEntitlement(w.ctx, w.company, { person: w.people[person], kind: 'tier', groupKey: gk, periodKey: 'W1', entitled: e, at: w.clock.t, label: 'x' });
const provBal = async (w, person = 'a') => (await w.db.first('SELECT balance FROM stub_account WHERE ref=?', await accountRef(w.ctx, w.company, w.people[person]))).balance;
const auditN = (w, action) => w.db.first('SELECT COUNT(*) n FROM audit WHERE action=?', action).then((r) => r.n);

test('S1: the old hold of a raised budget goes back even when the first release fails', async () => {
  const w = await world({ budget: 1000 }); const real = w.ctx.provider(w.company);
  const released = []; let fail = true;
  w.ctx.provider = () => wrap(real, { releaseHold: async (x) => { released.push(x.holdId); if (fail) { fail = false; throw new ProviderError('provider_down'); } return real.releaseHold(x); } });
  const old = (await w.db.first('SELECT hold_id FROM season WHERE id=?', w.season)).hold_id;
  await setup.raiseBudget(w.ctx, w.company, w.admin, w.season, 2000);
  assert.equal(await auditN(w, 'season.hold_freed'), 0);
  await retryQueued(w.ctx, w.company);
  assert.deepEqual(released, [old, old]);
  assert.equal(await auditN(w, 'season.hold_freed'), 1);
  await retryQueued(w.ctx, w.company);
  assert.equal(released.length, 2, 'released once, then left alone');
});

test('S2: a hold reserved for a raise whose commit failed is released by the tick', async () => {
  const w = await world({ budget: 1000 }); const real = w.ctx.provider(w.company);
  const released = [];
  w.ctx.provider = () => wrap(real, { releaseHold: async (x) => { released.push(x.holdId); return real.releaseHold(x); } });
  const orig = w.db.batch.bind(w.db); let boom = true;
  w.db.batch = async (st) => { if (boom && st.some(([, ...p]) => p.includes('season.budget'))) { boom = false; throw new Error('crash'); } return orig(st); };
  await setup.raiseBudget(w.ctx, w.company, w.admin, w.season, 2000).catch(() => {});
  const orphan = (await w.db.first("SELECT result FROM provider_op WHERE kind='hold_reserve' ORDER BY rowid LIMIT 1")).result;
  const orphanId = JSON.parse(orphan).hold_id;
  await setup.raiseBudget(w.ctx, w.company, w.admin, w.season, 2500);
  w.clock.t += 11 * 60_000;
  await retryQueued(w.ctx, w.company);
  assert.ok(released.includes(orphanId), 'the orphan hold went back');
  const current = (await w.db.first('SELECT hold_id FROM season WHERE id=?', w.season)).hold_id;
  assert.ok(!released.includes(current), 'the live hold stays');
});

test('S3a: a lost-reply debit followed by a permanent "no" is not believed: the case stays pending, bounded', async () => {
  const w = await world({ settings: { penalty_credit_loss: true } }); const real = w.ctx.provider(w.company);
  await entitle(w, 100);
  let n = 0;
  w.ctx.provider = () => wrap(real, { debit: async (x) => { n++; if (n === 1) { await real.debit(x); throw new ProviderError('timeout'); } throw new ProviderError('account_closed'); } });
  const c = await proposePenalty(w.ctx, w.company, w.admin, { person_id: w.people.a.id, effect: 'credits', amount: 20, reason: 'r' });
  await approvePenalty(w.ctx, w.company, w.people.hr, c.id);
  w.clock.t += 4 * DAY;
  for (let i = 0; i < 8; i++) await tickPenalties(w.ctx, w.company);
  const row = await w.db.first('SELECT state, applied_credits FROM penalty_case WHERE id=?', c.id);
  assert.equal(row.state, 'pending', 'not recorded as "no debit"');
  assert.ok((await auditN(w, 'penalty.debit_failed')) <= 5, 'bounded');
  assert.equal(await auditN(w, 'penalty.apply'), 0);
});

test('S3b: a lost-reply reverse followed by a permanent "no" books no owed correction', async () => {
  const w = await world(); const real = w.ctx.provider(w.company);
  await entitle(w, 40);
  let n = 0;
  w.ctx.provider = () => wrap(real, { reverse: async (x) => { n++; if (n === 1) { await real.reverse(x); throw new ProviderError('timeout'); } throw new ProviderError('account_closed'); } });
  await entitle(w, 0).catch(() => {});
  await entitle(w, 0).catch(() => {});
  assert.equal((await w.db.first('SELECT COALESCE(SUM(amount),0) s FROM correction')).s, 0);
  assert.equal((await w.db.first("SELECT reversed FROM reward WHERE kind='tier'")).reversed, 0, 'still waiting for a clear answer');
});

test('S3c: a credit that got a permanent "no" after a lost reply stays queued first', async () => {
  const w = await world(); const real = w.ctx.provider(w.company);
  let n = 0;
  w.ctx.provider = () => wrap(real, { credit: async (x) => { n++; if (n === 1) { await real.credit(x); throw new ProviderError('provider_down'); } throw new ProviderError('account_closed'); } });
  await entitle(w, 40); await tick(w.ctx, w.company);
  const row = await w.db.first("SELECT state, last_error FROM reward WHERE kind='tier'");
  assert.equal(row.state, 'queued'); assert.equal(row.last_error, 'ambiguous_account_closed');
});

test('S3d: a revived credit repeats the amount of the first try (correction offset kept), so the replay matches', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  const real = w.ctx.provider(w.company);
  await w.db.run("INSERT INTO correction (id, company_id, person_id, amount, state, reason, created_at) VALUES ('crx',?,?,100,'open','t',?)", w.company.id, w.people.a.id, w.clock.t);
  let n = 0, fixed = false;
  w.ctx.provider = () => wrap(real, { credit: async (x) => { if (fixed) return real.credit(x); n++; if (n === 1) { await real.credit(x); throw new ProviderError('provider_down'); } throw new ProviderError('account_closed'); } });
  await submitEvent(w.ctx, w.company, SYSTEM, { person_id: w.people.a.id, event_type: 'game', stage: 'completed', ext_id: 's3d', source: 'api', occurred_at: w.clock.t });
  for (let i = 0; i < 6; i++) await tick(w.ctx, w.company);
  assert.equal((await w.db.first("SELECT state FROM reward WHERE kind='event' AND person_id=?", w.people.a.id)).state, 'failed');
  const first = await provBal(w);
  fixed = true;
  assert.equal((await reviveFailedRewards(w.ctx, w.company)).revived, 1);
  const row = await w.db.first("SELECT state, sent_amount FROM reward WHERE kind='event' AND person_id=?", w.people.a.id);
  assert.equal(row.state, 'sent');
  assert.equal(row.sent_amount, first, 'the row records what the provider holds');
  assert.equal(await provBal(w), first, 'not paid twice');
  assert.equal((await w.db.first("SELECT recovered FROM correction WHERE id='crx'")).recovered, 40 - first);
});
