// The game: our own 24-square ring. Mechanics follow the classic race-and-own pattern; names, layout and art are ours.
// Board points are an in-game score. They are NOT credits and can never be converted to credits.
import { SQUARES, settingsOf, LEVEL_NAMES } from './config.js';
import { commit } from './audit.js';
import { newId, ApiError, hmacHex } from './util.js';
import { grant, seasonAt } from './rewards.js';
import { countFor, periodsHit } from './periods.js';

export const RING = SQUARES.length;

export async function ensureBoard(ctx, company, personId) {
  const s = settingsOf(company);
  await ctx.db.run('INSERT OR IGNORE INTO board_state (person_id, company_id, points, updated_at) VALUES (?,?,?,?)', personId, company.id, s.start_points, ctx.now());
  return ctx.db.first('SELECT * FROM board_state WHERE person_id = ? AND company_id = ?', personId, company.id);
}

/** A die made on the server from a secret and the event id: same event, same roll, shown to the person with its seed. */
export async function die(ctx, personId, eventId, n) {
  const h = await hmacHex(ctx.master, `dice:${personId}:${eventId}:${n}`);
  return (parseInt(h.slice(0, 8), 16) % 6) + 1;
}
/** Bonus size in percent of the base reward: always inside [floor, max], so the dice can never leave someone with nothing. */
export const bonusPct = (floor, max, d) => floor + Math.round(((max - floor) * (d - 1)) / 5);

const levelOf = (laps) => Math.min(LEVEL_NAMES.length, 1 + Math.floor(laps / 3));

/** Move a token for one approved event. Safe to repeat for the same event. */
export async function moveToken(ctx, company, { person, event, card, season }) {
  const s = settingsOf(company);
  const seen = await ctx.db.first('SELECT * FROM move_log WHERE event_id = ?', event.id);
  if (seen) return { replay: true, move: seen };
  const b = await ensureBoard(ctx, company, person.id);
  const effects = [];
  const dice = [];
  let steps = 0, pos = b.position, points = b.points, laps = b.laps, skip = b.skip_roll, lane = b.in_lane, noteCtr = b.note_ctr;
  const mode = season?.mode ?? s.mode;

  if (skip > 0) {
    skip -= 1; if (skip === 0) lane = 0;
    effects.push({ t: 'cooldown', text: 'Catch-up Lane: this event used your cooldown. You are back on the ring.' });
  } else if (mode === 'dice') {
    for (let i = 0; i < Math.max(1, card.rolls); i++) { const d = await die(ctx, person.id, event.id, i); dice.push(d); steps += d; }
  } else steps = Math.max(0, card.moves);

  const from = pos;
  const total = pos + steps;
  const lapsPassed = Math.floor(total / RING);
  pos = total % RING;
  for (let i = 0; i < lapsPassed; i++) {
    laps += 1; points += s.lap_points;
    effects.push({ t: 'lap', text: `Lap done. +${s.lap_points} board points.`, points: s.lap_points });
    // Steady mode may pay a fixed lap credit. In dice mode credits come only from tiers and targets, never from a position.
    if (mode === 'steady' && s.lap_bonus_credits > 0) {
      const g = await grant(ctx, company, { person, kind: 'lap', amount: s.lap_bonus_credits, idem: `lap:${person.id}:${event.id}:${i}`, groupKey: 'lap', at: event.occurred_at, eventId: event.id, periodBonus: false, actor: 'system' });
      effects.push({ t: 'lap_credits', credits: g.paid });
    }
  }
  if (steps > 0) {
    const sq = SQUARES[pos];
    effects.push({ t: 'land', square: sq.name, type: sq.type });
    if (sq.type === 'note' && s.cards_on) {
      const cards = await ctx.db.all("SELECT * FROM note_card WHERE company_id = ? AND kind = 'note' ORDER BY order_no, id", company.id);
      if (cards.length) {
        const c = cards[noteCtr % cards.length]; noteCtr += 1;
        effects.push({ t: 'note', text: c.text, effect: c.effect, amount: c.amount });
        if (c.effect === 'points') points += c.amount;
        else if (c.effect === 'steps') { pos = (pos + c.amount) % RING; }
        else if (c.effect === 'credits' && mode === 'steady') {
          const g = await grant(ctx, company, { person, kind: 'note', amount: c.amount, idem: `note:${person.id}:${event.id}`, groupKey: 'note', at: event.occurred_at, eventId: event.id, actor: 'system' });
          effects.push({ t: 'note_credits', credits: g.paid });
        }
      }
    }
    if (sq.type === 'desk' && person.team_id) {
      const desk = await ctx.db.first('SELECT * FROM desk WHERE company_id = ? AND square_idx = ?', company.id, pos);
      if (desk) {
        const owners = await ctx.db.all(`SELECT o.* FROM desk_owner o JOIN app_user u ON u.id = o.person_id WHERE o.desk_id = ? AND o.person_id != ? AND u.team_id = ? AND u.company_id = ?`, desk.id, person.id, person.team_id, company.id);
        for (const o of owners) {
          const pool = await ctx.db.first('SELECT points FROM pool WHERE company_id = ? AND team_id = ?', company.id, person.team_id);
          const fee = Math.min(desk.base_fee * o.level, pool?.points ?? 0);
          if (fee > 0) {
            // Visit fee: board points from the company-funded collaboration pool. Teammates never pay each other.
            await ctx.db.batch([
              ['UPDATE pool SET points = points - ? WHERE company_id = ? AND team_id = ? AND points >= ?', fee, company.id, person.team_id, fee],
              ['UPDATE board_state SET points = points + ? WHERE person_id = ? AND EXISTS (SELECT 1 FROM pool WHERE company_id = ? AND team_id = ?)', fee, o.person_id, company.id, person.team_id],
            ]);
            effects.push({ t: 'visit_fee', desk: desk.name, points: fee, to: 'a teammate who helped' });
          }
        }
      }
    }
  }
  const level = levelOf(laps);
  const mv = newId('mv');
  try {
    await commit(ctx, company.id, 'system', 'board.move', { person: person.id, event: event.id, from, to: pos, steps, dice }, [
      ['INSERT INTO move_log (id, company_id, person_id, event_id, seed, dice, from_pos, to_pos, effects, at) VALUES (?,?,?,?,?,?,?,?,?,?)', mv, company.id, person.id, event.id, `${person.id}:${event.id}`, JSON.stringify(dice), from, pos, JSON.stringify(effects), ctx.now()],
      ['UPDATE board_state SET position=?, points=?, laps=?, level=?, in_lane=?, skip_roll=?, note_ctr=?, updated_at=? WHERE person_id = ?', pos, points, laps, level, lane, skip, noteCtr, ctx.now(), person.id],
    ]);
  } catch (e) {
    if (/move_log/i.test(String(e?.message))) return { replay: true, move: await ctx.db.first('SELECT * FROM move_log WHERE event_id = ?', event.id) };
    throw e;
  }
  return { from, to: pos, steps, dice, effects, level };
}

