// Company setup: teams, rate card (versioned), period targets, tiers, streaks, seasons, cards, desks, rules, keys, shop.
import { ApiError, newId, mustInt, clean, hmacHex, DAY, periodOf, PERIODS } from './util.js';
import { commit } from './audit.js';
import { settingsOf } from './config.js';
import { accountRef, retryQueued, releaseSeasonHold, releasePendingHolds } from './rewards.js';
import { ProviderError } from './provider/errors.js';

const must = (actor, ...roles) => { if (!roles.includes(actor.role)) throw new ApiError(403, 'not_allowed', 'You cannot do this.'); };
const word = (v, name, max = 60) => { const s = clean(v, max); if (!s) throw new ApiError(400, 'missing', `${name} is needed.`); return s; };

// ---------- teams ----------
export async function createTeam(ctx, company, actor, { name, manager_id }) {
  must(actor, 'admin');
  if (manager_id && !(await ctx.db.first("SELECT id FROM app_user WHERE id = ? AND company_id = ? AND role = 'manager'", manager_id, company.id))) throw new ApiError(400, 'bad_manager', 'The manager must be a person with the manager role in this company.');
  const id = newId('t');
  await commit(ctx, company.id, actor.id, 'team.create', { id, manager: manager_id ?? null }, [['INSERT INTO team (id, company_id, name, manager_id, created_at) VALUES (?,?,?,?,?)', id, company.id, word(name, 'name', 80), manager_id ?? null, ctx.now()]]);
  return { id };
}
export async function assignTeam(ctx, company, actor, personId, teamId) {
  must(actor, 'admin');
  if (teamId && !(await ctx.db.first('SELECT id FROM team WHERE id = ? AND company_id = ?', teamId, company.id))) throw new ApiError(404, 'no_team', 'No such team.');
  const r = await ctx.db.run('UPDATE app_user SET team_id = ? WHERE id = ? AND company_id = ?', teamId ?? null, personId, company.id);
  if (!r.changes) throw new ApiError(404, 'no_person', 'No such person.');
  await commit(ctx, company.id, actor.id, 'team.assign', { person: personId, team: teamId ?? null });
}

