// The game: dice on the server, bonus range, board moves, desks, fees from the pool, notes, lane, fresh start; penalties and appeals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, exampleCard, SYSTEM, T0 } from './helpers.js';
import { submitEvent, approveEvent } from '../src/events.js';
import { die, bonusPct, getBoard, claimDesk, upgradeDesk, resetBoard, fundPool, offerSwap, answerSwap, ensureBoard } from '../src/board.js';
import * as setup from '../src/setup.js';
import { proposePenalty, approvePenalty, appealPenalty, decideAppeal, tickPenalties } from '../src/penalty.js';
import { SQUARES } from '../src/config.js';
import { DAY } from '../src/util.js';

const earned = (w, who) => w.db.first("SELECT COALESCE(SUM(amount),0) s FROM reward WHERE person_id = ? AND state IN ('queued','sent','recorded')", w.people[who].id).then((r) => r.s);
const game = (w, who, ext, extra = {}) => submitEvent(w.ctx, w.company, SYSTEM, { person_id: w.people[who].id, event_type: 'game', stage: 'completed', ext_id: ext, source: 'api', occurred_at: w.clock.t, ...extra });

test('our ring: 24 squares, 6 zones of 4, only our own square words', () => {
  assert.equal(SQUARES.length, 24);
  assert.equal(new Set(SQUARES.map((s) => s.zone)).size, 6);
  assert.deepEqual(SQUARES.reduce((m, s) => ({ ...m, [s.type]: (m[s.type] ?? 0) + 1 }), {}), { start: 1, desk: 12, note: 5, hub: 3, lane: 1, rest: 1, landmark: 1 });
});
test('steady mode: no random number at all; a move is what the card says', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  await w.db.run("UPDATE rate_card SET moves = 3 WHERE event_type = 'game' AND stage = 'completed'");
  await game(w, 'a', 's1');
  const b = await getBoard(w.ctx, w.company, w.people.a.id);
  assert.equal(b.position, 3); assert.deepEqual(b.moves[0].dice, []);
});
test('dice mode: server-made, same event gives the same roll, base reward never changes, bonus stays inside [floor, max]', async () => {
  const run = async (mkSecret) => {
    const w = await world({ mode: 'dice', settings: { daily_event_limit: 1000, bonus_floor_pct: 10, bonus_max_pct: 50 } }); await exampleCard(w);
    const out = [];
    for (let i = 0; i < 12; i++) await game(w, 'a', 'd' + i);
    const rows = await w.db.all("SELECT kind, amount, event_id FROM reward WHERE person_id = ? ORDER BY created_at, rowid", w.people.a.id);
    return { rows, w };
  };
  const { rows } = await run();
  const base = rows.filter((r) => r.kind === 'event'), bonus = rows.filter((r) => r.kind === 'bonus_roll');
  assert.ok(base.every((r) => r.amount === 40), 'the base for the same work is always 40');
  assert.ok(bonus.length > 0);
  for (const b of bonus) assert.ok(b.amount >= 4 && b.amount <= 20, `bonus ${b.amount} is inside 10%..50% of 40`);
  assert.equal(bonusPct(10, 50, 1), 10); assert.equal(bonusPct(10, 50, 6), 50);
  for (let d = 1; d <= 6; d++) assert.ok(bonusPct(10, 50, d) >= 10);
  // the same person and event id always roll the same
  const w2 = await world({ mode: 'dice' });
  assert.equal(await die(w2.ctx, 'u_x', 'ev_1', 0), await die(w2.ctx, 'u_x', 'ev_1', 0));
  const seen = new Set(); for (let i = 0; i < 60; i++) seen.add(await die(w2.ctx, 'u_x', 'ev_' + i, 0));
  assert.deepEqual([...seen].sort(), [1, 2, 3, 4, 5, 6]);
});
test('dice mode funds the whole range in advance (hold at the top of the range) and a floor under 10 percent is refused', async () => {
  const w = await world({ mode: 'dice', budget: 1000 });
  const h = await w.db.first('SELECT hold_id FROM season WHERE id = ?', w.season);
  const hold = await w.db.first('SELECT amount FROM stub_hold WHERE id = ?', h.hold_id);
  assert.equal(hold.amount, 1500);
  const { updateSettings } = await import('../src/people.js');
  await assert.rejects(updateSettings(w.ctx, w.company, w.admin, { bonus_floor_pct: 5 }), /never below 10/);
});
test('dice mode: lap and note credits are not paid for position, only fixed targets pay', async () => {
  const w = await world({ mode: 'dice', settings: { daily_event_limit: 1000, lap_bonus_credits: 500, cards_on: true } }); await exampleCard(w);
  await setup.addNoteCard(w.ctx, w.company, w.admin, { text: 'Thanks!', effect: 'credits', amount: 300 });
  for (let i = 0; i < 40; i++) await game(w, 'a', 'p' + i);
  assert.equal((await w.db.first("SELECT COUNT(*) n FROM reward WHERE kind IN ('lap','note')")).n, 0);
});
test('steady mode: a lap pays the fixed lap credit and board points; levels rise with laps', async () => {
  const w = await world({ settings: { daily_event_limit: 1000, lap_bonus_credits: 100, lap_points: 200 } }); await exampleCard(w);
  await w.db.run("UPDATE rate_card SET moves = 24 WHERE event_type = 'game' AND stage = 'completed'");
  await game(w, 'a', 'l1');
  const b = await getBoard(w.ctx, w.company, w.people.a.id);
  assert.equal(b.laps, 1); assert.equal(b.points, 1200); assert.equal(b.position, 0);
  assert.equal(await earned(w, 'a'), 140);
  for (let i = 2; i <= 3; i++) await game(w, 'a', 'l' + i);
  assert.equal((await getBoard(w.ctx, w.company, w.people.a.id)).level, 2);
});
test('surprise notes: company text only, never a loss, off until switched on', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  await assert.rejects(setup.addNoteCard(w.ctx, w.company, w.admin, { text: 'x', effect: 'points', amount: -5 }), /whole number/);
  await assert.rejects(setup.addNoteCard(w.ctx, w.company, w.admin, { text: 'x', effect: 'fine', amount: 5 }), /can only give/);
  await setup.addNoteCard(w.ctx, w.company, w.admin, { text: 'A kind word from the team', effect: 'points', amount: 50 });
  await w.db.run("UPDATE rate_card SET moves = 3 WHERE event_type = 'game' AND stage = 'completed'");
  await game(w, 'a', 'n1'); // lands on square 3 = note, but cards are off
  assert.equal((await getBoard(w.ctx, w.company, w.people.a.id)).points, 1000);
  const w2 = await world({ settings: { daily_event_limit: 1000, cards_on: true } }); await exampleCard(w2);
  await setup.addNoteCard(w2.ctx, w2.company, w2.admin, { text: 'A kind word from the team', effect: 'points', amount: 50 });
  await w2.db.run("UPDATE rate_card SET moves = 3 WHERE event_type = 'game' AND stage = 'completed'");
  await game(w2, 'a', 'n1');
  assert.equal((await getBoard(w2.ctx, w2.company, w2.people.a.id)).points, 1050);
});
test('desks: claim needs the token on it, the target met, and enough board points; upgrade needs repeat achievement', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  const { ctx, company, admin } = w, a = w.people.a;
  const t = await setup.addTarget(ctx, company, admin, { name: 'Games', scope: 'person', period: 'week', event_type: 'game', stage: 'completed', tiers: [{ count: 2, bonus: 10 }] });
  const d = await setup.addDesk(ctx, company, admin, { square_idx: 1, name: 'Window Desk', target_id: t.id, price_points: 300 });
  await assert.rejects(claimDesk(ctx, company, a, d.id), /on this desk/);
  await game(w, 'a', 'k1');
  await assert.rejects(claimDesk(ctx, company, a, d.id), /target has not been met/);
  // move away and back: 24 steps is a lap, so use moves 1 then 24
  await game(w, 'a', 'k2'); // now on square 2
  await w.db.run("UPDATE board_state SET position = 1 WHERE person_id = ?", a.id);
  const b = await claimDesk(ctx, company, a, d.id);
  assert.equal(b.points, 700); assert.ok(b.desks.find((x) => x.id === d.id).owned);
  await assert.rejects(claimDesk(ctx, company, a, d.id), /already hold/);
  await assert.rejects(upgradeDesk(ctx, company, a, d.id), /Hit the target in 2 periods/);
});
test('visit fee: a teammate landing on your desk pays you from the company pool, never from their own points', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  const { ctx, company, admin } = w, a = w.people.a, b = w.people.b;
  const d = await setup.addDesk(ctx, company, admin, { square_idx: 1, name: 'Window Desk', price_points: 100, base_fee: 30 });
  await ensureBoard(ctx, company, a.id);
  await w.db.run("UPDATE board_state SET position = 1 WHERE person_id = ?", a.id);
  await claimDesk(ctx, company, a, d.id);
  await fundPool(ctx, company, w.team, 100, admin.id);
  const before = (await getBoard(ctx, company, b.id)).points;
  await game(w, 'b', 'v1'); // 1 move: square 1
  assert.equal((await getBoard(ctx, company, b.id)).points, before, 'the visitor pays nothing');
  assert.equal((await getBoard(ctx, company, a.id)).points, 900 + 30, 'the owner is thanked from the pool');
  assert.equal((await w.db.first('SELECT points FROM pool WHERE team_id = ?', w.team)).points, 70);
});
test('swaps are inside a team and never carry credits', async () => {
  const w = await world(); const { ctx, company } = w;
  const { user } = await (await import('../src/people.js')).addPerson(ctx, company, w.admin, { email: 'q@acme.test', name: 'q' });
  await assert.rejects(offerSwap(ctx, company, w.people.a, { toPersonId: user.id }), /teammates/);
  const o = await offerSwap(ctx, company, w.people.a, { toPersonId: w.people.b.id, helpText: 'I cover your handover' });
  assert.equal((await answerSwap(ctx, company, w.people.b, o.id, true)).state, 'accepted');
  assert.equal(await earned(w, 'a'), 0); assert.equal(await earned(w, 'b'), 0);
});
test('fresh start (board reset): points back, desks released, earned credits stay, no pay or job effect', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  await game(w, 'a', 'f1');
  const e1 = await earned(w, 'a');
  const b = await resetBoard(w.ctx, w.company, w.people.a.id);
  assert.equal(b.points, 1000); assert.equal(b.position, 0); assert.equal(b.resets, 1);
  assert.equal(await earned(w, 'a'), e1);
  assert.equal((await w.ctx.provider(w.company).getBalance({ accountRef: 'acct_' + w.people.a.id })).balance, e1);
});