/** Board reset. Board points go back to the start amount. Credits already earned stay. No effect on pay or job. */
export async function resetBoard(ctx, company, personId, actor = personId) {
  const s = settingsOf(company);
  await ensureBoard(ctx, company, personId);
  await commit(ctx, company.id, actor, 'board.reset', { person: personId }, [
    ['UPDATE board_state SET points=?, position=0, in_lane=0, skip_roll=0, resets=resets+1, updated_at=? WHERE person_id=? AND company_id=?', s.start_points, ctx.now(), personId, company.id],
    ['DELETE FROM desk_owner WHERE person_id = ? AND desk_id IN (SELECT id FROM desk WHERE company_id = ?)', personId, company.id],
  ]);
  return getBoard(ctx, company, personId);
}
/** Called after any change to board points: at zero or below the board resets by itself. */
export async function checkReset(ctx, company, personId) {
  const b = await ctx.db.first('SELECT points FROM board_state WHERE person_id = ?', personId);
  if (b && b.points <= 0) return resetBoard(ctx, company, personId, 'system');
  return null;
}

export async function claimDesk(ctx, company, person, deskId) {
  const b = await ensureBoard(ctx, company, person.id);
  const desk = await ctx.db.first('SELECT * FROM desk WHERE id = ? AND company_id = ?', deskId, company.id);
  if (!desk) throw new ApiError(404, 'no_desk', 'No such desk.');
  if (b.position !== desk.square_idx) throw new ApiError(409, 'not_here', 'Your token must be on this desk to claim it.');
  if (await ctx.db.first('SELECT 1 x FROM desk_owner WHERE desk_id = ? AND person_id = ?', desk.id, person.id)) throw new ApiError(409, 'owned', 'You already hold this desk.');
  if (desk.target_id) {
    const t = await ctx.db.first('SELECT * FROM period_target WHERE id = ? AND company_id = ?', desk.target_id, company.id);
    const hit = t && (await periodsHit(ctx, company, t, person.id, ctx.now())) > 0;
    if (!hit) throw new ApiError(409, 'target_not_met', 'The matching target has not been met yet.');
  }
  if (b.points < desk.price_points) throw new ApiError(409, 'not_enough_points', 'Not enough board points.');
  await commit(ctx, company.id, person.id, 'desk.claim', { desk: desk.id, price: desk.price_points }, [
    ['UPDATE board_state SET points = points - ? WHERE person_id = ? AND points >= ?', desk.price_points, person.id, desk.price_points],
    ['INSERT INTO desk_owner (desk_id, owner_key, person_id, level, claimed_at) VALUES (?,?,?,1,?)', desk.id, person.id, person.id, ctx.now()],
  ]);
  await checkReset(ctx, company, person.id);
  return getBoard(ctx, company, person.id);
}

