// Round-4 money findings: each test pins one failure that the round-4 audit found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, exampleCard, SYSTEM, T0 } from './helpers.js';
import { submitEvent, requestReversal, approveReversal, appealReversal, decideReversalAppeal, processReversals } from '../src/events.js';
import { settleEntitlement } from '../src/periods.js';
import { grant, releaseWaiting, reverseReward, retryQueued } from '../src/rewards.js';
import { ProviderError } from '../src/provider/errors.js';
import { StubProvider } from '../src/provider/stub.js';

const DAY = 86400_000;
const wrap = (real, over) => new Proxy(real, { get: (t, k) => (k in over ? over[k] : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
const balance = async (w, person) => (await new StubProvider(w.db, w.company.id).getBalance({ accountRef: 'acct_' + person.id })).balance;
const count = (w, where) => w.db.first(`SELECT COUNT(*) n FROM reward WHERE ${where}`).then((r) => r.n);
const audits = (w) => w.db.first('SELECT COUNT(*) n FROM audit').then((r) => r.n);

test('H1: a tier bonus voided as no_season is not re-created at every tick', async () => {
  const w = await world();
  const a = w.people.a;
  const at = T0 + 350 * DAY; // no season covers this date
  const args = { person: a, kind: 'tier', groupKey: 'tier:t1:PX', periodKey: 'PX', at, label: 't', entitled: 100 };
  await settleEntitlement(w.ctx, w.company, args);
  assert.equal(await count(w, "group_key='tier:t1:PX' AND state='waiting'"), 1);
  w.clock.t = at + 30 * DAY;
  let rows = null, lines = null;
  for (let i = 0; i < 4; i++) {
    await releaseWaiting(w.ctx, w.company);
    await settleEntitlement(w.ctx, w.company, args);
    if (i === 0) { rows = await count(w, "group_key='tier:t1:PX'"); lines = await audits(w); }
  }
  assert.equal(await count(w, "group_key='tier:t1:PX' AND state='void' AND last_error='no_season'"), 1);
  assert.equal(await count(w, "group_key='tier:t1:PX'"), rows, 'row count stays constant');
  assert.equal(await audits(w), lines, 'no more audit lines');
});

test('H2: reversing a sent reward gives back the corrections it had taken', async () => {
  const w = await world();
  const a = w.people.a;
  await w.db.run("INSERT INTO correction (id, company_id, person_id, amount, recovered, state, reason, created_at) VALUES ('cr1',?,?,30,0,'open','t',?)", w.company.id, a.id, w.clock.t);
  const g = await grant(w.ctx, w.company, { person: a, kind: 'event', amount: 100, idem: 'h2:1', groupKey: 'g', at: w.clock.t, actor: 'system' });
  assert.equal(g.reward.state, 'sent'); assert.equal(g.reward.sent_amount, 70);
  assert.deepEqual({ ...(await w.db.first("SELECT recovered, state FROM correction WHERE id='cr1'")) }, { recovered: 30, state: 'cleared' });
  await reverseReward(w.ctx, w.company, g.reward, { reason: 'x' });
  assert.deepEqual({ ...(await w.db.first("SELECT recovered, state FROM correction WHERE id='cr1'")) }, { recovered: 0, state: 'open' }, 'the debt is owed again');
});

/** An event whose credit is queued while the provider is down, with a manager-kind reversal approved on it. */
async function halfReversed(extId) {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  await exampleCard(w);
  const real = new StubProvider(w.db, w.company.id);
  const state = { down: true };
  w.ctx.provider = () => wrap(real, { credit: async (x) => { if (state.down) throw new ProviderError('provider_down', 'down'); return real.credit(x); } });
  const r = await submitEvent(w.ctx, w.company, SYSTEM, { person_id: w.people.a.id, event_type: 'game', stage: 'completed', ext_id: extId, source: 'api', occurred_at: T0 });
  await requestReversal(w.ctx, w.company, w.people.mgr, r.id, { reason: 'fake', kind: 'fake' });
  const out = await approveReversal(w.ctx, w.company, w.people.hr, r.id);
  assert.equal(out.status, 'reversal_pending'); assert.ok(out.pending > 0);
  return { w, r, state };
}

test('H3: once a reversal has started, the person can no longer appeal it away', async () => {
  const { w, r } = await halfReversed('h3');
  await assert.rejects(appealReversal(w.ctx, w.company, w.people.a, r.id), /already/);
  // a denial can never restore 'applied' once a reversal row exists
  await w.db.run('UPDATE event SET reversal_appeal = 1 WHERE id = ?', r.id);
  await w.db.run("INSERT INTO reward (id, company_id, person_id, kind, idem_key, amount, state, created_at, sent_amount, event_id) VALUES ('rwx',?,?,'reversal','rev:fake',-1,'recorded',?,0,?)", w.company.id, w.people.a.id, T0, r.id);
  await assert.rejects(decideReversalAppeal(w.ctx, w.company, w.people.admin, r.id, false), /already done/);
  assert.equal((await w.db.first('SELECT status FROM event WHERE id=?', r.id)).status, 'reversal_pending');
});

test('H4: a manager-kind reversal that was left half done is retried by the tick', async () => {
  const { w, r, state } = await halfReversed('h4');
  assert.equal(await processReversals(w.ctx, w.company), 0);
  state.down = false;
  await retryQueued(w.ctx, w.company);
  assert.equal(await balance(w, w.people.a), 40);
  assert.equal(await processReversals(w.ctx, w.company), 1);
  assert.equal((await w.db.first('SELECT status FROM event WHERE id=?', r.id)).status, 'reversed');
  assert.equal(await balance(w, w.people.a), 0);
});

test('H5: one reversal that throws does not stop the tick', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } });
  await exampleCard(w);
  for (const k of ['a', 'b']) {
    const r = await submitEvent(w.ctx, w.company, SYSTEM, { person_id: w.people[k].id, event_type: 'game', stage: 'completed', ext_id: 'h5' + k, source: 'api', occurred_at: T0 });
    await requestReversal(w.ctx, w.company, SYSTEM, r.id, { reason: 'refund', kind: 'refund' });
  }
  const real = new StubProvider(w.db, w.company.id);
  let first = true;
  w.ctx.provider = () => wrap(real, { reverse: async (x) => { if (first) { first = false; throw new ProviderError('provider_down', 'down'); } return real.reverse(x); } });
  w.clock.t += 4 * DAY;
  assert.equal(await processReversals(w.ctx, w.company), 1, 'the second event is reversed');
  assert.equal(await processReversals(w.ctx, w.company), 1, 'the first is retried at the next tick');
});

test('H6: credits handed back (penalty_return) are never voided as no_season', async () => {
  const w = await world();
  const at = T0 + 350 * DAY; // no published season covers it
  const g = await grant(w.ctx, w.company, { person: w.people.a, kind: 'penalty_return', amount: 40, idem: 'h6:1', groupKey: 'penrev', at, bypassCaps: true, actor: 'system' });
  assert.equal(g.reward.state, 'sent', 'paid at once, never waits for a season');
  await w.db.run("INSERT INTO reward (id, company_id, person_id, kind, idem_key, amount, state, note, created_at, sent_amount, attempts) VALUES ('legacy',?,?,'penalty_return','h6:2',40,'waiting',?,?,40,0)", w.company.id, w.people.a.id, JSON.stringify({ at, bypass: true }), at);
  w.clock.t = at + 30 * DAY;
  await releaseWaiting(w.ctx, w.company);
  assert.equal((await w.db.first("SELECT state FROM reward WHERE id='legacy'")).state, 'waiting', 'not voided');
});
