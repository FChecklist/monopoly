// A realistic volume for the route crawler: a company with many people, twelve months of counted events and paid rewards, targets, teams, a few open cases.
import { boot } from './webhelp.js';
import { T0, exampleCard } from './helpers.js';
import * as setup from '../src/setup.js';
import { addPerson } from '../src/people.js';

const DAY = 86400_000;
export const SETTINGS = { daily_event_limit: 1e6, cap_event: 500, cap_person_month: 1e6, cap_person_season: 1e6, cap_period_bonus_person_period: 1e6 };

/** people: number of employees; months: periods of history. The default env is the REAL free-plan one: invocation limit 50, tick budget 40. */
export async function crawlWorld({ people = 60, months = 12, teams = 12, payFrom = null, coldTargets = 0 } = {}) {
  const w = await boot({ settings: SETTINGS });
  w.ctx.env = { ...w.ctx.env, TICK_QUERY_BUDGET: '40', LAZY_TICK: '1' };
  await exampleCard(w);
  await w.db.run('UPDATE season SET starts_at = ?, ends_at = ? WHERE id = ?', T0 - (months + 2) * 31 * DAY, T0 + 300 * DAY, w.season);
  const tids = [w.team];
  for (let t = 1; t < teams; t++) tids.push((await setup.createTeam(w.ctx, w.company, w.admin, { name: 'T' + t, manager_id: null })).id);
  const ids = [];
  for (let i = 0; i < people; i++) {
    const { user } = await addPerson(w.ctx, w.company, w.admin, { email: `p${i}@acme.test`, name: 'person ' + i, role: 'employee', team_id: tids[i % teams], joined_at: T0 - (months + 2) * 31 * DAY });
    ids.push(user.id);
  }
  w.ids = ids; w.teams = tids;
  for (const u of ids) for (const kind of ['employee_notice', 'penalty_rules']) await w.db.run('INSERT INTO consent (id, user_id, company_id, kind, version, at) VALUES (?,?,?,?,?,?)', `cn_${u}_${kind}`, u, w.company.id, kind, 1, T0);
  // targets: a person target per month, a team target, a weekly one with a streak
  await setup.addTarget(w.ctx, w.company, w.admin, { name: 'Games', scope: 'person', period: 'month', event_type: 'game', stage: 'completed', tiers: [{ count: 1, bonus: 10 }, { count: 3, bonus: 30 }], active_from: payFrom ?? T0 - (months + 1) * 31 * DAY });
  await setup.addTarget(w.ctx, w.company, w.admin, { name: 'Team games', scope: 'team', period: 'month', event_type: 'game', stage: 'completed', tiers: [{ count: 20, bonus: 100 }], active_from: T0 - (months + 1) * 31 * DAY });
  await setup.addTarget(w.ctx, w.company, w.admin, { name: 'Weekly', scope: 'person', period: 'week', event_type: 'game', stage: 'created', tiers: [{ count: 1, bonus: 5 }], streak: { length: 3, bonus: 20, freeze_per_season: 1 }, active_from: T0 - (months + 1) * 31 * DAY });
  for (let k = 0; k < coldTargets; k++) await setup.addTarget(w.ctx, w.company, w.admin, { name: 'Cold' + k, scope: 'person', period: 'month', event_type: 'game', stage: 'completed', tiers: [{ count: 1000, bonus: 10 }], active_from: T0 - (months + 1) * 31 * DAY }); // old periods with events and nothing to pay
  const card = await w.db.first("SELECT id FROM rate_card WHERE event_type = 'game' AND stage = 'completed'");
  let n = 0;
  const ev = [], rw = [];
  for (let m = 0; m < months; m++) for (const [i, pid] of ids.entries()) for (let k = 0; k < 2; k++) {
    const at = T0 - (months - m) * 30 * DAY + (k + 1) * DAY + i * 1000;
    const eid = 'zev' + (++n);
    ev.push(["INSERT INTO event (id, company_id, person_id, submitted_by, source, event_type, stage, ext_id, occurred_at, value, status, approvals_required, rate_card_id, season_id, created_at, applied_at) VALUES (?,?,?,?,?,?,?,?,?,0,'applied',0,?,?,?,?)", eid, w.company.id, pid, 'api', 'game', 'game', 'completed', 'x' + n, at, card.id, w.season, at, at]);
    rw.push(["INSERT INTO reward (id, company_id, person_id, kind, group_key, idem_key, amount, period_key, month_key, day_key, season_id, event_id, state, note, created_at, sent_amount, sent_at, provider_ref) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'sent','{}',?,?,?,?)", 'zrw' + n, w.company.id, pid, 'event', 'card:game:completed', 'event:' + eid + ':completed', 40, null, new Date(at).toISOString().slice(0, 7), new Date(at).toISOString().slice(0, 10), w.season, eid, at, 40, at, 'ref' + n]);
  }
  for (let i = 0; i < ev.length; i += 200) await w.db.batch([...ev.slice(i, i + 200), ...rw.slice(i, i + 200)]);
  w.eventId = (await w.db.first("SELECT id FROM event ORDER BY occurred_at DESC LIMIT 1")).id;
  w.rewardId = (await w.db.first('SELECT id FROM reward LIMIT 1')).id;
  // the raw call counter: what one worker invocation would be charged
  w.calls = 0; const raw = w.ctx.db;
  for (const m of ['first', 'all', 'run', 'batch', 'reads']) { const g = raw[m].bind(raw); raw[m] = (...a) => { w.calls++; return g(...a); }; }
  w.clock.t = T0 + DAY;
  for (const who of ['admin', 'hr', 'mgr', 'a']) await w.login(who);
  return w;
}