export async function upgradeDesk(ctx, company, person, deskId) {
  const b = await ensureBoard(ctx, company, person.id);
  const desk = await ctx.db.first('SELECT * FROM desk WHERE id = ? AND company_id = ?', deskId, company.id);
  const own = desk && (await ctx.db.first('SELECT * FROM desk_owner WHERE desk_id = ? AND person_id = ?', desk.id, person.id));
  if (!own) throw new ApiError(404, 'not_owner', 'You do not hold this desk.');
  if (own.level >= desk.max_level) throw new ApiError(409, 'max_level', 'Already at the top level.');
  const cost = desk.price_points * own.level;
  if (b.points < cost) throw new ApiError(409, 'not_enough_points', 'Not enough board points.');
  if (desk.target_id) {
    const t = await ctx.db.first('SELECT * FROM period_target WHERE id = ?', desk.target_id);
    // Upgrades need repeat achievement: the target hit in more and more periods.
    const hits = await periodsHit(ctx, company, t, person.id, ctx.now());
    if (hits < own.level * 2) throw new ApiError(409, 'repeat_needed', `Hit the target in ${own.level * 2} periods to upgrade (so far ${hits}).`);
  }
  await commit(ctx, company.id, person.id, 'desk.upgrade', { desk: desk.id, to: own.level + 1, cost }, [
    ['UPDATE board_state SET points = points - ? WHERE person_id = ? AND points >= ?', cost, person.id, cost],
    ['UPDATE desk_owner SET level = level + 1 WHERE desk_id = ? AND person_id = ?', desk.id, person.id],
  ]);
  await checkReset(ctx, company, person.id);
  return getBoard(ctx, company, person.id);
}