// ---------- penalties ----------
const mkCase = async (w, effect = 'steps_back', amount = 2) => {
  const c = await proposePenalty(w.ctx, w.company, w.people.mgr, { person_id: w.people.a.id, effect, amount, reason: 'Late report' });
  return c.id;
};
test('penalty flow: manager proposes, HR approves, 3 days notice, then applied as board steps only', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  await w.db.run("UPDATE rate_card SET moves = 5 WHERE event_type = 'game'");
  await game(w, 'a', 'p1');
  const id = await mkCase(w);
  await assert.rejects(approvePenalty(w.ctx, w.company, w.people.mgr, id), /HR or the company admin/);
  await approvePenalty(w.ctx, w.company, w.people.hr, id);
  await tickPenalties(w.ctx, w.company);
  assert.equal((await getBoard(w.ctx, w.company, w.people.a.id)).position, 5, 'nothing during the notice');
  w.clock.t += 3 * DAY + 1;
  await tickPenalties(w.ctx, w.company);
  assert.equal((await getBoard(w.ctx, w.company, w.people.a.id)).position, 3);
  assert.equal(await earned(w, 'a'), 40, 'credits untouched by a board-only penalty');
});
test('no notice, no penalty: the person must have acknowledged the rules first', async () => {
  const w = await world();
  await w.db.run("DELETE FROM consent WHERE user_id = ? AND kind = 'penalty_rules'", w.people.a.id);
  await assert.rejects(mkCase(w), /not acknowledged/);
});
test('credit-loss penalties are off by default and need provider support; when on they are capped and never below zero', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  await assert.rejects(mkCase(w, 'credits', 100), /switched off/);
  const { updateSettings } = await import('../src/people.js');
  await updateSettings(w.ctx, w.company, w.admin, { penalty_credit_loss: true, penalty_cap_pct: 20 });
  await w.reload();
  for (let i = 0; i < 5; i++) await game(w, 'a', 'c' + i); // 200 credits + bonus none (steady)
  assert.equal(await earned(w, 'a'), 200);
  const id = await mkCase(w, 'credits', 1000);
  await approvePenalty(w.ctx, w.company, w.people.hr, id);
  w.clock.t += 4 * DAY; await tickPenalties(w.ctx, w.company);
  const c = await w.db.first('SELECT applied_credits, state FROM penalty_case WHERE id = ?', id);
  assert.equal(c.state, 'applied'); assert.equal(c.applied_credits, 40, '20% of 200 earned this month, not 1000');
  assert.equal((await w.ctx.provider(w.company).getBalance({ accountRef: 'acct_' + w.people.a.id })).balance, 160);
});
test('appeal: reviewer is not the proposer; silence reverses in the person\'s favour after 11 days; won appeal gives everything back', async () => {
  const w = await world({ settings: { daily_event_limit: 1000 } }); await exampleCard(w);
  await w.db.run("UPDATE rate_card SET moves = 5 WHERE event_type = 'game'");
  await game(w, 'a', 'x1');
  let id = await mkCase(w);
  await approvePenalty(w.ctx, w.company, w.people.hr, id);
  w.clock.t += 4 * DAY; await tickPenalties(w.ctx, w.company);
  assert.equal((await getBoard(w.ctx, w.company, w.people.a.id)).position, 3);
  await appealPenalty(w.ctx, w.company, w.people.a, id);
  await assert.rejects(decideAppeal(w.ctx, w.company, w.people.mgr, id, true), /proposer/);
  w.clock.t += 3 * DAY + 1; await tickPenalties(w.ctx, w.company); // level 2 now
  await assert.rejects(decideAppeal(w.ctx, w.company, (await w.db.first('SELECT * FROM app_user WHERE id = ?', w.people.mgr.id)), id, true), /proposer|different reviewer/);
  w.clock.t += 8 * DAY + 2; await tickPenalties(w.ctx, w.company);
  assert.equal((await w.db.first('SELECT state FROM penalty_case WHERE id = ?', id)).state, 'reversed', 'no decision in 11 days');
  assert.equal((await getBoard(w.ctx, w.company, w.people.a.id)).position, 5, 'steps given back');
  // appeal outside the 7 days is refused
  const id2 = await mkCase(w); await approvePenalty(w.ctx, w.company, w.people.hr, id2);
  w.clock.t += 8 * DAY; await tickPenalties(w.ctx, w.company);
  await assert.rejects(appealPenalty(w.ctx, w.company, w.people.a, id2), /window is over/);
  // a decision for the person
  const id3 = await mkCase(w); await approvePenalty(w.ctx, w.company, w.people.hr, id3);
  await appealPenalty(w.ctx, w.company, w.people.a, id3);
  const r = await decideAppeal(w.ctx, w.company, w.people.hr, id3, true, 'Evidence was wrong');
  assert.equal(r.state, 'reversed');
});
test('no code path touches pay: no salary, payroll, wage or deduction names anywhere in src', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const files = readdirSync('src', { recursive: true }).filter((f) => String(f).endsWith('.js'));
  for (const f of files) {
    const txt = readFileSync('src/' + f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, '');
    assert.ok(!/\b(salary|payroll|wages?|deduct\w*)\b/i.test(txt), `${f} must not name pay`);
  }
});
