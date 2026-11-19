// Test world: in-memory database, fixed clock, demo provider, a company with people and a published season.
import { openDb, migrate, migrateDev } from '../src/db.js';
import { makeCtx } from '../src/ctx.js';
import { createCompany, addPerson } from '../src/people.js';
import { createTeam } from '../src/setup.js';
import * as setup from '../src/setup.js';

export const ENV = { SEAL_KEY: 'test-seal-key-0123456789abcdef-0123456789', MASTER_SECRET: 'test-master-secret-0123456789abcdef-0123456789', ALLOW_DEMO_PROVIDER: '1', FUTURE_OPS: '1', LAZY_TICK: '0', TICK_QUERY_BUDGET: '0' }; // FUTURE_OPS: the test-only switch for the abilities that are NOT ENABLED in v1 (hold, debit, reverse); world({ v1: true }) runs without it
export const T0 = Date.parse('2026-11-02T10:00:00+05:30'); // a Monday

export async function world({ v1 = false, providerOverride = null, budget = 1_000_000, mode = 'steady', settings = {} } = {}) {
  const db = openDb(); migrate(db); migrateDev(db);
  const clock = { t: T0 - 20 * 86400_000 };
  const ctx = makeCtx({ db, env: v1 ? { ...ENV, FUTURE_OPS: undefined } : ENV, now: () => clock.t, providerOverride });
  const { company, admin } = await createCompany(ctx, { name: 'Acme Test', slug: 'acme', adminEmail: 'boss@acme.test', settings });
  const w = { db, ctx, clock, company, admin, people: {} };
  w.reload = async () => { w.company = await db.first('SELECT * FROM company WHERE id = ?', company.id); return w.company; };
  const mk = async (key, role, extra = {}) => { const { user, code } = await addPerson(ctx, w.company, admin, { email: `${key}@acme.test`, name: key, role, ...extra }); w.people[key] = user; w.codes = { ...(w.codes ?? {}), [key]: code }; return user; };
  w.admin = admin; w.people.admin = admin;
  await mk('hr', 'hr');
  await mk('mgr', 'manager');
  const t = await createTeam(ctx, w.company, admin, { name: 'Sales', manager_id: w.people.mgr.id });
  w.team = t.id;
  await db.run('UPDATE app_user SET team_id = ? WHERE id = ?', t.id, w.people.mgr.id);
  for (const k of ['a', 'b', 'c', 'd']) await mk(k, 'employee', { team_id: t.id, joined_at: T0 - 60 * 86400_000 });
  // consent for everybody (notice and penalty rules)
  for (const u of Object.values(w.people)) {
    for (const kind of ['employee_notice', 'penalty_rules']) await db.run('INSERT INTO consent (id, user_id, company_id, kind, version, at) VALUES (?,?,?,?,?,?)', `cn_${u.id}_${kind}`, u.id, company.id, kind, 'v', T0);
  }
  const s = await setup.createSeason(ctx, w.company, admin, { name: 'Season', starts_at: T0 - 10 * 86400_000, ends_at: T0 + 300 * 86400_000, budget, mode });
  await setup.publishSeason(ctx, w.company, admin, s.id, { allowStarted: true });
  w.season = s.id;
  clock.t = T0;
  return w;
}
/** The example rate card from the design report (example numbers only). */
export async function exampleCard(w) {
  const { ctx, company, admin } = w;
  const rc = (o) => setup.addRateCard(ctx, company, admin, { active_from: T0 - 30 * 86400_000, ...o });
  await rc({ event_type: 'lead', stage: 'entered', stage_no: 1, credits: 5, cap_month: 300, state_needed: 'auto' });
  await rc({ event_type: 'lead', stage: 'verified', stage_no: 2, credits: 15, cap_month: 600, state_needed: 'manager' });
  await rc({ event_type: 'lead', stage: 'converted', stage_no: 3, credits: 80, cap_month: 3000, state_needed: 'system', mode: 'both' });
  await rc({ event_type: 'game', stage: 'created', stage_no: 1, credits: 10, cap_month: 200, state_needed: 'auto' });
  await rc({ event_type: 'game', stage: 'completed', stage_no: 2, credits: 40, cap_month: 1000, state_needed: 'system', mode: 'both' });
  await rc({ event_type: 'attendance', stage: 'on_time', stage_no: 1, credits: 2, cap_month: 60, state_needed: 'system' });
}
export const SYSTEM = { id: 'api', role: 'system' };