/** Swap two desks inside one team, or record a help-offer. No credits are ever part of a swap. */
export async function offerSwap(ctx, company, from, { toPersonId, deskFrom, deskTo, helpText }) {
  const to = await ctx.db.first('SELECT * FROM app_user WHERE id = ? AND company_id = ? AND status = ?', toPersonId, company.id, 'active');
  if (!to || !from.team_id || to.team_id !== from.team_id || to.id === from.id) throw new ApiError(403, 'same_team_only', 'Swaps are only between teammates.');
  if (!!deskFrom !== !!deskTo) throw new ApiError(400, 'desk_pair', 'Name both desks, or neither.');
  if (deskFrom && deskTo) {
    const mine = await ctx.db.first('SELECT o.* FROM desk_owner o JOIN desk d ON d.id = o.desk_id WHERE o.desk_id = ? AND o.person_id = ? AND d.company_id = ?', deskFrom, from.id, company.id);
    const theirs = await ctx.db.first('SELECT o.* FROM desk_owner o JOIN desk d ON d.id = o.desk_id WHERE o.desk_id = ? AND o.person_id = ? AND d.company_id = ?', deskTo, to.id, company.id);
    if (!mine || !theirs) throw new ApiError(409, 'desk_changed', 'Each of you must hold the desk you offer.');
  }
  const id = newId('sw');
  await commit(ctx, company.id, from.id, 'swap.offer', { id, to: to.id, deskFrom, deskTo }, [['INSERT INTO swap_offer (id, company_id, from_person, to_person, desk_from, desk_to, help_text, created_at) VALUES (?,?,?,?,?,?,?,?)', id, company.id, from.id, to.id, deskFrom ?? null, deskTo ?? null, String(helpText ?? '').slice(0, 200) || null, ctx.now()]]);
  return { id };
}
export async function answerSwap(ctx, company, person, offerId, accept) {
  const o = await ctx.db.first("SELECT * FROM swap_offer WHERE id = ? AND company_id = ? AND state = 'open'", offerId, company.id);
  if (!o || o.to_person !== person.id) throw new ApiError(404, 'no_offer', 'No such offer for you.');
  if (!accept) { await ctx.db.run("UPDATE swap_offer SET state = 'declined' WHERE id = ? AND state = 'open'", o.id); return { state: 'declined' }; }
  const open = "EXISTS (SELECT 1 FROM swap_offer WHERE id = ? AND state = 'open')";
  const stmts = [];
  if (o.desk_from && o.desk_to) {
    const a = await ctx.db.first('SELECT * FROM desk_owner WHERE desk_id = ? AND person_id = ?', o.desk_from, o.from_person);
    const b = await ctx.db.first('SELECT * FROM desk_owner WHERE desk_id = ? AND person_id = ?', o.desk_to, o.to_person);
    if (!a || !b) throw new ApiError(409, 'desk_changed', 'One of the desks is no longer held.');
    // Both must still be teammates, and nobody may already hold the desk they would receive (that would clash).
    const [pa, pb] = [await ctx.db.first('SELECT team_id FROM app_user WHERE id = ?', o.from_person), await ctx.db.first('SELECT team_id FROM app_user WHERE id = ?', o.to_person)];
    if (!pa?.team_id || pa.team_id !== pb?.team_id) throw new ApiError(403, 'same_team_only', 'Swaps are only between teammates.');
    if (await ctx.db.first('SELECT 1 x FROM desk_owner WHERE (desk_id = ? AND person_id = ?) OR (desk_id = ? AND person_id = ?)', o.desk_from, o.to_person, o.desk_to, o.from_person)) throw new ApiError(409, 'already_held', 'One of you already holds the other desk.');
    // The receiver must meet the desk's target at the level the desk is at (a claim needs one hit, level L needs 2 x (L-1)).
    for (const [deskId, receiver, level] of [[o.desk_from, o.to_person, a.level], [o.desk_to, o.from_person, b.level]]) {
      const d = await ctx.db.first('SELECT * FROM desk WHERE id = ? AND company_id = ?', deskId, company.id);
      if (!d) throw new ApiError(409, 'desk_changed', 'One of the desks is gone.');
      if (d.target_id) {
        const t = await ctx.db.first('SELECT * FROM period_target WHERE id = ? AND company_id = ?', d.target_id, company.id);
        const hits = t ? await periodsHit(ctx, company, t, receiver, ctx.now()) : 0;
        if (hits < Math.max(1, 2 * (level - 1))) throw new ApiError(409, 'target_not_met', 'The new holder has not met the target for this desk level.');
      }
    }
    stmts.push([`UPDATE desk_owner SET person_id = ?, owner_key = ? WHERE desk_id = ? AND person_id = ? AND ${open}`, o.to_person, o.to_person, o.desk_from, o.from_person, o.id]);
    stmts.push([`UPDATE desk_owner SET person_id = ?, owner_key = ? WHERE desk_id = ? AND person_id = ? AND ${open}`, o.from_person, o.from_person, o.desk_to, o.to_person, o.id]);
  }
  stmts.push(["UPDATE swap_offer SET state = 'accepted' WHERE id = ? AND state = 'open'", o.id]);
  try {
    await commit(ctx, company.id, person.id, 'swap.accept', { id: o.id }, stmts);
  } catch (e) {
    if (/UNIQUE|PRIMARY|constraint/i.test(String(e?.message)) && !/audit/i.test(String(e?.message))) throw new ApiError(409, 'desk_changed', 'The desks changed. Ask again.');
    throw e;
  }
  return { state: 'accepted' };
}

/** Company funds the collaboration pool (board points only). */
export async function fundPool(ctx, company, teamId, points, actor) {
  if (!Number.isInteger(points) || points < 0 || points > 1_000_000) throw new ApiError(400, 'bad_number', 'points');
  const t = await ctx.db.first('SELECT id FROM team WHERE id = ? AND company_id = ?', teamId, company.id);
  if (!t) throw new ApiError(404, 'no_team', 'No such team.');
  await commit(ctx, company.id, actor, 'pool.fund', { team: teamId, points }, [
    ['INSERT INTO pool (company_id, team_id, points) VALUES (?,?,?) ON CONFLICT(company_id, team_id) DO UPDATE SET points = points + excluded.points', company.id, teamId, points],
  ]);
}

