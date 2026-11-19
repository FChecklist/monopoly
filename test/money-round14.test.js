// Round-14: ONE outbound provider operation state machine (src/provider-ops.js). Each test runs TWO workers at once (Promise.all) against a provider whose
// reply is lost (the call lands, the caller sees a timeout) or whose "no" comes before anything landed, and pins that no money is lost, doubled or mis-booked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './helpers.js';
import { settleEntitlement } from '../src/periods.js';
import { accountRef, retryQueued, releasePendingHolds, reverseReward, openReversesFailed, sendReward } from '../src/rewards.js';
import { ProviderError } from '../src/provider/errors.js';
import { proposePenalty, approvePenalty, tickPenalties, restoreDebit, openDebitsFailed } from '../src/penalty.js';
import { retryOps } from '../src/provider-ops.js';
import * as setup from '../src/setup.js';

const DAY = 86400_000;
const wrap = (real, over) => new Proxy(real, { get: (t, k) => (k in over ? over[k] : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
const gap = () => new Promise((r) => setTimeout(r, 8)); // lets the other worker reach its own claim while this call is "in flight"
const entitle = (w, e, gk = 'tier:t1:W1', person = 'a') => settleEntitlement(w.ctx, w.company, { person: w.people[person], kind: 'tier', groupKey: gk, periodKey: 'W1', entitled: e, at: w.clock.t, label: 'x' });
const provBal = async (w, person = 'a') => (await w.db.first('SELECT balance FROM stub_account WHERE ref=?', await accountRef(w.ctx, w.company, w.people[person]))).balance;
const auditN = (w, action) => w.db.first('SELECT COUNT(*) n FROM audit WHERE action=?', action).then((r) => r.n);
const ops = (w, kind) => w.db.all('SELECT state, tries, settled FROM provider_op WHERE kind=? ORDER BY rowid', kind);
const later = (w) => { w.clock.t += 120_000; }; // past the 60 s lease of a worker that died or lost its answer

async function penaltyWorld() {
  const w = await world({ settings: { penalty_credit_loss: true } });
  await entitle(w, 100);
  const c = await proposePenalty(w.ctx, w.company, w.admin, { person_id: w.people.a.id, effect: 'credits', amount: 20, reason: 'r' });
  await approvePenalty(w.ctx, w.company, w.people.hr, c.id);
  w.clock.t += 4 * DAY;
  return { w, c, real: w.ctx.provider(w.company) };
}

test('V1 debit: two workers, the debit lands and its reply is lost: one call, the case is recorded with the debit by the replay', async () => {
  const { w, c, real } = await penaltyWorld(); let n = 0;
  w.ctx.provider = () => wrap(real, { debit: async (x) => { n++; if (n === 1) { await gap(); await real.debit(x); throw new ProviderError('timeout'); } return real.debit(x); } });
  await Promise.all([tickPenalties(w.ctx, w.company), tickPenalties(w.ctx, w.company)]);
  assert.equal(n, 1, 'the overlapping worker did not call the provider for the same key');
  assert.equal((await w.db.first('SELECT applied_at a FROM penalty_case WHERE id=?', c.id)).a, null, 'not applied with 0 while the debit may have landed');
  later(w); await tickPenalties(w.ctx, w.company);
  const row = await w.db.first('SELECT state, applied_credits ac FROM penalty_case WHERE id=?', c.id);
  assert.equal(row.state, 'applied'); assert.equal(row.ac, 20);
  assert.equal(await provBal(w), 80, 'debited exactly once');
  assert.equal((await ops(w, 'debit'))[0].settled, 1);
});

test('V2 debit: a first clean refusal (before anything landed) is believed: applied with 0, nothing taken, one call', async () => {
  const { w, c, real } = await penaltyWorld(); let n = 0;
  w.ctx.provider = () => wrap(real, { debit: async () => { n++; await gap(); throw new ProviderError('account_closed'); } });
  await Promise.all([tickPenalties(w.ctx, w.company), tickPenalties(w.ctx, w.company)]);
  assert.equal(n, 1);
  const row = await w.db.first('SELECT state, applied_credits ac FROM penalty_case WHERE id=?', c.id);
  assert.equal(row.state, 'applied'); assert.equal(row.ac, 0);
  assert.equal(await provBal(w), 100);
});

test('V3 debit: lost reply, then a definitive "no" on the replay is NOT believed; the next replay learns the truth', async () => {
  const { w, c, real } = await penaltyWorld(); let n = 0;
  w.ctx.provider = () => wrap(real, { debit: async (x) => { n++; if (n === 1) { await real.debit(x); throw new ProviderError('timeout'); } if (n === 2) throw new ProviderError('account_closed'); return real.debit(x); } });
  for (let i = 0; i < 4; i++) { await Promise.all([tickPenalties(w.ctx, w.company), tickPenalties(w.ctx, w.company)]); later(w); }
  const row = await w.db.first('SELECT state, applied_credits ac FROM penalty_case WHERE id=?', c.id);
  assert.equal(row.ac, 20, 'the debit that landed is recorded');
  assert.equal(await provBal(w), 80);
});

test('V4 debit: the case was applied with 0 by a worker that did not know; the tick replays the same debit and hands it back (once)', async () => {
  const { w, c, real } = await penaltyWorld();
  await real.debit({ accountRef: await accountRef(w.ctx, w.company, w.people.a), amount: 20, reasonCode: 'penalty', ref: c.id, idem: 'pen:' + c.id, monthlyCap: 100 });
  await w.db.run("INSERT INTO provider_op (id, company_id, kind, key, subject, params, state, tries, budget, settled, claim_until, created_at, updated_at) VALUES ('po_t', ?, 'debit', ?, ?, ?, 'intended', 1, 5, 0, 0, 1, 1)", w.company.id, 'pen:' + c.id, c.id, JSON.stringify({ ask: 20, room: 100, gen: 0 }));
  await w.db.run("UPDATE penalty_case SET state='applied', applied_at=?, applied_credits=0 WHERE id=?", w.clock.t, c.id);
  assert.equal(await provBal(w), 80);
  for (let i = 0; i < 3; i++) { await Promise.all([tickPenalties(w.ctx, w.company), tickPenalties(w.ctx, w.company)]); later(w); }
  assert.equal(await provBal(w), 100, 'handed back exactly once');
  assert.equal(await auditN(w, 'penalty.restore'), 1);
});

test('V5 reverse: two workers, the reverse lands and its reply is lost: one call, then the replay completes it; no owed correction', async () => {
  const w = await world(); const real = w.ctx.provider(w.company); let n = 0;
  await entitle(w, 100);
  w.ctx.provider = () => wrap(real, { reverse: async (x) => { n++; if (n === 1) { await gap(); await real.reverse(x); throw new ProviderError('timeout'); } return real.reverse(x); } });
  await Promise.allSettled([entitle(w, 0), entitle(w, 0)]);
  assert.equal(n, 1);
  later(w); await entitle(w, 0);
  assert.equal(await provBal(w), 0, 'reversed exactly once');
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM reward WHERE note LIKE '%\"owed\":100%'")).n, 0, 'no owed correction booked');
  assert.equal((await ops(w, 'reverse'))[0].settled, 1);
});

test('V6 reverse: lost reply, then a definitive "no" on the replay is not believed (no REV_SPLIT underpay)', async () => {
  const w = await world(); const real = w.ctx.provider(w.company); let n = 0;
  await entitle(w, 100);
  w.ctx.provider = () => wrap(real, { reverse: async (x) => { n++; if (n === 1) { await real.reverse(x); throw new ProviderError('timeout'); } if (n === 2) throw new ProviderError('account_closed'); return real.reverse(x); } });
  for (let i = 0; i < 4; i++) { await Promise.allSettled([entitle(w, 0), entitle(w, 0)]); later(w); }
  assert.equal(await provBal(w), 0);
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM reward WHERE note LIKE '%\"owed\":100%'")).n, 0);
});

test('V7 reverse: a first clean refusal is believed: the whole credit is owed, one call', async () => {
  const w = await world(); const real = w.ctx.provider(w.company); let n = 0;
  await entitle(w, 100);
  w.ctx.provider = () => wrap(real, { reverse: async () => { n++; await gap(); throw new ProviderError('account_closed'); } });
  await Promise.allSettled([entitle(w, 0), entitle(w, 0)]);
  assert.equal(n, 1);
  assert.equal(await provBal(w), 100, 'nothing was reversed');
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM reward WHERE note LIKE '%\"owed\":100%'")).n, 1, 'owed once');
});

test('V8 restore: two workers, the credit lands and its reply is lost: one call, then the tick confirms it once', async () => {
  const { w, c, real } = await penaltyWorld(); let n = 0;
  const ref = await accountRef(w.ctx, w.company, w.people.a);
  await real.debit({ accountRef: ref, amount: 100, reasonCode: 'penalty', ref: c.id, idem: 'x:' + c.id });
  const before = await provBal(w);
  await w.db.run("UPDATE penalty_case SET state='reversed', applied_credits=0 WHERE id=?", c.id);
  w.ctx.provider = () => wrap(real, { credit: async (x) => { n++; if (n === 1) { await gap(); await real.credit(x); throw new ProviderError('timeout'); } if (n === 2) throw new ProviderError('account_closed'); return real.credit(x); } });
  await Promise.all([restoreDebit(w.ctx, w.company, c.id, 100, 0), restoreDebit(w.ctx, w.company, c.id, 100, 0)]);
  assert.equal(n, 1);
  for (let i = 0; i < 4; i++) { later(w); await tickPenalties(w.ctx, w.company); }
  assert.equal(await provBal(w), before + 100, 'credited once; a refusal after a lost reply is not believed');
  assert.equal(await auditN(w, 'penalty.restore'), 1);
});

test('V9 hold reserve: a reserve whose reply was lost is found by the tick (same key) and released when it is not the season hold', async () => {
  const w = await world({ budget: 1000 }); const real = w.ctx.provider(w.company); let n = 0;
  const live = (await w.db.first('SELECT hold_id h FROM season WHERE id=?', w.season)).h;
  w.ctx.provider = () => wrap(real, { reserveBudget: async (x) => { n++; if (n === 1) { await real.reserveBudget(x); throw new ProviderError('timeout'); } return real.reserveBudget(x); } });
  await assert.rejects(setup.raiseBudget(w.ctx, w.company, w.admin, w.season, 2000));
  assert.equal((await w.db.first('SELECT hold_id h FROM season WHERE id=?', w.season)).h, live, 'the season keeps its hold');
  w.clock.t += 11 * 60_000;
  await Promise.all([releasePendingHolds(w.ctx, w.company), releasePendingHolds(w.ctx, w.company)]);
  later(w); await releasePendingHolds(w.ctx, w.company);
  const open = await w.db.all("SELECT id, remaining r FROM stub_hold WHERE kind='budget' AND remaining > 0");
  assert.deepEqual(open.map((h) => h.id), [live], 'only the season hold is left');
  assert.equal(await auditN(w, 'season.hold_freed'), 1);
});

test('V10 hold release: two workers, the release lands and its reply is lost: released once, the line is written once', async () => {
  const w = await world({ budget: 1000 }); const real = w.ctx.provider(w.company); let n = 0;
  w.ctx.provider = () => wrap(real, { releaseHold: async (x) => { n++; if (n === 1) { await gap(); await real.releaseHold(x); throw new ProviderError('timeout'); } return real.releaseHold(x); } });
  await setup.raiseBudget(w.ctx, w.company, w.admin, w.season, 2000);
  assert.equal(await auditN(w, 'season.hold_freed'), 0);
  later(w);
  await Promise.all([retryQueued(w.ctx, w.company), retryQueued(w.ctx, w.company)]);
  later(w); await retryQueued(w.ctx, w.company);
  assert.equal(await auditN(w, 'season.hold_freed'), 1);
  const calls = n; later(w); await retryQueued(w.ctx, w.company);
  assert.equal(n, calls, 'nothing more is called once it is settled');
});

test('V11 order decision: a lost capture reply plus an opposite decision: the first decision stands, the other is refused, captured once', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); const real = w.ctx.provider(w.company);
  await entitle(w, 100);
  const it = await setup.addItem(w.ctx, w.company, w.admin, { name: 'Lunch', credits: 30 });
  const o = await setup.placeOrder(w.ctx, w.company, w.people.a, it.id);
  let caps = 0, rels = 0;
  w.ctx.provider = () => wrap(real, { captureSpend: async (x) => { caps++; if (caps === 1) { await gap(); await real.captureSpend(x); throw new ProviderError('timeout'); } return real.captureSpend(x); }, releaseSpend: async (x) => { rels++; return real.releaseSpend(x); } });
  const r = await Promise.allSettled([setup.decideOrder(w.ctx, w.company, w.admin, o.id, true), setup.decideOrder(w.ctx, w.company, w.admin, o.id, false)]);
  assert.ok(r.some((x) => x.status === 'rejected' && x.reason.status === 409), 'the opposite decision is refused');
  assert.equal(rels, 0, 'the provider was never asked to release');
  later(w); await setup.finishOrders(w.ctx, w.company);
  assert.equal((await w.db.first('SELECT state FROM catalogue_order WHERE id=?', o.id)).state, 'captured');
  assert.equal((await real.getBalance({ accountRef: await accountRef(w.ctx, w.company, w.people.a) })).balance, 70, 'charged once');
});

test('V12 an exhausted operation is surfaced and the admin retry gives it new tries (U3)', async () => {
  const w = await world(); const real = w.ctx.provider(w.company);
  await entitle(w, 100);
  let down = true;
  w.ctx.provider = () => wrap(real, { reverse: async (x) => { if (down) throw new ProviderError('provider_down'); return real.reverse(x); } });
  for (let i = 0; i < 8; i++) { later(w); await entitle(w, 0).catch(() => {}); }
  assert.equal(await openReversesFailed(w.ctx, w.company.id), 1, 'surfaced after the tries');
  const tries = (await ops(w, 'reverse'))[0].tries;
  later(w); await entitle(w, 0).catch(() => {});
  assert.equal((await ops(w, 'reverse'))[0].tries, tries, 'no more provider calls after the limit');
  down = false;
  assert.equal((await retryOps(w.ctx, w.company)).retried, 1);
  later(w); await entitle(w, 0);
  assert.equal(await provBal(w), 0);
  assert.equal(await openReversesFailed(w.ctx, w.company.id), 0);
});

test('V13 U4: a flapping error code writes at most one send_error line per row per day', async () => {
  const w = await world(); const real = w.ctx.provider(w.company);
  const codes = ['provider_down', 'timeout', 'rate_limited', 'provider_down'];
  let i = 0;
  w.ctx.provider = () => wrap(real, { credit: async () => { throw new ProviderError(codes[i++ % codes.length]); } });
  await entitle(w, 100).catch(() => {});
  for (let k = 0; k < 12; k++) { w.clock.t += 5 * 60_000; await retryQueued(w.ctx, w.company); }
  assert.ok((await auditN(w, 'reward.send_error')) <= 1, 'one line per row per day');
});

test('V14 U5: one row that throws does not stop the others in retryQueued', async () => {
  const w = await world(); const real = w.ctx.provider(w.company);
  let down = true;
  w.ctx.provider = () => wrap(real, { credit: async (x) => { if (down) throw new ProviderError('provider_down'); return real.credit(x); } });
  await entitle(w, 100, 'tier:a:W1', 'a').catch(() => {}); await entitle(w, 50, 'tier:b:W1', 'b').catch(() => {});
  down = false;
  const first = (await w.db.first("SELECT id FROM reward WHERE state='queued' ORDER BY rowid LIMIT 1")).id;
  w.ctx.provider = () => wrap(real, { credit: async (x) => { if (x.idem && String(x.idem).includes(first)) throw new Error('boom'); return real.credit(x); } });
  await w.db.run("UPDATE reward SET last_error=NULL");
  const out = await retryQueued(w.ctx, w.company);
  assert.ok(out.sent >= 1, 'the healthy row was sent although another one threw');
});

test('V15 U6: an order whose commit failed after the hold was reserved is found by the tick and the hold goes back', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); const real = w.ctx.provider(w.company);
  await entitle(w, 100);
  const it = await setup.addItem(w.ctx, w.company, w.admin, { name: 'Lunch', credits: 30 });
  const orig = w.db.batch.bind(w.db); let boom = true;
  w.db.batch = async (st) => { if (boom && st.some(([, ...p]) => p.includes('order.place'))) { boom = false; throw new Error('db gone'); } return orig(st); };
  await assert.rejects(setup.placeOrder(w.ctx, w.company, w.people.a, it.id));
  const spendable = async () => (await real.getBalance({ accountRef: await accountRef(w.ctx, w.company, w.people.a) })).spendable;
  assert.equal(await spendable(), 70, 'the hold is on the account');
  w.clock.t += 11 * 60_000; await setup.finishOrders(w.ctx, w.company);
  assert.equal(await spendable(), 100, 'the orphan hold went back');
  assert.equal((await ops(w, 'order_reserve'))[0].settled, 1);
});
