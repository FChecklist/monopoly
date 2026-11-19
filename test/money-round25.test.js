// Round-25: overlapping settles can never pay from a stale figure. The cash grant and the net are guarded INSERTs on the group's counted total; a stale run inserts nothing, reads again, and the group
// ends at exactly the entitlement for every interleaving (concurrent, and hostile step-by-step).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitEvent } from '../src/events.js';
import { reissueReward, ledgerLine } from '../src/rewards.js';
import { settleEntitlement } from '../src/periods.js';
import * as setup from '../src/setup.js';
import { mworld } from './mnpfake.js';

const DAY = 86400_000, A = 'a@acme.test', NOTE = 'ledger checked 14 Nov, credit not there', SYSTEM = { id: 'api', role: 'system' };
let n = 0;
const settle = (w, kind, e) => settleEntitlement(w.ctx, w.company, { person: w.people.a, kind, groupKey: kind + ':t1:W1', periodKey: 'W1', entitled: e, at: w.clock.t, label: 'x' });
async function evReward(w, credits = 80) {
  if (!w.cardDone) { await setup.addRateCard(w.ctx, w.company, w.admin, { active_from: 1, event_type: 'lead', stage: 'converted', stage_no: 3, credits, cap_month: 0, state_needed: 'system' }); w.cardDone = true; }
  const e = await submitEvent(w.ctx, w.company, SYSTEM, { source: 'api', event_type: 'lead', stage: 'converted', ext_id: 'r25-' + (++n), person_id: w.people.a.id, occurred_at: w.clock.t });
  return w.db.first('SELECT * FROM reward WHERE event_id = ?', e.id);
}
const open = async (w) => (await w.db.first("SELECT COALESCE(SUM(amount - recovered),0) s FROM correction WHERE state = 'open'")).s;
const counted = async (w, kind) => (await w.db.first("SELECT COALESCE(SUM(amount),0) s FROM reward WHERE group_key = ? AND state IN ('queued','sent','waiting','recorded')", kind + ':t1:W1')).s;

for (const kind of ['tier', 'team', 'streak']) {
  test(`Y1 ${kind}: 60 -> 20 -> 60 with two and three settles at the same time pay nothing twice (provider total stays 60)`, async () => {
    for (const par of [2, 3]) {
      const w = await mworld({ lifetime: 800 });
      await settle(w, kind, 60); w.clock.t += DAY; await settle(w, kind, 20); assert.equal(await open(w), 40);
      w.clock.t += DAY; await Promise.all(Array.from({ length: par }, () => settle(w, kind, 60)));
      assert.equal(w.f.total(A), 60, par + ' at once'); assert.equal(await open(w), 0); assert.equal(await counted(w, kind), 60);
      await settle(w, kind, 60); assert.equal(w.f.total(A), 60);
    }
  });
}

test('Y2 with an offset (a correction partly recovered by another reward): concurrent rises pay the missing cash once; gross - recovered <= entitlement', async () => {
  const w = await mworld({ lifetime: 800 });
  await settle(w, 'tier', 60); w.clock.t += DAY; await settle(w, 'tier', 20);
  await evReward(w, 40); const recovered = (await w.db.first('SELECT SUM(recovered) s FROM correction')).s; assert.ok(recovered > 0 && recovered < 40);
  const before = w.f.total(A);
  w.clock.t += DAY; await Promise.all([settle(w, 'tier', 60), settle(w, 'tier', 60), settle(w, 'tier', 60)]);
  const gross = (await w.db.first("SELECT COALESCE(SUM(sent_amount),0) s FROM reward WHERE group_key = 'tier:t1:W1' AND kind = 'tier'")).s;
  assert.ok(gross - recovered <= 60, `gross ${gross} recovered ${recovered}`); assert.equal(await counted(w, 'tier'), 60);
  assert.ok(w.f.total(A) - before <= 40 - recovered + 0, 'only the cash for the part that was withheld');
  const again = w.f.total(A); await settle(w, 'tier', 60); assert.equal(w.f.total(A), again);
});