// ---------- Catch-up Lane: a cooldown and coaching square. Never a fine, never pay. ----------
/** The audit line keeps a short code only (never the coaching text, which can describe a person). */
const laneCode = (reason, code) => code ?? (/^[a-z0-9_.:-]{1,60}$/i.test(String(reason ?? '')) ? String(reason) : 'custom');
export async function enterLane(ctx, company, personId, reason, actor = 'system', code = null) {
  await ensureBoard(ctx, company, personId);
  await commit(ctx, company.id, actor, 'lane.enter', { person: personId, code: laneCode(reason, code) }, [
    ['UPDATE board_state SET in_lane = 1, skip_roll = 1, updated_at = ? WHERE person_id = ?', ctx.now(), personId],
    ['INSERT INTO lane_task (id, company_id, person_id, task, created_at) VALUES (?,?,?,?,?)', newId('lt'), company.id, personId, String(reason ?? 'One small coaching task').slice(0, 200), ctx.now()],
  ]);
}
/**
 * Finish a lane task. `actor` is a user id or 'system'; `actorUser` (optional) is the user row. A person may be cleared only by
 * the manager of their own team or by the company admin. The system (penalty reversal) may always do it.
 */
export async function finishLaneTask(ctx, company, taskId, actor, actorUser = null) {
  const t = await ctx.db.first("SELECT * FROM lane_task WHERE id = ? AND company_id = ? AND state = 'open'", taskId, company.id);
  if (!t) throw new ApiError(404, 'no_task', 'No such open task.');
  if (actor !== 'system' || actorUser) {
    const who = actorUser ?? (await ctx.db.first('SELECT * FROM app_user WHERE id = ? AND company_id = ?', actor, company.id));
    let ok = false;
    if (who?.role === 'admin') ok = true;
    else if (who?.role === 'manager' && who.id !== t.person_id) {
      const p = await ctx.db.first('SELECT team_id FROM app_user WHERE id = ? AND company_id = ?', t.person_id, company.id);
      const team = p?.team_id ? await ctx.db.first('SELECT manager_id FROM team WHERE id = ? AND company_id = ?', p.team_id, company.id) : null;
      ok = !!team && team.manager_id === who.id;
    }
    if (!ok) throw new ApiError(403, 'not_your_team', 'Only the manager of this person\'s team or the admin can clear a task.');
  }
  await commit(ctx, company.id, actorUser?.id ?? actor, 'lane.exit', { person: t.person_id, task: t.id }, [
    ["UPDATE lane_task SET state = 'done' WHERE id = ? AND state = 'open'", t.id],
    ['UPDATE board_state SET in_lane = 0, skip_roll = 0, updated_at = ? WHERE person_id = ?', ctx.now(), t.person_id],
  ]);
}

export async function getBoard(ctx, company, personId) {
  const b = await ensureBoard(ctx, company, personId);
  const person = await ctx.db.first('SELECT id, team_id, avatar FROM app_user WHERE id = ?', personId);
  const desks = await ctx.db.all('SELECT d.id, d.square_idx, d.name, d.price_points, d.base_fee, d.max_level, d.target_id, o.level, o.person_id owner FROM desk d LEFT JOIN desk_owner o ON o.desk_id = d.id AND o.person_id = ? WHERE d.company_id = ?', personId, company.id);
  const moves = await ctx.db.all('SELECT from_pos, to_pos, dice, effects, at FROM move_log WHERE person_id = ? ORDER BY at DESC LIMIT 20', personId);
  const tasks = await ctx.db.all("SELECT id, task FROM lane_task WHERE person_id = ? AND state = 'open'", personId);
  return {
    squares: SQUARES, position: b.position, points: b.points, laps: b.laps, level: b.level, levelName: LEVEL_NAMES[b.level - 1], inLane: !!b.in_lane, resets: b.resets,
    avatar: person?.avatar, desks: desks.map((d) => ({ ...d, owned: d.owner === personId, owner: undefined })), laneTasks: tasks,
    moves: moves.map((m) => ({ ...m, dice: JSON.parse(m.dice), effects: JSON.parse(m.effects) })),
  };
}
