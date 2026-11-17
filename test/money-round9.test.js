// Round-9 money findings from the whole-month simulation (tier net 0 != entitled 40) and the round-8 audit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './helpers.js';
import { accountRef, retryQueued } from '../src/rewards.js';
import { settleEntitlement } from '../src/periods.js';
import { closeSeason } from '../src/setup.js';
import { ProviderError } from '../src/provider/errors.js';
import { proposePenalty, approvePenalty, tickPenalties, restoreDebit } from '../src/penalty.js';

const DAY = 86400_000;
const wrap = (real, over) => new Proxy(real, { get: (t, k) => (k in over ? over[k] : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
const net = async (w, gk) => (await w.db.first("SELECT COALESCE(SUM(amount),0) s FROM reward WHERE group_key=? AND state IN ('queued','sent','waiting','recorded')", gk)).s;
const entitle = (w, entitled, gk = 'tier:t1:W1') => settleEntitlement(w.ctx, w.company, { person: w.people.a, kind: 'tier', groupKey: gk, periodKey: 'W1', entitled, at: w.clock.t, label: 'x' });

test('N1: closing a season while a reward is still queued (provider down) keeps its hold; the reward is sent, not voided', async () => {
  const w = await world();
  const real = w.ctx.provider(w.company);
  let down = true;
  w.ctx.provider = () => wrap(real, { credit: async (x) => { if (down) throw new ProviderError('provider_down'); return real.credit(x); } });
  await entitle(w, 40);
  assert.equal((await w.db.first("SELECT state FROM reward WHERE group_key='tier:t1:W1'")).state, 'queued');
  const r = await closeSeason(w.ctx, w.company, w.admin, w.season);
  assert.equal(r.released, 0);
  down = false;
  await retryQueued(w.ctx, w.company);
  assert.equal((await w.db.first("SELECT state FROM reward WHERE group_key='tier:t1:W1'")).state, 'sent');
  assert.equal(await net(w, 'tier:t1:W1'), 40);
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM audit WHERE action='season.hold_released'")).n, 1);
  await retryQueued(w.ctx, w.company);
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM audit WHERE action='season.hold_released'")).n, 1, 'released once');
});

test('N2: a tier lowered after its season closed is never paid LESS than earned (the row that cannot be topped up is kept)', async () => {
  const w = await world();
  await entitle(w, 100);
  assert.equal(await net(w, 'tier:t1:W1'), 100);
  await closeSeason(w.ctx, w.company, w.admin, w.season);
  const out = await entitle(w, 40);
  assert.equal(out.kept, 1);
  assert.equal(await net(w, 'tier:t1:W1'), 100, 'kept, not reversed to 0');
  await entitle(w, 40);
  assert.equal(await net(w, 'tier:t1:W1'), 100);
});

test('N3: a permanent account error fails the row once, then the entry is retried under a new key after the block time', async () => {
  const w = await world();
  const real = w.ctx.provider(w.company);
  let code = 'account_closed';
  w.ctx.provider = () => wrap(real, { credit: async (x) => { if (code) throw new ProviderError(code); return real.credit(x); } });
  const o1 = await entitle(w, 40);
  assert.equal(o1.failedCode, 'account_closed');
  const o2 = await entitle(w, 40);
  assert.equal(o2.failedCode, 'account_closed');
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM reward WHERE state='failed'")).n, 1, 'replay, no second row inside the block time');
  code = null; w.clock.t += 25 * 3600_000;
  const o3 = await entitle(w, 40);
  assert.equal(o3.paid, 40);
  assert.equal(await net(w, 'tier:t1:W1'), 40);
});

test('N4: a configuration error (unsupported) never fails a reward: it stays queued and is sent when the provider works', async () => {
  const w = await world();
  const real = w.ctx.provider(w.company);
  let bad = true;
  w.ctx.provider = () => wrap(real, { credit: async (x) => { if (bad) throw new ProviderError('unsupported'); return real.credit(x); } });
  await entitle(w, 40);
  const r = await w.db.first("SELECT state, last_error FROM reward WHERE group_key='tier:t1:W1'");
  assert.equal(r.state, 'queued'); assert.equal(r.last_error, 'unsupported');
  bad = false;
  await retryQueued(w.ctx, w.company);
  assert.equal((await w.db.first("SELECT state FROM reward WHERE group_key='tier:t1:W1'")).state, 'sent');
});

test('N5: a lost-race debit whose restore hits an outage is finished by the tick, once', async () => {
  const w = await world({ settings: { penalty_credit_loss: true } });
  const person = w.people.a;
  const ref = await accountRef(w.ctx, w.company, person);
  const bal = async () => (await w.db.first('SELECT balance FROM stub_account WHERE ref = ?', ref)).balance;
  const real = w.ctx.provider(w.company);
  await entitle(w, 1000);
  const c = await proposePenalty(w.ctx, w.company, w.people.mgr, { person_id: person.id, effect: 'credits', amount: 100, reason: 'test' });
  await approvePenalty(w.ctx, w.company, w.people.hr, c.id);
  await real.debit({ accountRef: ref, amount: 100, reasonCode: 'penalty', ref: c.id, idem: 'pen:' + c.id });
  const before = await bal();
  await w.db.run("UPDATE penalty_case SET state='reversed', applied_credits=0 WHERE id=?", c.id);
  let down = true;
  w.ctx.provider = () => wrap(real, { credit: async (x) => { if (down) throw new ProviderError('provider_down'); return real.credit(x); } });
  await restoreDebit(w.ctx, w.company, c.id, 100, 0);
  assert.equal(await bal(), before, 'nothing restored yet');
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM audit WHERE action='penalty.restore_pending'")).n, 1);
  down = false;
  await tickPenalties(w.ctx, w.company); await tickPenalties(w.ctx, w.company);
  assert.equal(await bal(), before + 100);
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM audit WHERE action='penalty.restore'")).n, 1);
});
