// Round-15: provider_op hardening (hung/dead workers, stale replies) and the v1 rule: hold, debit and reverse are NOT ENABLED in v1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, ENV } from './helpers.js';
import { settleEntitlement } from '../src/periods.js';
import { accountRef } from '../src/rewards.js';
import { ProviderError } from '../src/provider/errors.js';
import { intend, run, openOps, retryOps } from '../src/provider-ops.js';
import { updateSettings, createCompany } from '../src/people.js';
import { v1Caps } from '../src/v1.js';
import { makeCtx } from '../src/ctx.js';
import { openDb, migrate } from '../src/db.js';

const entitle = (w, e) => settleEntitlement(w.ctx, w.company, { person: w.people.a, kind: 'tier', groupKey: 'tier:t1:W1', periodKey: 'W1', entitled: e, at: w.clock.t, label: 'x' });
const provBal = async (w) => (await w.db.first('SELECT balance FROM stub_account WHERE ref=?', await accountRef(w.ctx, w.company, w.people.a))).balance;
const mk = (w, key) => intend(w.ctx, w.company, { kind: 'debit', key, subject: 's', params: {} });

test('W1 V1: a worker that throws a non-provider error, or dies after claiming, leaves an op that is surfaced and retriable (never silent)', async () => {
  const w = await world();
  const op = await mk(w, 'k1');
  for (let i = 0; i < 5; i++) { w.clock.t += 120_000; await assert.rejects(run(w.ctx, w.company, op, async () => { throw new Error('bug'); })); }
  assert.equal(await openOps(w.ctx, w.company.id, ['debit']), 1, 'surfaced');
  const row = await w.db.first("SELECT state FROM provider_op WHERE key='k1'");
  assert.equal(row.state, 'unknown', 'treated as unknown, not stuck intended');
  const dead = await mk(w, 'k2'); // a worker that claimed and died: simulate the row it leaves
  await w.db.run("UPDATE provider_op SET state='intended', tries=5, claim_until=0 WHERE id=?", dead.id);
  assert.equal(await openOps(w.ctx, w.company.id, ['debit']), 2, 'an exhausted op in state intended is surfaced too');
  assert.equal((await retryOps(w.ctx, w.company)).retried, 2);
  w.clock.t += 120_000;
  assert.equal((await run(w.ctx, w.company, dead, async () => ({ ok: 1 }))).state, 'landed');
});

test('W2 V3: a stale worker\'s late "no" cannot overwrite a landed answer; it acts on the stored state', async () => {
  const w = await world();
  const op = await mk(w, 'k3');
  let release; const gate = new Promise((r) => { release = r; });
  const slow = run(w.ctx, w.company, op, async () => { await gate; throw new ProviderError('account_closed'); }); // would be a believed first refusal
  await new Promise((r) => setTimeout(r, 10));
  w.clock.t += 120_000; // its lease ran out
  const fast = await run(w.ctx, w.company, op, async () => ({ debited: 20 }));
  assert.equal(fast.state, 'landed');
  release();
  const late = await slow;
  assert.equal(late.state, 'landed', 'the stale worker sees the stored state');
  assert.equal((await w.db.first("SELECT state FROM provider_op WHERE key='k3'")).state, 'landed');
});

test('W3 v1: hold, debit and reverse are false for the demo provider; a provider that declares them is a config error', async () => {
  const w = await world({ v1: true });
  const caps = await w.ctx.provider(w.company).capabilities();
  assert.equal(caps.hold, false); assert.equal(caps.debit, false); assert.equal(caps.reverse, false);
  assert.throws(() => v1Caps({}, { live: 0 }, { hold: true, debit: false, reverse: false }, false), /not enabled in v1/);
  assert.equal(v1Caps({ FUTURE_OPS: '1' }, { live: 0 }, { hold: true }, true).hold, true, 'test switch');
  assert.equal(v1Caps({ FUTURE_OPS: '1' }, { live: 1 }, { hold: true }, true).hold, false, 'never for a live company');
  assert.equal(v1Caps({ FUTURE_OPS: '1', ENVIRONMENT: 'production' }, { live: 0 }, { hold: true }, true).hold, false, 'never in production');
});

test('W4 v1: credit-loss penalties cannot be switched on; the switch is refused at startup in production', async () => {
  const w = await world({ v1: true });
  await assert.rejects(updateSettings(w.ctx, w.company, w.admin, { penalty_credit_loss: true }), /not enabled in v1/);
  const db = openDb(); migrate(db);
  const ctx = makeCtx({ db, env: { ...ENV, FUTURE_OPS: undefined } });
  await assert.rejects(createCompany(ctx, { name: 'X', slug: 'x', adminEmail: 'a@x.test', settings: { penalty_credit_loss: true } }), /not enabled in v1/);
  assert.throws(() => makeCtx({ db, env: { ...ENV, ENVIRONMENT: 'production' } }), /not enabled in v1/);
});

test('W5 v1 credit path: no season hold, and a downgrade books a correction instead of a reverse', async () => {
  const w = await world({ v1: true });
  assert.equal((await w.db.first('SELECT hold_id h FROM season WHERE id=?', w.season)).h, null);
  await entitle(w, 100); const before = await provBal(w);
  await entitle(w, 40).catch(() => {});
  assert.equal(await provBal(w), before, 'nothing is taken back from the account and nothing is paid again');
  const c = await w.db.first('SELECT COALESCE(SUM(amount),0) a, COALESCE(SUM(recovered),0) r FROM correction');
  assert.equal(c.a, 60, 'only the difference is owed'); assert.equal(c.r, 0);
  assert.equal((await w.db.first('SELECT COUNT(*) n FROM provider_op')).n, 0, 'no hold / debit / reverse operation exists');
});
