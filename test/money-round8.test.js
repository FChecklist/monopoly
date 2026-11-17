// Round-8 money finding: a stale loser of an apply race must replay the SAME restore key (one debit, one credit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './helpers.js';
import { grant, accountRef } from '../src/rewards.js';
import { proposePenalty, approvePenalty, appealPenalty, decideAppeal, tickPenalties, restoreDebit } from '../src/penalty.js';

const DAY = 86400_000;
const wrap = (real, over) => new Proxy(real, { get: (t, k) => (k in over ? over[k] : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
async function setup8() {
  const w = await world({ settings: { penalty_credit_loss: true } });
  const person = w.people.a;
  await grant(w.ctx, w.company, { person, kind: 'event', amount: 1000, idem: 'r8earn', at: w.clock.t, bypassCaps: true });
  const ref = await accountRef(w.ctx, w.company, person);
  const bal = async () => (await w.db.first('SELECT balance FROM stub_account WHERE ref = ?', ref)).balance;
  const c = await proposePenalty(w.ctx, w.company, w.people.mgr, { person_id: person.id, effect: 'credits', amount: 100, reason: 'test' });
  await approvePenalty(w.ctx, w.company, w.people.hr, c.id);
  return { w, person, ref, bal, c };
}

test('M1a: two restores from the same apply generation use one key; the provider credits once', async () => {
  const { w, ref, bal, c } = await setup8();
  const keys = [];
  const real = w.ctx.provider(w.company);
  w.ctx.provider = () => wrap(real, { credit: async (x) => { keys.push(x.idem); return real.credit(x); } });
  await real.debit({ accountRef: ref, amount: 100, reasonCode: 'penalty', ref: c.id, idem: 'pen:' + c.id });
  assert.equal(await bal(), 900);
  await w.db.run("UPDATE penalty_case SET state='reversed', applied_credits=0 WHERE id=?", c.id);
  await restoreDebit(w.ctx, w.company, c.id, 100, 0); // winner of the restore
  await restoreDebit(w.ctx, w.company, c.id, 100, 0); // stale loser: same generation (read before the first restore existed)
  assert.equal(await bal(), 1000, 'exactly one restore');
  assert.ok(keys.every((k) => k === 'penrestore:' + c.id));
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM audit WHERE action='penalty.restore'")).n, 1);
});

test('M1b: a stale loser calling the provider with the same key credits nothing more', async () => {
  const { w, ref, bal, c } = await setup8();
  const real = w.ctx.provider(w.company);
  await real.debit({ accountRef: ref, amount: 100, reasonCode: 'penalty', ref: c.id, idem: 'pen:' + c.id });
  const k = 'penrestore:' + c.id;
  await real.credit({ accountRef: ref, amount: 100, reasonCode: 'penalty_restore', ref: c.id, idem: k });
  await real.credit({ accountRef: ref, amount: 100, reasonCode: 'penalty_restore', ref: c.id, idem: k });
  assert.equal(await bal(), 1000);
});

test('M1c: L4 sequence (debit, appeal, restore, upheld, debit) still re-debits for real', async () => {
  const { w, person, bal, c } = await setup8();
  w.clock.t += 4 * DAY;
  const orig = w.db.batch.bind(w.db);
  let done = false;
  w.db.batch = async (stmts) => { if (!done && stmts.some(([sql]) => /penalty_case SET state='applied'/.test(sql))) { done = true; await appealPenalty(w.ctx, w.company, person, c.id); } return orig(stmts); };
  await tickPenalties(w.ctx, w.company);
  w.db.batch = orig;
  assert.equal(await bal(), 1000, 'first debit handed back');
  await decideAppeal(w.ctx, w.company, w.people.hr, c.id, false, 'stays');
  assert.equal(await bal(), 900, 'second debit is real');
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM stub_entry WHERE kind LIKE 'debit:penalty%'")).n, 2);
});