test('Y3 hostile interleave: run A reads, a full run B settles, then run A goes on: A inserts nothing from its old figure, and the retry leaves exactly 60', async () => {
  const w = await mworld({ lifetime: 800 });
  await settle(w, 'tier', 60); w.clock.t += DAY; await settle(w, 'tier', 20); w.clock.t += DAY;
  const realAll = w.ctx.db.all.bind(w.ctx.db); let armed = true, ran = 0;
  w.ctx.db.all = async (sql, ...p) => { // A has read the group's paid figure and now asks for its delta rows: B runs completely here
    if (armed && /idem_key LIKE 'dn:%'/.test(sql) && /ORDER BY/.test(sql)) { armed = false; ran++; await settle(w, 'tier', 60); assert.equal(w.f.total(A), 60, 'B alone: 60'); }
    return realAll(sql, ...p);
  };
  const out = await settle(w, 'tier', 60);
  assert.equal(ran, 1); assert.equal(w.f.total(A), 60, 'A did not pay from its stale figure'); assert.equal(await counted(w, 'tier'), 60); assert.equal(await open(w), 0); assert.ok(out);
});

test('Y4 hostile interleave at the cash grant: B settles completely between A computing its amount and A inserting; the guard refuses A and the group ends at the entitlement', async () => {
  const w = await mworld({ lifetime: 800 });
  await settle(w, 'tier', 20); w.clock.t += DAY; // a plain rise 20 -> 60 (no correction): 40 in cash, by whoever is first
  const realFirst = w.ctx.db.first.bind(w.ctx.db); let armed = true;
  w.ctx.db.first = async (sql, ...p) => { // the first look at the idempotency key of the new grant is the moment A has decided what to pay
    if (armed && /SELECT \* FROM reward WHERE idem_key = \?/.test(sql) && /:p20/.test(String(p[0]))) { armed = false; await w.db.run("INSERT INTO reward (id, company_id, person_id, kind, group_key, idem_key, amount, state, reversed, created_at, sent_amount) VALUES ('rw_other', ?, ?, 'tier', 'tier:t1:W1', 'other-run', 15, 'sent', 0, ?, 15)", w.company.id, w.people.a.id, w.clock.t); }
    return realFirst(sql, ...p);
  };
  await settle(w, 'tier', 60); w.ctx.db.first = realFirst;
  assert.ok(await counted(w, 'tier') <= 60, 'never above the entitlement: ' + await counted(w, 'tier'));
  await settle(w, 'tier', 60); assert.equal(await counted(w, 'tier'), 60);
});

test('Y5 a busy audit chain while netting stops that group for this run: no cash payment follows; the next run nets and the total stays 60', async () => {
  const w = await mworld({ lifetime: 800 });
  await settle(w, 'tier', 60); w.clock.t += DAY; await settle(w, 'tier', 20); w.clock.t += DAY;
  const real = w.ctx.db.batch.bind(w.ctx.db); let on = true;
  w.ctx.db.batch = async (s) => { if (on && JSON.stringify(s).includes('rise_netted')) throw new Error('UNIQUE constraint failed: audit.company_id, audit.n'); return real(s); };
  const o = await settle(w, 'tier', 60); assert.equal(o.skipCode, 'busy'); assert.equal(w.f.total(A), 60, 'no cash on a failed net');
  on = false; await settle(w, 'tier', 60); assert.equal(w.f.total(A), 60); assert.equal(await open(w), 0);
});

test('Y6 a net is never larger than the rise: the group is read again, a correction shrinks by at most entitled - counted', async () => {
  const w = await mworld({ lifetime: 800 });
  await settle(w, 'tier', 60); w.clock.t += DAY; await settle(w, 'tier', 20); // correction 40
  w.clock.t += DAY; await settle(w, 'tier', 35); assert.equal(await open(w), 25); assert.equal(await counted(w, 'tier'), 35);
  w.clock.t += DAY; await Promise.all([settle(w, 'tier', 35), settle(w, 'tier', 35)]); assert.equal(await open(w), 25); assert.equal(w.f.total(A), 60);
});

test('Y7 the re-issue amount: absent = the whole rest, present but null is 400 bad_amount; the ledger look-up reads up to 20 pages', async () => {
  const w = await mworld({ lifetime: 0 });
  const old = await evReward(w); w.f.lifetime = 800;
  await assert.rejects(reissueReward(w.ctx, w.company, 'admin', { id: old.id, confirm: true, note: NOTE, amount: null }), (e) => e.code === 'bad_amount');
  assert.equal(w.f.total(A), 0);
  const ok = await reissueReward(w.ctx, w.company, 'admin', { id: old.id, confirm: true, note: NOTE }); assert.equal(ok.state, 'sent');
  const ctx = { provider: () => ({ history: async ({ beforeSeq }) => { const pg = beforeSeq == null ? 1 : beforeSeq; return { lines: pg === 15 ? [{ ref: 'manual:rw_x' }] : [{ ref: 'other' }], next_before_seq: pg + 1 }; } }) };
  assert.ok((await ledgerLine(ctx, {}, 'a@acme.test', 'rw_x')).line, 'found on page 15');
});