// ---------- rate card (versioned; never changes the past) ----------
export async function addRateCard(ctx, company, actor, input) {
  must(actor, 'admin');
  const type = word(input.event_type, 'event_type'), stage = word(input.stage, 'stage', 40);
  const credits = mustInt(input.credits, 'credits', { min: 0, max: 1_000_000 });
  const row = {
    stage_no: mustInt(input.stage_no ?? 1, 'stage_no', { min: 1, max: 20 }), credits,
    cap_month: mustInt(input.cap_month ?? 0, 'cap_month', { max: 10_000_000 }), cap_day: mustInt(input.cap_day ?? 0, 'cap_day', { max: 10_000_000 }),
    state_needed: ['auto', 'manager', 'system'].includes(input.state_needed) ? input.state_needed : 'auto',
    mode: ['individual', 'team', 'both'].includes(input.mode) ? input.mode : 'individual',
    rolls: mustInt(input.rolls ?? 1, 'rolls', { min: 1, max: 6 }), moves: mustInt(input.moves ?? 1, 'moves', { min: 0, max: 24 }),
  };
  const now = ctx.now();
  const cur = await ctx.db.first('SELECT * FROM rate_card WHERE company_id=? AND event_type=? AND stage=? AND active_to IS NULL ORDER BY version DESC LIMIT 1', company.id, type, stage);
  let from = Number.isFinite(Number(input.active_from)) && input.active_from ? Number(input.active_from) : now;
  let version = 1;
  if (cur) {
    version = cur.version + 1;
    // Kinder changes may start at once. Stricter ones start next month. Nothing ever applies backwards.
    const kinder = row.credits >= cur.credits && (row.cap_month === 0 || (cur.cap_month !== 0 && row.cap_month >= cur.cap_month)) && (row.cap_day === 0 || (cur.cap_day !== 0 && row.cap_day >= cur.cap_day));
    const earliest = kinder ? now : periodOf('month', now).end;
    if (from < earliest) from = earliest;
  }
  const id = newId('rc');
  const stmts = [];
  if (cur) stmts.push(['UPDATE rate_card SET active_to = ? WHERE id = ?', from, cur.id]);
  stmts.push(['INSERT INTO rate_card (id, company_id, event_type, stage, stage_no, credits, cap_month, cap_day, state_needed, mode, rolls, moves, active_from, version, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, company.id, type, stage, row.stage_no, row.credits, row.cap_month, row.cap_day, row.state_needed, row.mode, row.rolls, row.moves, from, version, now]);
  await commit(ctx, company.id, actor.id, 'ratecard.set', { id, type, stage, version, credits, from }, stmts);
  return { id, version, active_from: from };
}

// ---------- period targets, tiers, streaks ----------
export async function addTarget(ctx, company, actor, input) {
  must(actor, 'admin');
  if (!PERIODS.includes(input.period)) throw new ApiError(400, 'bad_period', 'Period is week, month, quarter, half or year.');
  const tiers = (input.tiers ?? []).map((t, i) => ({ idx: i + 1, count: mustInt(t.count, 'tier count', { min: 1, max: 1e6 }), bonus: mustInt(t.bonus, 'tier bonus', { min: 0, max: 1e7 }) }));
  if (!tiers.length) throw new ApiError(400, 'no_tiers', 'At least one tier is needed.');
  for (let i = 1; i < tiers.length; i++) if (tiers[i].count <= tiers[i - 1].count || tiers[i].bonus < tiers[i - 1].bonus) throw new ApiError(400, 'bad_tiers', 'Tiers must rise in count and in total bonus.');
  const id = newId('pt');
  const stmts = [['INSERT INTO period_target (id, company_id, name, scope, period, event_type, stage, active_from, created_at) VALUES (?,?,?,?,?,?,?,?,?)', id, company.id, word(input.name, 'name', 80), input.scope === 'team' ? 'team' : 'person', input.period, word(input.event_type, 'event_type'), word(input.stage, 'stage', 40), input.active_from ?? ctx.now(), ctx.now()]];
  for (const t of tiers) stmts.push(['INSERT INTO tier (id, target_id, idx, count, bonus) VALUES (?,?,?,?,?)', newId('tr'), id, t.idx, t.count, t.bonus]);
  let streakId = null;
  if (input.streak) {
    streakId = newId('sk');
    stmts.push(['INSERT INTO streak (id, company_id, target_id, length, bonus, freeze_per_quarter) VALUES (?,?,?,?,?,?)', streakId, company.id, id, mustInt(input.streak.length, 'streak length', { min: 2, max: 60 }), mustInt(input.streak.bonus, 'streak bonus', { max: 1e7 }), mustInt(input.streak.freeze_per_quarter ?? 0, 'freeze', { max: 1 })]);
  }
  await commit(ctx, company.id, actor.id, 'target.create', { id, period: input.period, tiers: tiers.length, streak: streakId }, stmts);
  return { id, streak_id: streakId };
}

// ---------- seasons ----------
export async function createSeason(ctx, company, actor, { name, starts_at, ends_at, budget, mode }) {
  must(actor, 'admin');
  if (!(ends_at > starts_at)) throw new ApiError(400, 'bad_dates', 'The season must end after it starts.');
  const id = newId('se');
  await commit(ctx, company.id, actor.id, 'season.create', { id, budget }, [['INSERT INTO season (id, company_id, name, starts_at, ends_at, budget, mode, status) VALUES (?,?,?,?,?,?,?, \'draft\')', id, company.id, word(name, 'name', 80), starts_at, ends_at, mustInt(budget, 'budget', { max: 1e9 }), mode === 'dice' ? 'dice' : 'steady']]);
  return { id };
}
/** Publish with a start date in the future (rules are never changed under people). The budget is held at the provider when it can. */
export async function publishSeason(ctx, company, actor, seasonId, { allowStarted = false } = {}) {
  must(actor, 'admin');
  const s = await ctx.db.first("SELECT * FROM season WHERE id = ? AND company_id = ? AND status = 'draft'", seasonId, company.id);
  if (!s) throw new ApiError(404, 'no_season', 'No draft season with this id.');
  if (s.starts_at <= ctx.now() && !allowStarted) throw new ApiError(409, 'starts_in_past', 'Publish before the start date, so nothing changes under people.');
  const st = settingsOf(company);
  if (s.mode === 'dice' && st.bonus_floor_pct < 10) throw new ApiError(409, 'floor', 'Dice mode needs a bonus floor of at least 10 percent.');
  let hold = null;
  const prov = ctx.provider(company);
  if ((await prov.capabilities()).hold) {
    const topUp = s.mode === 'dice' ? Math.ceil(s.budget * (1 + st.bonus_max_pct / 100)) : s.budget; // the whole range is funded in advance
    const h = await prov.reserveBudget({ amount: topUp, name: s.name, idem: 'hold:' + s.id });
    hold = h.hold_id;
  }
  await commit(ctx, company.id, actor.id, 'season.publish', { id: s.id, hold }, [["UPDATE season SET status='published', published_at=?, hold_id=? WHERE id=? AND status='draft'", ctx.now(), hold, s.id]]);
  return { id: s.id, hold_id: hold };
}
export async function raiseBudget(ctx, company, actor, seasonId, budget) {
  must(actor, 'admin');
  const s = await ctx.db.first("SELECT * FROM season WHERE id=? AND company_id=? AND status='published'", seasonId, company.id);
  if (!s) throw new ApiError(404, 'no_season', 'No published season.');
  budget = mustInt(budget, 'budget', { max: 1e9 });
  if (budget < s.budget) throw new ApiError(409, 'only_up', 'A published budget can only go up.');
  let holdId = s.hold_id;
  const prov = ctx.provider(company);
  if (s.hold_id && (await prov.capabilities()).hold) {
    // The new budget is held in full (less what was already paid out); the old hold's remainder goes back.
    const st = settingsOf(company);
    // Only SENT rows have drawn from the hold. A queued row has not (it draws when it is sent), so it stays inside the new hold or it would draw twice.
    const used = (await ctx.db.first("SELECT COALESCE(SUM(sent_amount),0) n FROM reward WHERE company_id=? AND season_id=? AND amount>0 AND state='sent'", company.id, s.id)).n;
    const top = s.mode === 'dice' ? Math.ceil(budget * (1 + st.bonus_max_pct / 100)) : budget;
    const h = await prov.reserveBudget({ amount: Math.max(0, top - used), name: s.name, idem: `hold:${s.id}:${budget}:u${used}` }); // the key carries what was used: a replay is never sized by an older number
    holdId = h.hold_id;
    // Recorded BEFORE the season row changes: if the commit below fails and the admin retries (maybe at another budget), this hold is found and released by the tick.
    await commit(ctx, company.id, actor.id, 'season.hold_new', { id: s.id, hold: holdId });
  }
  // The new hold is recorded FIRST; only then the old one goes back. A failed commit can never leave the season on a released hold.
  await commit(ctx, company.id, actor.id, 'season.budget', { id: s.id, from: s.budget, to: budget, hold: holdId, old: holdId !== s.hold_id ? s.hold_id : null }, [['UPDATE season SET budget = ?, hold_id = ? WHERE id = ?', budget, holdId, s.id]]); // 'old' = the hold that must go back; the tick keeps trying until it has
  await releasePendingHolds(ctx, company);
}
export async function closeSeason(ctx, company, actor, seasonId) {
  must(actor, 'admin');
  const s = await ctx.db.first("SELECT * FROM season WHERE id=? AND company_id=? AND status='published'", seasonId, company.id);
  if (!s) throw new ApiError(404, 'no_season', 'No published season.');
  let released = 0, deferred = false;
  const prov = ctx.provider(company);
  // Rewards of this season that are queued (a provider outage kept them) still draw from its hold. Try them once; if any is still on its way
  // the hold stays until the tick has sent them (releaseClosedHolds), so closing a season never turns earned rewards into voids.
  try { await retryQueued(ctx, company, 1000); } catch (e) { if (!(e instanceof ProviderError)) throw e; }
  let needRelease = false;
  if ((await ctx.db.first("SELECT COUNT(*) n FROM reward WHERE season_id=? AND state='queued'", s.id)).n > 0) deferred = true;
  else if (s.hold_id && (await prov.capabilities()).hold) needRelease = true;
  // The close is recorded FIRST (deferred while a hold still has to go back); the hold is released after, so a failed commit cannot leave a published season on a released hold.
  await commit(ctx, company.id, actor.id, 'season.close', deferred || needRelease ? { id: s.id, released, deferred: true } : { id: s.id, released }, [["UPDATE season SET status='closed' WHERE id=?", s.id]]);
  if (needRelease) { const amt = await releaseSeasonHold(ctx, company, s); if (amt === null) deferred = true; else released = amt; } // unused budget goes back to the company
  return deferred ? { released, hold_pending: true } : { released };
}

// ---------- surprise notes, desks, penalty rules ----------
export async function addNoteCard(ctx, company, actor, { text, effect = 'message', amount = 0, kind = 'note', order_no = 0 }) {
  must(actor, 'admin');
  if (!['message', 'credits', 'steps', 'points'].includes(effect)) throw new ApiError(400, 'bad_effect', 'A note can only give: a message, credits, steps or points.');
  const a = mustInt(amount, 'amount', { min: 0, max: effect === 'credits' ? 10_000 : 1000 }); // never a loss
  await commit(ctx, company.id, actor.id, 'note.add', { effect, amount: a }, [['INSERT INTO note_card (id, company_id, kind, text, effect, amount, order_no) VALUES (?,?,?,?,?,?,?)', newId('nc'), company.id, kind === 'team' ? 'team' : 'note', word(text, 'text', 240), effect, a, order_no]]);
}
export async function addDesk(ctx, company, actor, { square_idx, name, target_id, price_points = 200, base_fee = 20 }) {
  must(actor, 'admin');
  const sq = mustInt(square_idx, 'square', { min: 0, max: 23 });
  if (target_id && !(await ctx.db.first('SELECT id FROM period_target WHERE id = ? AND company_id = ?', target_id, company.id))) throw new ApiError(404, 'no_target', 'No such target in this company.');
  const id = newId('dk');
  await commit(ctx, company.id, actor.id, 'desk.add', { id, sq }, [['INSERT INTO desk (id, company_id, square_idx, name, target_id, price_points, base_fee) VALUES (?,?,?,?,?,?,?)', id, company.id, sq, word(name, 'name', 80), target_id ?? null, mustInt(price_points, 'price', { max: 100000 }), mustInt(base_fee, 'fee', { max: 10000 })]]);
  return { id };
}
export async function addPenaltyRule(ctx, company, actor, { event_type, effect, amount }) {
  must(actor, 'admin');
  if (!['steps_back', 'points', 'credits', 'lane'].includes(effect)) throw new ApiError(400, 'bad_effect', 'Unknown effect.');
  const id = newId('pr');
  await commit(ctx, company.id, actor.id, 'penaltyrule.add', { id, effect }, [['INSERT INTO penalty_rule (id, company_id, event_type, effect, amount) VALUES (?,?,?,?,?)', id, company.id, word(event_type, 'event_type'), effect, mustInt(amount ?? 0, 'amount', { max: 100000 })]]);
  return { id };
}
/** A penalty rule only applies to events after its publish time, so it is never retroactive. */
export async function publishPenaltyRule(ctx, company, actor, id) {
  must(actor, 'admin');
  const r = await commit(ctx, company.id, actor.id, 'penaltyrule.publish', { id }, [['UPDATE penalty_rule SET published_at = ? WHERE id = ? AND company_id = ? AND published_at IS NULL', ctx.now(), id, company.id]]);
  if (!r[0].changes) throw new ApiError(404, 'no_rule', 'No unpublished rule with this id.');
}

// ---------- keys for signed systems (CRM, games, Partner Circle widgets, AI agents) ----------
// Key classes: read < event_write < manager < admin. ai_read is separate (ask-only). provider_webhook is separate.
export const KEY_SCOPES = ['read', 'event_write', 'manager', 'admin', 'ai_read', 'provider_webhook'];
const SCOPE_ALIAS = { widgets: 'read', ingest: 'event_write' }; // older names still accepted when a key is made
/** The older derived secret, for keys made before secrets were stored sealed. Still works, never used for new keys. */
export const keySecret = (master, keyId) => hmacHex(master, 'floor-key:' + keyId);
/** The signing secret of a key row: the sealed random one, or the older derived one. */
export async function secretOfKey(ctx, row) {
  if (row.secret_sealed) return ctx.unseal(row.secret_sealed, 'company_key.secret:' + row.key_id);
  return keySecret(ctx.env.MASTER_SECRET_OLD || ctx.master, row.key_id);
}
export async function createKey(ctx, company, actor, { scope, label }) {
  must(actor, 'admin');
  scope = SCOPE_ALIAS[scope] ?? scope;
  if (!KEY_SCOPES.includes(scope)) throw new ApiError(400, 'bad_scope', 'Scope is one of: ' + KEY_SCOPES.join(', ') + '.');
  const key_id = 'fk_' + newId('k').slice(2, 22);
  const secret = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await commit(ctx, company.id, actor.id, 'key.create', { key_id, scope }, [['INSERT INTO company_key (key_id, company_id, scope, label, created_at, secret_sealed) VALUES (?,?,?,?,?,?)', key_id, company.id, scope, clean(label, 60), ctx.now(), await ctx.seal(secret, 'company_key.secret:' + key_id)]]);
  return { key_id, secret, scope }; // random, stored sealed, shown once
}
/** A new random signing secret for an active key (the key id stays). Older keys whose secret was derived (secret_sealed empty) should be re-issued once. The old secret stops working at once. Shown once. */
export async function reissueKey(ctx, company, actor, keyId) {
  must(actor, 'admin');
  const k = await ctx.db.first("SELECT key_id, scope FROM company_key WHERE key_id = ? AND company_id = ? AND status = 'active'", keyId, company.id);
  if (!k) throw new ApiError(404, 'no_key', 'No active key with this id.');
  const secret = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await commit(ctx, company.id, actor.id, 'key.reissue', { key_id: k.key_id }, [['UPDATE company_key SET secret_sealed = ? WHERE key_id = ? AND company_id = ?', await ctx.seal(secret, 'company_key.secret:' + k.key_id), k.key_id, company.id]]);
  return { key_id: k.key_id, secret, scope: k.scope, note: 'Shown once. The old secret stopped working.' };
}
export async function revokeKey(ctx, company, actor, keyId) {
  must(actor, 'admin');
  await commit(ctx, company.id, actor.id, 'key.revoke', { key_id: keyId }, [["UPDATE company_key SET status='revoked' WHERE key_id = ? AND company_id = ?", keyId, company.id]]);
}

// ---------- catalogue: credits are spent only through the provider (reserve, capture, release) ----------
export async function addItem(ctx, company, actor, { name, credits, needs_approval = true }) {
  must(actor, 'admin');
  const id = newId('it');
  await commit(ctx, company.id, actor.id, 'item.add', { id }, [['INSERT INTO catalogue_item (id, company_id, name, credits, needs_approval) VALUES (?,?,?,?,?)', id, company.id, word(name, 'name', 80), mustInt(credits, 'credits', { min: 1, max: 1e6 }), needs_approval ? 1 : 0]]);
  return { id };
}
export async function placeOrder(ctx, company, person, itemId) {
  const item = await ctx.db.first('SELECT * FROM catalogue_item WHERE id = ? AND company_id = ? AND active = 1', itemId, company.id);
  if (!item) throw new ApiError(404, 'no_item', 'No such item.');
  const id = newId('or');
  const prov = ctx.provider(company);
  if (!(await prov.capabilities()).spend) throw new ApiError(409, 'unsupported', 'This credit provider does not support spending.');
  let hold;
  try { hold = await prov.reserveSpend({ accountRef: await accountRef(ctx, company, person), amount: item.credits, ref: id, idem: 'order:' + id, item: item.name }); }
  catch (e) { if (e instanceof ProviderError) throw new ApiError(e.code === 'insufficient_credits' ? 402 : 502, e.code, e.message); throw e; }
  const approve = item.needs_approval === 0;
  await commit(ctx, company.id, person.id, 'order.place', { id, item: item.id, credits: item.credits }, [['INSERT INTO catalogue_order (id, company_id, person_id, item_id, credits, state, hold_id, created_at) VALUES (?,?,?,?,?,?,?,?)', id, company.id, person.id, item.id, item.credits, 'reserved', hold.hold_id, ctx.now()]]);
  if (approve) return decideOrder(ctx, company, { id: 'system', role: 'admin' }, id, true);
  return { id, state: 'reserved' };
}
export async function decideOrder(ctx, company, actor, orderId, accept) {
  must(actor, 'admin', 'hr');
  const o = await ctx.db.first("SELECT * FROM catalogue_order WHERE id = ? AND company_id = ? AND state = 'reserved'", orderId, company.id);
  if (!o) throw new ApiError(404, 'no_order', 'No order waiting.');
  const prov = ctx.provider(company);
  if (accept) await prov.captureSpend({ holdId: o.hold_id, idem: 'cap:' + o.id }); else await prov.releaseSpend({ holdId: o.hold_id, idem: 'rel:' + o.id });
  const state = accept ? 'captured' : 'released';
  await commit(ctx, company.id, actor.id, 'order.' + state, { id: o.id }, [["UPDATE catalogue_order SET state = ? WHERE id = ? AND state = 'reserved'", state, o.id]]);
  return { id: o.id, state };
}
