// HTTP API. One function: handle(ctx, Request) -> Response. Works in Workers, Pages Functions and the local server.
import { ApiError, newId, safeEqual, clean, mustInt, DAY, int, clampLimit, periodOf, jsonOut as out, parseBody as parse, sameOrigin } from './util.js';
import { PRODUCT, DEFAULTS, providerCapWarnings, settingsOf, SQUARES, TOKENS, HIDE_NAME_NOTICE } from './config.js';
import { commit, commitMany, verifyChain } from './audit.js';
import * as P from './people.js';
import * as S from './setup.js';
import * as E from './events.js';
import * as B from './board.js';
import * as Pen from './penalty.js';
import * as R from './rewards.js';
import * as AI from './aiapi.js';
import { settleCompany, simulateBudget, countFor, tiersOf } from './periods.js';
import { ProviderError } from './provider/errors.js';
import { shopOn, buyOn, assertBuy } from './v1.js';
import { openOps, retryOps } from './provider-ops.js';
import { makeBudget, budgetLimit, withBudget, BudgetReached, coalescingDb, batchGate, invocationLimit } from './budget.js';
import { rowsSoftLimit } from './settle_bounded.js';

const MAX_BODY = 1_500_000;

/** Reads the body with a hard size limit. The declared length is checked first; a body with no declared length is cut off while it streams. */
async function readBody(req) {
  const tooBig = () => new ApiError(413, 'too_big', 'Request is too large.');
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY) throw tooBig();
  if (!req.body) return '';
  const reader = req.body.getReader(), chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_BODY) { await reader.cancel().catch(() => {}); throw tooBig(); }
    chunks.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return new TextDecoder().decode(all);
}
const cookieOf = (req, name) => (req.headers.get('cookie') ?? '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1];
const ipOf = (req) => req.headers.get('cf-connecting-ip') || (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || null;

/** Older signed system routes: check the signature, the rate limit and that the key class is allowed. */
async function signed(ctx, req, raw, allowed) {
  const { key, company } = await AI.verifySigned(ctx, req, raw);
  await AI.rateLimit(ctx, key);
  if (!AI.scopeAllows(key.scope, allowed)) throw new ApiError(403, 'scope_denied', `A ${key.scope} key may not call this route.`);
  return company;
}

const need = (user, ...roles) => { if (!roles.includes(user.role)) throw new ApiError(403, 'not_allowed', 'You cannot do this.'); };
const idOf = (m) => m[1];

/** Who may look at one person's detail? Self; the team's manager; the company admin; HR only for a person with an open case. Every look at someone else is logged. */
async function mayView(ctx, company, viewer, person) {
  if (viewer.id === person.id) return true;
  let ok = false;
  if (viewer.role === 'admin') ok = true;
  else if (viewer.role === 'manager') ok = !!person.team_id && (await ctx.db.first('SELECT manager_id FROM team WHERE id = ?', person.team_id))?.manager_id === viewer.id;
  else if (viewer.role === 'hr') ok = !!(await ctx.db.first("SELECT id FROM penalty_case WHERE person_id = ? AND state IN ('proposed','pending','appealed')", person.id)) || !!(await ctx.db.first("SELECT id FROM event WHERE person_id = ? AND status = 'reversal_pending'", person.id));
  if (ok) await commit(ctx, company.id, viewer.id, 'view.person', { person: person.id });
  return ok;
}

function moneyView(company, credits) {
  const s = settingsOf(company);
  const usd = credits / s.credits_per_usd;
  return { credits, unit: s.unit_name, symbol: s.unit_symbol, usd: Math.round(usd * 100) / 100, local: { currency: s.local_currency, amount: Math.round(usd * s.local_per_usd * 100) / 100, display_only: true } };
}

/** The person's own data, as they hold it. */
const personExport = async (ctx, company, user) => ({
  profile: await P.privateUser(ctx, user),
  consents: await ctx.db.all('SELECT kind, version, at FROM consent WHERE user_id = ?', user.id),
  events: await ctx.db.all('SELECT event_type, stage, ext_id, occurred_at, status, reason FROM event WHERE person_id = ?', user.id),
  rewards: await ctx.db.all('SELECT kind, amount, state, created_at, period_key FROM reward WHERE person_id = ?', user.id),
  penalties: await ctx.db.all("SELECT effect, amount, reason, state, decision_note FROM penalty_case WHERE person_id = ? AND state != 'proposed'", user.id),
  board: await B.getBoard(ctx, company, user.id),
});

/** The bonus roll of an event, shown to the person: the die and the percentage it gave. Same server-side die as the grant. */
const rollOf = async (ctx, company, personId, eventId) => {
  const st = settingsOf(company), d = await B.die(ctx, personId, eventId, 99);
  return { die: d, pct: B.bonusPct(st.bonus_floor_pct, st.bonus_max_pct, d) };
};

const routes = [];
/** Every route the app serves, for the route-crawler test: [{method, path}] (the signed system routes and the /api/v1 table are listed too). */
export const listRoutes = () => [...routes.map((r) => ({ method: r.method, path: r.pattern, kind: 'session' })), ...sysRoutes.map((r) => ({ method: r[0], path: r[1], kind: 'signed' }))];
const route = (method, pattern, fn) => routes.push({ method, pattern, re: new RegExp('^' + pattern.replace(/:id/g, '([A-Za-z0-9_\\-]+)') + '$'), fn });

// ---------- open ----------
route('GET', '/api/health', async (c) => ({ ok: true, product: PRODUCT.slug, db: !!(await c.ctx.db.first('SELECT 1 x')) }));
route('GET', '/api/config', async (c) => {
  // Open to everyone. When the caller is signed in, the answer carries their company's own names and links.
  const a = await P.authenticate(c.ctx, c.token).catch(() => null);
  const s = a ? settingsOf(a.company) : { ...DEFAULTS, terms_url: /^https:\/\/\S{1,290}$/.test(c.ctx.env.TERMS_URL ?? '') ? c.ctx.env.TERMS_URL : '' };
  return {
    product_name: a ? s.product_name : PRODUCT.name, tagline: PRODUCT.tagline, footer: PRODUCT.footer, tokens: TOKENS,
    unit_name: s.unit_name, unit_symbol: s.unit_symbol, credits_per_usd: s.credits_per_usd, local_currency: s.local_currency, local_per_usd: s.local_per_usd,
    terms_url: s.terms_url || null, hide_name_notice: HIDE_NAME_NOTICE,
  };
});
route('POST', '/api/auth/request-code', async (c) => P.requestCode(c.ctx, c.body.email, c.env.mailer, { ip: c.ip }));
route('POST', '/api/auth/login', async (c) => {
  const { token, user } = await P.login(c.ctx, c.body.email, c.body.code, { ip: c.ip });
  c.setCookie = `floor_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${12 * 3600}`;
  return { ok: true, role: user.role };
});
route('POST', '/api/auth/logout', async (c) => {
  await P.logout(c.ctx, c.token);
  c.setCookie = 'floor_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0';
  return { ok: true };
});

// ---------- me ----------
route('GET', '/api/me', async (c) => {
  const s = settingsOf(c.company);
  return {
    user: await P.privateUser(c.ctx, c.user), consents: await P.consentsOf(c.ctx, c.user), consent_version: P.CONSENT_VERSION,
    company: { name: c.company.name, product_name: s.product_name, unit_name: s.unit_name, unit_symbol: s.unit_symbol, credits_per_usd: s.credits_per_usd, local_currency: s.local_currency, local_per_usd: s.local_per_usd, terms_url: s.terms_url || null, mode: s.mode, leaderboard: s.leaderboard, live: !!c.company.live, provider: c.company.provider },
    hide_name_notice: HIDE_NAME_NOTICE,
  };
});
route('POST', '/api/me/consent', async (c) => { await P.recordConsent(c.ctx, c.company, c.user, c.body.kind, c.body.accepted); return { ok: true }; });
route('PUT', '/api/me/profile', async (c) => { await P.updateProfile(c.ctx, c.company, c.user, c.body); return { ok: true }; });
/** Correct your own details (name, work id, e-mail). */
route('PUT', '/api/me/details', async (c) => P.correctDetails(c.ctx, c.company, c.user, c.user.id, c.body));
route('GET', '/api/me/balance', async (c) => {
  const prov = c.ctx.provider(c.company);
  try {
    const b = await prov.getBalance({ accountRef: await R.accountRef(c.ctx, c.company, c.user) });
    return { ...moneyView(c.company, b.balance), spendable: b.spendable, next_expiry_at: b.next_expiry_at, cached: false };
  } catch (e) { if (e instanceof ProviderError) throw new ApiError(502, e.code, 'The credit service is not available right now.'); throw e; }
});
route('GET', '/api/me/board', async (c) => B.getBoard(c.ctx, c.company, c.user.id));
route('GET', '/api/me/events', async (c) => {
  const rows = await c.ctx.db.all('SELECT id, event_type, stage, occurred_at, status, reason, approvals_required, approvals_done, source FROM event WHERE company_id = ? AND person_id = ? ORDER BY created_at DESC LIMIT 100', c.company.id, c.user.id);
  return { events: rows.map((r) => ({ ...r, why: r.status === 'rejected' ? (r.reason ?? 'not counted') : undefined })) };
});
route('GET', '/api/me/rewards', async (c) => ({
  rewards: await Promise.all((await c.ctx.db.all("SELECT id, kind, amount, sent_amount, state, created_at, event_id, rate_version, period_key FROM reward WHERE company_id = ? AND person_id = ? AND state != 'void' ORDER BY created_at DESC LIMIT 200", c.company.id, c.user.id)).map(async (r) => ({ ...r, ...moneyView(c.company, r.amount), ...(r.kind === 'bonus_roll' && r.event_id ? { roll: await rollOf(c.ctx, c.company, c.user.id, r.event_id) } : {}) }))),
  corrections: await c.ctx.db.all("SELECT id, amount, recovered, state, reason FROM correction WHERE company_id = ? AND person_id = ? AND state IN ('open','frozen')", c.company.id, c.user.id),
}));
route('GET', '/api/me/targets', async (c) => {
  const s = settingsOf(c.company), now = c.ctx.now();
  // Targets, all their tiers and the person's count per target in ONE round trip.
  const [ts, tiers] = await c.ctx.db.reads([["SELECT * FROM period_target WHERE company_id = ? AND scope = 'person'", c.company.id], ['SELECT t.* FROM tier t JOIN period_target pt ON pt.id = t.target_id WHERE pt.company_id = ? ORDER BY t.target_id, t.idx', c.company.id]]);
  const ps = ts.map((t) => periodOf(t.period, now, s.fy_start_month));
  const counts = ts.length ? await c.ctx.db.reads(ts.map((t, i) => ["SELECT COUNT(*) n FROM event WHERE company_id=? AND person_id=? AND event_type=? AND stage=? AND status IN ('applied','reversal_pending') AND occurred_at >= ? AND occurred_at < ?", c.company.id, c.user.id, t.event_type, t.stage, t.active_from ? Math.max(ps[i].start, t.active_from) : ps[i].start, ps[i].end])) : [];
  return { targets: ts.map((t, i) => ({ id: t.id, name: t.name, period: t.period, period_key: ps[i].key, ends_at: ps[i].end, count: counts[i][0].n, tiers: tiers.filter((x) => x.target_id === t.id).map((x) => ({ count: x.count, bonus: x.bonus })) })) };
});
route('GET', '/api/me/penalties', async (c) => ({ cases: await c.ctx.db.all("SELECT id, effect, amount, reason, state, apply_at, appeal_by, decision_note FROM penalty_case WHERE person_id = ? AND state != 'proposed' ORDER BY created_at DESC", c.user.id) }));
route('POST', '/api/me/rights', async (c) => {
  const kind = ['access', 'correction', 'end_use'].includes(c.body.kind) ? c.body.kind : null;
  if (!kind) throw new ApiError(400, 'bad_kind', 'Kind is access, correction or end_use.');
  const id = newId('rr');
  await commit(c.ctx, c.company.id, c.user.id, 'rights.request', { id, kind }, [['INSERT INTO rights_request (id, company_id, person_id, kind, note, created_at) VALUES (?,?,?,?,?,?)', id, c.company.id, c.user.id, kind, clean(c.body.note, 300), c.ctx.now()]]);
  return { id };
});
route('GET', '/api/me/export', async (c) => personExport(c.ctx, c.company, c.user));
route('GET', '/api/shop/items', async (c) => (shopOn(c.ctx.env, c.company) ? { enabled: true, items: await c.ctx.db.all('SELECT id, name, credits, needs_approval FROM catalogue_item WHERE company_id = ? AND active = 1', c.company.id) } : { enabled: false, items: [], note: 'The shop is not enabled in v1.' }));
route('POST', '/api/shop/order', async (c) => S.placeOrder(c.ctx, c.company, c.user, c.body.item_id));
route('GET', '/api/shop/orders', async (c) => ({ orders: await c.ctx.db.all('SELECT id, item_id, credits, state, created_at FROM catalogue_order WHERE person_id = ? ORDER BY created_at DESC', c.user.id) }));

// ---------- game ----------
route('POST', '/api/board/claim', async (c) => B.claimDesk(c.ctx, c.company, c.user, c.body.desk_id));
route('POST', '/api/board/upgrade', async (c) => B.upgradeDesk(c.ctx, c.company, c.user, c.body.desk_id));
route('POST', '/api/board/reset', async (c) => B.resetBoard(c.ctx, c.company, c.user.id));
route('POST', '/api/swaps', async (c) => B.offerSwap(c.ctx, c.company, c.user, { toPersonId: c.body.to_person_id, deskFrom: c.body.desk_from, deskTo: c.body.desk_to, helpText: c.body.help_text }));
route('POST', '/api/swaps/:id/answer', async (c, m) => B.answerSwap(c.ctx, c.company, c.user, idOf(m), c.body.accept === true));
route('GET', '/api/swaps', async (c) => ({ offers: await c.ctx.db.all("SELECT id, from_person, desk_from, desk_to, help_text, state FROM swap_offer WHERE company_id = ? AND (to_person = ? OR from_person = ?) ORDER BY created_at DESC LIMIT 50", c.company.id, c.user.id, c.user.id) }));
route('GET', '/api/team/board', async (c) => {
  need(c.user, 'manager', 'admin', 'hr');
  const q = c.url.searchParams.get('team_id');
  let team;
  if (c.user.role === 'manager') team = await c.ctx.db.first('SELECT * FROM team WHERE company_id = ? AND manager_id = ?', c.company.id, c.user.id);
  else team = await c.ctx.db.first('SELECT * FROM team WHERE company_id = ? AND id = ?', c.company.id, q ?? '');
  if (!team) throw new ApiError(404, 'no_team', 'No such team.');
  if (c.user.role === 'hr') throw new ApiError(403, 'not_allowed', 'HR sees aggregates, not a team board.');
  const { limit, offset } = PAGE(c.url);
  // Members, their tokens and the pool in ONE round trip (a person without a board yet is shown at the start; the board row is made when the person first plays).
  const [members, [pool]] = await c.ctx.db.reads([
    ["SELECT u.id, u.name_sealed, u.hide_name, u.avatar, b.position, b.level, b.laps FROM app_user u LEFT JOIN board_state b ON b.person_id = u.id WHERE u.company_id = ? AND u.team_id = ? AND u.status = 'active' ORDER BY u.id LIMIT ? OFFSET ?", c.company.id, team.id, limit + 1, offset],
    ['SELECT points FROM pool WHERE company_id = ? AND team_id = ?', c.company.id, team.id],
  ]);
  const tokens = [];
  for (const u of members.slice(0, limit)) tokens.push({ id: u.id, name: await P.displayName(c.ctx, u), avatar: u.avatar, position: u.position ?? 0, level: u.level ?? 1, laps: u.laps ?? 0 });
  return { team: { id: team.id, name: team.name }, squares: SQUARES, tokens, pool_points: pool?.points ?? 0, next_offset: members.length > limit ? offset + limit : null, page_size: limit };
});
/** Team-vs-team league: ranked by verified achievement per head, so small teams are not punished. Visible by role and setting. */
route('GET', '/api/league', async (c) => {
  const s = settingsOf(c.company);
  if (c.user.role === 'employee' && !s.leaderboard) throw new ApiError(403, 'leaderboard_off', 'The leaderboard is switched off for this company.');
  const p = periodOf(c.url.searchParams.get('period') === 'week' ? 'week' : 'month', c.ctx.now(), s.fy_start_month);
  // Heads and achievements of EVERY team in one round trip (two grouped queries), never two queries per team.
  const [teams, heads, evs] = await c.ctx.db.reads([
    ['SELECT id, name FROM team WHERE company_id = ?', c.company.id],
    ["SELECT team_id, COUNT(*) n FROM app_user WHERE company_id = ? AND team_id IS NOT NULL AND status = 'active' GROUP BY team_id", c.company.id],
    ["SELECT u.team_id, COUNT(*) n FROM event e JOIN app_user u ON u.id = e.person_id WHERE e.company_id = ? AND u.team_id IS NOT NULL AND e.status = 'applied' AND e.occurred_at >= ? AND e.occurred_at < ? GROUP BY u.team_id", c.company.id, p.start, p.end],
  ]);
  const headOf = new Map(heads.map((r) => [r.team_id, r.n])), evOf = new Map(evs.map((r) => [r.team_id, r.n]));
  const rows = teams.map((t) => { const head = headOf.get(t.id) ?? 0, ev = evOf.get(t.id) ?? 0; return { team_id: t.id, team: t.name, members: head, achievements: ev, per_head: head ? Math.round((ev / head) * 100) / 100 : 0 }; });
  rows.sort((a, b) => b.per_head - a.per_head);
  let ranked = rows.map((r, i) => ({ ...r, rank: i + 1 }));
  if (c.user.role === 'manager') ranked = ranked.filter((r) => r.team_id === c.user.team_id || true).map((r) => (r.team_id === c.user.team_id ? r : { rank: r.rank, team: r.team, per_head: r.per_head })); // a manager sees own team's detail only
  if (c.user.role === 'employee') ranked = ranked.map((r) => ({ rank: r.rank, team: r.team, per_head: r.per_head }));
  return { period: p.key, league: ranked };
});

// ---------- events ----------
route('POST', '/api/events', async (c) => {
  need(c.user, 'manager', 'admin', 'hr', 'employee');
  const r = await E.submitEvent(c.ctx, c.company, c.user, { ...c.body, source: c.user.role === 'employee' ? 'request' : 'manual' });
  if (r.ok && r.id && await c.ctx.db.first("SELECT id FROM reward WHERE event_id = ? AND kind = 'bonus_roll'", r.id)) r.roll = await rollOf(c.ctx, c.company, (await c.ctx.db.first('SELECT person_id FROM event WHERE id = ?', r.id)).person_id, r.id);
  return r;
});
route('POST', '/api/events/csv', async (c) => { need(c.user, 'manager', 'admin', 'hr'); return E.importCsv(c.ctx, c.company, c.user, String(c.body.csv ?? ''), { commit: c.body.commit === true, fromRow: c.body.from_row }); });
const PAGE = (url, def = 50, max = 100) => ({ limit: clampLimit(url.searchParams.get('limit'), def, max), offset: Math.max(0, Math.min(1e6, Math.trunc(Number(url.searchParams.get('offset'))) || 0)) });
route('GET', '/api/events', async (c) => {
  need(c.user, 'manager', 'admin', 'hr');
  const status = c.url.searchParams.get('status');
  const { limit, offset } = PAGE(c.url);
  const where = ['e.company_id = ?'], p = [c.company.id];
  if (status) { where.push('e.status = ?'); p.push(status); }
  if (c.user.role === 'manager') { where.push('u.team_id IN (SELECT id FROM team WHERE manager_id = ?)'); p.push(c.user.id); }
  const page = await c.ctx.db.all(`SELECT e.id, e.person_id, e.event_type, e.stage, e.ext_id, e.occurred_at, e.status, e.source, e.approvals_required, e.approvals_done, e.submitted_by, e.reason, e.reversal_kind, e.reversal_due, e.reversal_appeal FROM event e JOIN app_user u ON u.id = e.person_id WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC, e.id LIMIT ? OFFSET ?`, ...p, limit + 1, offset);
  const rows = page.slice(0, limit), next_offset = page.length > limit ? offset + limit : null;
  // Managers and admin see real names (their job needs it; the notice says so). HR sees person ids only, and a name only for a person
  // with an open case, and every such look is written to the audit trail. The people and the open cases of a whole page are read in ONE round trip.
  const names = new Map();
  const ids = [...new Set(rows.map((r) => r.person_id))];
  if (ids.length) {
    const marks = ids.map(() => '?').join(',');
    const [people, cases, reversals] = await c.ctx.db.reads([
      [`SELECT * FROM app_user WHERE id IN (${marks})`, ...ids],
      ...(c.user.role === 'hr' ? [[`SELECT DISTINCT person_id FROM penalty_case WHERE person_id IN (${marks}) AND state IN ('proposed','pending','appealed')`, ...ids], [`SELECT DISTINCT person_id FROM event WHERE person_id IN (${marks}) AND status = 'reversal_pending'`, ...ids]] : []),
    ]);
    const open = new Set([...(cases ?? []), ...(reversals ?? [])].map((r) => r.person_id));
    const seen = [];
    for (const person of people) {
      if (c.user.role !== 'hr') { names.set(person.id, await P.displayName(c.ctx, person, { forceReal: true })); continue; }
      if (open.has(person.id)) { names.set(person.id, await P.displayName(c.ctx, person, { forceReal: true })); seen.push({ action: 'view.person', data: { person: person.id, via: 'events' } }); }
    }
    await commitMany(c.ctx, c.company.id, c.user.id, seen); // one batch, one audit line per person looked at
  }
  return { events: rows.map((r) => (names.has(r.person_id) ? { ...r, person: names.get(r.person_id) } : { ...r })), next_offset, page_size: limit };
});
route('POST', '/api/events/:id/approve', async (c, m) => E.approveEvent(c.ctx, c.company, c.user, idOf(m)));
route('POST', '/api/events/:id/reject', async (c, m) => E.rejectEvent(c.ctx, c.company, c.user, idOf(m), c.body.reason));
route('POST', '/api/events/:id/reverse', async (c, m) => E.requestReversal(c.ctx, c.company, c.user, idOf(m), { reason: c.body.reason, kind: c.body.kind }));
route('POST', '/api/events/:id/reverse/approve', async (c, m) => E.approveReversal(c.ctx, c.company, c.user, idOf(m)));
route('POST', '/api/events/:id/reverse/appeal', async (c, m) => E.appealReversal(c.ctx, c.company, c.user, idOf(m)));
route('POST', '/api/events/:id/reverse/decide', async (c, m) => {
  const ev = await c.ctx.db.first('SELECT person_id FROM event WHERE id = ? AND company_id = ?', idOf(m), c.company.id);
  if (ev && ev.person_id === c.user.id) throw new ApiError(403, 'not_allowed', 'You cannot decide an appeal about your own event.');
  return E.decideReversalAppeal(c.ctx, c.company, c.user, idOf(m), c.body.uphold === true);
});

// ---------- penalties ----------
route('POST', '/api/penalties', async (c) => Pen.proposePenalty(c.ctx, c.company, c.user, c.body));
route('GET', '/api/penalties', async (c) => {
  need(c.user, 'manager', 'admin', 'hr');
  const rows = await c.ctx.db.all(c.user.role === 'manager'
    ? 'SELECT p.* FROM penalty_case p JOIN app_user u ON u.id = p.person_id JOIN team t ON t.id = u.team_id WHERE p.company_id = ? AND t.manager_id = ? ORDER BY p.created_at DESC LIMIT 100'
    : 'SELECT p.* FROM penalty_case p WHERE p.company_id = ? AND ? IS NOT NULL ORDER BY p.created_at DESC LIMIT 100', c.company.id, c.user.id);
  return { cases: rows.map((r) => ({ id: r.id, person_id: r.person_id, effect: r.effect, amount: r.amount, reason: r.reason, state: r.state, appeal_level: r.appeal_level, apply_at: r.apply_at })) };
});
route('POST', '/api/penalties/:id/approve', async (c, m) => Pen.approvePenalty(c.ctx, c.company, c.user, idOf(m)));
route('POST', '/api/penalties/:id/reject', async (c, m) => Pen.rejectPenalty(c.ctx, c.company, c.user, idOf(m), c.body.note));
route('POST', '/api/penalties/:id/appeal', async (c, m) => Pen.appealPenalty(c.ctx, c.company, c.user, idOf(m)));
route('POST', '/api/penalties/:id/decide', async (c, m) => {
  const pc = await c.ctx.db.first('SELECT person_id FROM penalty_case WHERE id = ? AND company_id = ?', idOf(m), c.company.id);
  if (pc && pc.person_id === c.user.id) throw new ApiError(403, 'not_allowed', 'You cannot decide your own appeal.');
  if (pc && c.user.role === 'manager') { // a manager reviews only people they manage
    const p = await c.ctx.db.first('SELECT team_id FROM app_user WHERE id = ?', pc.person_id);
    const team = p?.team_id && await c.ctx.db.first('SELECT manager_id FROM team WHERE id = ?', p.team_id);
    if (!team || team.manager_id !== c.user.id) throw new ApiError(403, 'not_allowed', 'This appeal is not for you to review.');
  }
  return Pen.decideAppeal(c.ctx, c.company, c.user, idOf(m), c.body.for_person === true, c.body.note);
});
route('POST', '/api/lane/:id/finish', async (c, m) => {
  need(c.user, 'manager', 'hr', 'admin');
  if (c.user.role === 'manager') { // a manager clears tasks of their own team only
    const t = await c.ctx.db.first('SELECT person_id FROM lane_task WHERE id = ? AND company_id = ?', idOf(m), c.company.id);
    const p = t && await c.ctx.db.first('SELECT team_id FROM app_user WHERE id = ?', t.person_id);
    const team = p?.team_id && await c.ctx.db.first('SELECT manager_id FROM team WHERE id = ?', p.team_id);
    if (!team || team.manager_id !== c.user.id) throw new ApiError(403, 'not_allowed', 'You can only clear tasks for your own team.');
  }
  await B.finishLaneTask(c.ctx, c.company, idOf(m), c.user.id);
  return { ok: true };
});

// ---------- people (manager / admin / hr views) ----------
route('GET', '/api/people', async (c) => {
  need(c.user, 'manager', 'admin', 'hr');
  const { limit, offset } = PAGE(c.url);
  const rows = await c.ctx.db.all(c.user.role === 'manager'
    ? "SELECT u.* FROM app_user u JOIN team t ON t.id = u.team_id WHERE u.company_id = ? AND t.manager_id = ? AND u.status = 'active' ORDER BY u.id LIMIT ? OFFSET ?"
    : "SELECT * FROM app_user WHERE company_id = ? AND ? IS NOT NULL AND status = 'active' ORDER BY id LIMIT ? OFFSET ?", c.company.id, c.user.id, limit + 1, offset);
  const people = [];
  for (const u of rows.slice(0, limit)) people.push(c.user.role === 'hr' ? { id: u.id, team_id: u.team_id, role: u.role } : await P.privateUser(c.ctx, u).then(({ work_id, ...x }) => ({ ...x, work_id })));
  return { people, next_offset: rows.length > limit ? offset + limit : null, page_size: limit };
});
route('GET', '/api/people/:id/summary', async (c, m) => {
  const person = await c.ctx.db.first('SELECT * FROM app_user WHERE id = ? AND company_id = ?', idOf(m), c.company.id);
  if (!person || !(await mayView(c.ctx, c.company, c.user, person))) throw new ApiError(403, 'not_allowed', 'You cannot see this person.');
  const mk = periodOf('month', c.ctx.now()).key;
  const { resets, ...boardView } = await B.getBoard(c.ctx, c.company, person.id); // board resets are the person's own business (design 4A.8)
  return { person: await P.publicUser(c.ctx, person, { forceReal: true }), board: person.id === c.user.id ? { ...boardView, resets } : boardView, earned_this_month: moneyView(c.company, await R.earnedNet(c.ctx, c.company.id, person.id, mk)) };
});
route('GET', '/api/team/contributions', async (c) => {
  need(c.user, 'manager', 'admin');
  const s = settingsOf(c.company), p = periodOf('month', c.ctx.now(), s.fy_start_month);
  const { limit, offset } = PAGE(c.url);
  const teamQ = c.user.role === 'manager' ? 'AND t.manager_id = ?' : 'AND ? IS NOT NULL';
  // The name comes with the row (one query for the page), and a page holds at most `limit` people.
  const rows = await c.ctx.db.all(`SELECT u.id, u.name_sealed, u.hide_name, COUNT(e.id) n FROM app_user u JOIN team t ON t.id = u.team_id LEFT JOIN event e ON e.person_id = u.id AND e.status = 'applied' AND e.occurred_at >= ? AND e.occurred_at < ? WHERE u.company_id = ? ${teamQ} GROUP BY u.id ORDER BY u.id LIMIT ? OFFSET ?`, p.start, p.end, c.company.id, c.user.id, limit + 1, offset);
  const res = [];
  for (const r of rows.slice(0, limit)) res.push({ person: await P.displayName(c.ctx, r, { forceReal: true }), events: r.n });
  return { period: p.key, contributions: res, next_offset: rows.length > limit ? offset + limit : null, page_size: limit };
});

// ---------- admin ----------
const adm = (c) => need(c.user, 'admin');
route('GET', '/api/admin/settings', async (c) => { adm(c); return { settings: settingsOf(c.company), provider: c.company.provider, live: !!c.company.live, capabilities: await c.ctx.provider(c.company).capabilities().catch(() => null) }; });
route('PUT', '/api/admin/settings', async (c) => { adm(c); return { settings: await P.updateSettings(c.ctx, c.company, c.user, c.body) }; });
route('GET', '/api/admin/teams', async (c) => { adm(c); return { teams: await c.ctx.db.all('SELECT id, name, manager_id FROM team WHERE company_id = ?', c.company.id) }; });
route('POST', '/api/admin/teams', async (c) => { adm(c); return S.createTeam(c.ctx, c.company, c.user, c.body); });
route('POST', '/api/admin/people', async (c) => { adm(c); const { user, code } = await P.addPerson(c.ctx, c.company, c.user, c.body); return { id: user.id, invite_code: code, note: 'Give this code to the person. It is shown once and works for 7 days.' }; });
route('POST', '/api/admin/people/:id/team', async (c, m) => { adm(c); await S.assignTeam(c.ctx, c.company, c.user, idOf(m), c.body.team_id ?? null); return { ok: true }; });
route('POST', '/api/admin/people/:id/code', async (c, m) => {
  adm(c);
  const u = await c.ctx.db.first("SELECT * FROM app_user WHERE id = ? AND company_id = ? AND status = 'active'", idOf(m), c.company.id);
  if (!u) throw new ApiError(404, 'no_person', 'No such person.');
  await commit(c.ctx, c.company.id, c.user.id, 'person.code', { person: u.id });
  return { code: await P.issueCode(c.ctx, u, 7 * DAY), note: 'Shown once. It works for 7 days.' };
});
route('POST', '/api/admin/people/:id/remove', async (c, m) => {
  adm(c);
  if (idOf(m) === c.user.id) throw new ApiError(409, 'self', 'You cannot remove yourself.');
  const r = await commit(c.ctx, c.company.id, c.user.id, 'person.remove', { person: idOf(m) }, [["UPDATE app_user SET status = 'left', left_at = ? WHERE id = ? AND company_id = ?", c.ctx.now(), idOf(m), c.company.id]]);
  if (r[0].changes > 0) await c.ctx.db.run('DELETE FROM session WHERE user_id = ? AND company_id = ?', idOf(m), c.company.id);
  return { ok: r[0].changes > 0 };
});
route('POST', '/api/admin/people/csv', async (c) => {
  adm(c);
  const rows = (await import('./events.js')).parseCsv(String(c.body.csv ?? ''), 2000), res = [];
  // A commit works through the rows until the invocation budget is used and answers { more, next_row }: send the same file again with from_row = next_row (whole rows only).
  const gate = batchGate(c.ctx), from = Math.max(0, Math.trunc(Number(c.body.from_row)) || 0);
  let more = false, next_row = null;
  for (const [i, r] of rows.entries()) {
    if (c.body.commit !== true) { res.push({ email_ok: !!r.work_email, name: r.name }); continue; }
    if (i + 2 < from) continue;
    if (!gate.canTake()) { more = true; next_row = i + 2; break; }
    gate.begin();
    try { const { user, code } = await P.addPerson(c.ctx, c.company, c.user, { email: r.work_email, name: r.name, work_id: r.work_id, role: ['manager', 'hr', 'employee'].includes(r.role) ? r.role : 'employee', team_id: r.team_id || null }); res.push({ ok: true, id: user.id, invite_code: code }); }
    catch (e) { res.push({ ok: false, reason: e.code ?? 'error' }); }
    finally { gate.end(); }
  }
  return { committed: c.body.commit === true, rows: res, more, next_row };
});
route('GET', '/api/admin/rate-card', async (c) => { adm(c); return { rows: await c.ctx.db.all('SELECT * FROM rate_card WHERE company_id = ? ORDER BY event_type, stage_no, version DESC', c.company.id) }; });
route('POST', '/api/admin/rate-card', async (c) => { adm(c); return S.addRateCard(c.ctx, c.company, c.user, c.body); });
route('GET', '/api/admin/targets', async (c) => {
  adm(c);
  const [ts, tiers, streaks] = await c.ctx.db.reads([
    ['SELECT * FROM period_target WHERE company_id = ?', c.company.id],
    ['SELECT t.* FROM tier t JOIN period_target pt ON pt.id = t.target_id WHERE pt.company_id = ? ORDER BY t.target_id, t.idx', c.company.id],
    ['SELECT s.* FROM streak s JOIN period_target pt ON pt.id = s.target_id WHERE pt.company_id = ?', c.company.id],
  ]);
  for (const t of ts) { t.tiers = tiers.filter((x) => x.target_id === t.id); const st = streaks.find((x) => x.target_id === t.id); t.streak = st ? { length: st.length, bonus: st.bonus, freeze_per_quarter: st.freeze_per_quarter } : null; }
  return { targets: ts };
});
route('POST', '/api/admin/targets', async (c) => { adm(c); return S.addTarget(c.ctx, c.company, c.user, c.body); });
route('GET', '/api/admin/seasons', async (c) => { adm(c); return { seasons: await c.ctx.db.all('SELECT * FROM season WHERE company_id = ? ORDER BY starts_at DESC', c.company.id) }; });
route('POST', '/api/admin/seasons', async (c) => { adm(c); return S.createSeason(c.ctx, c.company, c.user, c.body); });
route('POST', '/api/admin/seasons/:id/publish', async (c, m) => { adm(c); return S.publishSeason(c.ctx, c.company, c.user, idOf(m)); });
route('POST', '/api/admin/seasons/:id/budget', async (c, m) => { adm(c); await S.raiseBudget(c.ctx, c.company, c.user, idOf(m), c.body.budget); return R.releaseWaiting(c.ctx, c.company); });
// The settle that an admin starts ("close now", a season close) is bounded like the clock: one call settles what fits in the invocation and answers { more: true } while work is left; call again until more is false.
async function settleRoute(c, force) {
  const lim = budgetLimit(c.ctx.env);
  if (lim <= 0) return settleCompany(c.ctx, c.company, c.ctx.now(), { force });
  const inv = invocationLimit(c.ctx.env);
  // the allowance never exceeds what is left of THIS invocation (what the request used before, a margin, and the bookkeeping below are taken off)
  const b = makeBudget(Math.max(4, Math.min(Math.max(lim, MIN_DRIVER_BUDGET), inv - (c.ctx.budget?.used ?? 0) - MARGIN) - 4)), t = withBudget(c.ctx, b);
  const r = await settleCompany(t, c.company, c.ctx.now(), { force });
  // the cursor is saved only when the settle really moved it (or finished the round): an unset cursor leaves the saved one alone, it is never overwritten with NULL
  if (b.settleCursorSet) { try { await c.ctx.db.run('INSERT INTO tick_state (company_id, settle_cursor) VALUES (?,?) ON CONFLICT (company_id) DO UPDATE SET settle_cursor = excluded.settle_cursor', c.company.id, b.settleCursor ?? null); } catch { /* the next call starts again from the saved cursor: the finished groups are cheap */ } }
  return { ...r, more: (b.backlog ?? 0) > 0 };
}
route('POST', '/api/admin/seasons/:id/close', async (c, m) => { adm(c); const r = await settleRoute(c, true); if (r.more) return { more: true, closed: false }; return S.closeSeason(c.ctx, c.company, c.user, idOf(m)); });
route('POST', '/api/admin/simulate', async (c) => { adm(c); return simulateBudget(c.ctx, c.company, { people: mustInt(c.body.people, 'people', { min: 1, max: 100000 }), perPerson: c.body.per_person ?? {} }); });
route('POST', '/api/admin/notes', async (c) => { adm(c); await S.addNoteCard(c.ctx, c.company, c.user, c.body); return { ok: true }; });
route('GET', '/api/admin/notes', async (c) => { adm(c); return { cards: await c.ctx.db.all('SELECT * FROM note_card WHERE company_id = ? ORDER BY order_no', c.company.id) }; });
route('POST', '/api/admin/desks', async (c) => { adm(c); return S.addDesk(c.ctx, c.company, c.user, c.body); });
route('POST', '/api/admin/pool', async (c) => { adm(c); await B.fundPool(c.ctx, c.company, c.body.team_id, int(c.body.points), c.user.id); return { ok: true }; });
route('POST', '/api/admin/penalty-rules', async (c) => { adm(c); return S.addPenaltyRule(c.ctx, c.company, c.user, c.body); });
route('GET', '/api/admin/penalty-rules', async (c) => { adm(c); return { rules: await c.ctx.db.all('SELECT id, event_type, effect, amount, published_at, active FROM penalty_rule WHERE company_id = ?', c.company.id) }; });
route('GET', '/api/admin/keys', async (c) => { adm(c); return { keys: await c.ctx.db.all('SELECT key_id, scope, scope AS class, label, status, created_at FROM company_key WHERE company_id = ?', c.company.id) }; });
/** Resolving a rights request does the work: access hands over the person's data, correction applies the corrected details, end_use removes and scrubs. */
route('POST', '/api/admin/rights/:id/resolve', async (c, m) => {
  need(c.user, 'admin', 'hr');
  const rr = await c.ctx.db.first("SELECT * FROM rights_request WHERE id = ? AND company_id = ? AND state = 'open'", idOf(m), c.company.id);
  if (!rr) return { ok: false };
  const person = await c.ctx.db.first('SELECT * FROM app_user WHERE id = ? AND company_id = ?', rr.person_id, c.company.id);
  let done = {};
  if (rr.kind === 'access') {
    if (c.user.role !== 'admin') throw new ApiError(403, 'not_allowed', "Only the company admin hands over a person's data.");
    done = { export: await personExport(c.ctx, c.company, person) };
  } else if (rr.kind === 'correction') {
    if (c.user.role !== 'admin') throw new ApiError(403, 'not_allowed', 'Only the company admin applies a correction.');
    if (!c.body.name && !c.body.work_id && !c.body.email) throw new ApiError(400, 'needs_details', 'Send the corrected name, work_id or email.');
    done = await P.correctDetails(c.ctx, c.company, c.user, person.id, c.body);
  } else if (rr.kind === 'end_use') {
    if (c.user.role !== 'admin') throw new ApiError(403, 'not_allowed', "Only the company admin ends a person's use.");
    if (person.id === c.user.id) throw new ApiError(409, 'self', 'You cannot end your own use. Ask another admin.');
    if (person.status === 'active') await commit(c.ctx, c.company.id, c.user.id, 'person.remove', { person: person.id, via: 'rights' }, [["UPDATE app_user SET status = 'left', left_at = ? WHERE id = ? AND company_id = ?", c.ctx.now(), person.id, c.company.id]]);
    done = await P.eraseLeaver(c.ctx, c.company, c.user, person.id);
  }
  const r = await commit(c.ctx, c.company.id, c.user.id, 'rights.resolve', { id: rr.id, kind: rr.kind }, [["UPDATE rights_request SET state = 'done' WHERE id = ? AND company_id = ? AND state = 'open'", rr.id, c.company.id]]);
  return { ok: r[0].changes > 0, kind: rr.kind, result: done, retention_note: P.RETENTION_NOTE };
});
route('POST', '/api/admin/people/:id/erase', async (c, m) => P.eraseLeaver(c.ctx, c.company, c.user, idOf(m)));
route('GET', '/api/admin/retention', async (c) => { need(c.user, 'admin', 'hr'); return P.retentionDue(c.ctx, c.company); });

// ---------- AI access: switches and the human decision on proposals ----------
const aiStatus = async (c) => {
  adm(c);
  return { ai_enabled: settingsOf(c.company).ai_enabled === true, switches: await AI.switchesOf(c.ctx, c.company), pending: (await c.ctx.db.first("SELECT COUNT(*) n FROM ai_request WHERE company_id = ? AND status = 'pending' AND expires_at > ?", c.company.id, c.ctx.now())).n, keys: await c.ctx.db.all("SELECT key_id, scope, label, status, created_at FROM company_key WHERE company_id = ? AND scope = 'ai_read'", c.company.id), ask_only: 'AI keys can read summaries and ask. Only you decide.' };
};
route('GET', '/api/admin/ai', aiStatus);
route('GET', '/api/admin/ai/status', aiStatus);
route('POST', '/api/admin/ai/toggle', async (c) => { adm(c); return AI.setAiEnabled(c.ctx, c.company, c.user, c.body.enabled === true); });
route('GET', '/api/admin/ai-requests', async (c) => { adm(c); return AI.listRequests(c.ctx, c.company, { status: c.url.searchParams.get('status'), limit: clampLimit(c.url.searchParams.get('limit'), 100, 200) }); });
route('POST', '/api/admin/ai-requests/:id/decide', async (c, m) => { adm(c); return AI.decideRequest(c.ctx, c.company, c.user, idOf(m), c.body.accept === true); });
route('POST', '/api/admin/ai-requests/:id/cancel', async (c, m) => { adm(c); return AI.cancelRequest(c.ctx, c.company, c.user, idOf(m)); });
route('POST', '/api/admin/penalty-rules/:id/publish', async (c, m) => { adm(c); await S.publishPenaltyRule(c.ctx, c.company, c.user, idOf(m)); return { ok: true }; });
route('POST', '/api/admin/keys', async (c) => { adm(c); return S.createKey(c.ctx, c.company, c.user, c.body); });
route('POST', '/api/admin/keys/:id/reissue', async (c, m) => { adm(c); return S.reissueKey(c.ctx, c.company, c.user, idOf(m)); });
route('POST', '/api/admin/keys/:id/revoke', async (c, m) => { adm(c); await S.revokeKey(c.ctx, c.company, c.user, idOf(m)); return { ok: true }; });
route('POST', '/api/admin/items', async (c) => { adm(c); return S.addItem(c.ctx, c.company, c.user, c.body); });
route('GET', '/api/admin/orders', async (c) => { need(c.user, 'admin', 'hr'); return { orders: await c.ctx.db.all('SELECT id, person_id, item_id, credits, state, created_at FROM catalogue_order WHERE company_id = ? ORDER BY created_at DESC LIMIT 100', c.company.id) }; });
route('POST', '/api/admin/orders/:id/decide', async (c, m) => S.decideOrder(c.ctx, c.company, c.user, idOf(m), c.body.accept === true));
// Starts a purchase at the credit provider (the provider's own page does the paying). This product moves no money and stores no balance.
route('POST', '/api/admin/buy', async (c) => {
  adm(c);
  assertBuy(c.ctx.env, c.company);
  const prov = c.ctx.provider(c.company);
  try { return await prov.startPurchase({ accountRef: await R.accountRef(c.ctx, c.company, c.user), credits: mustInt(c.body.credits, 'credits', { min: 100, max: 10_000_000 }), ref: 'buy:' + c.ctx.now(), idem: 'buy:' + (c.body.request_id ?? c.ctx.now()) }); }
  catch (e) { if (e instanceof ProviderError) throw new ApiError(409, e.code, e.message); throw e; }
});
route('POST', '/api/admin/settle', async (c) => { adm(c); return settleRoute(c, c.body.force === true); });
route('POST', '/api/admin/retry-ops', async (c) => { adm(c); return retryOps(c.ctx, c.company); });
route('POST', '/api/admin/retry-partials', async (c) => { adm(c); return R.retryPartialsNow(c.ctx, c.company); });
route('POST', '/api/admin/retry-handbacks', async (c) => { adm(c); return Pen.retryExhaustedHandbacks(c.ctx, c.company); });
route('POST', '/api/admin/reissue', async (c) => { adm(c); return R.reissueReward(c.ctx, c.company, c.user?.id ?? 'admin', { id: c.body?.id, confirm: c.body?.confirm, note: c.body?.note, ...(c.body && Object.hasOwn(c.body, 'amount') ? { amount: c.body.amount } : {}) }); });
route('GET', '/api/admin/needs-admin', async (c) => { adm(c); return R.needsAdmin(c.ctx, c.company, { limit: c.url?.searchParams?.get('limit') ?? c.query?.limit, offset: c.url?.searchParams?.get('offset') ?? c.query?.offset }); });
route('POST', '/api/admin/revive-failed', async (c) => { adm(c); return R.reviveFailedRewards(c.ctx, c.company, c.user?.id ?? 'admin', { force: c.body?.force === true }); });
route('POST', '/api/admin/tick', async (c) => { adm(c); return tick(c.ctx, c.company, { driver: true, turn: c.body?.turn ?? null }); });
route('GET', '/api/admin/audit', async (c) => {
  need(c.user, 'admin', 'hr');
  const limit = clampLimit(c.url.searchParams.get('limit'), 100, 500);
  const hide = c.user.role === 'hr' ? "AND action NOT IN ('board.reset')" : ''; // HR does not see board resets (design 4A.8)
  return { verify: await verifyChain(c.ctx.db, c.company.id), rows: await c.ctx.db.all(`SELECT n, actor, action, data, at FROM audit WHERE company_id = ? ${hide} ORDER BY n DESC LIMIT ?`, c.company.id, limit) };
});
const resolveAll = async (obj) => { const keys = Object.keys(obj), vals = await Promise.all(Object.values(obj)); return Object.fromEntries(keys.map((k, i) => [k, vals[i]])); };
route('GET', '/api/admin/overview', async (c) => {
  need(c.user, 'admin', 'hr');
  // Every read below is started at once on a database that gathers the statements of one round into ONE batch (one batch = ONE query for the per-invocation limit): the whole overview takes a handful of calls.
  const cx = Object.create(c.ctx); cx.db = coalescingDb(c.ctx.db);
  const q = (sql, ...p) => cx.db.first(sql, ...p).then((r) => r.n);
  const cid = c.company.id;
  const o = await resolveAll({
    last_ok: q('SELECT last_tick_ok_at n FROM company WHERE id = ?', cid),
    tick_state: cx.db.first('SELECT backlog, sweep_left, backlog_ticks, budget_small, rows_day, rows_read_day, rows_written_day, cold_day, cold_used FROM tick_state WHERE company_id = ?', cid),
    stage_errors: cx.db.all('SELECT stage, first_at, last_at, count FROM tick_stage WHERE company_id = ? AND count > 0 ORDER BY first_at', cid),
    people: q("SELECT COUNT(*) n FROM app_user WHERE company_id = ? AND status = 'active'", cid),
    events_pending: q("SELECT COUNT(*) n FROM event WHERE company_id = ? AND status IN ('pending','held')", cid),
    rewards_on_the_way: q("SELECT COUNT(*) n FROM reward WHERE company_id = ? AND state = 'queued'", cid),
    rewards_waiting_budget: q("SELECT COUNT(*) n FROM reward WHERE company_id = ? AND state = 'waiting'", cid),
    open_corrections: q("SELECT COUNT(*) n FROM correction WHERE company_id = ? AND state IN ('open','frozen')", cid),
    penalties_open: q("SELECT COUNT(*) n FROM penalty_case WHERE company_id = ? AND state IN ('proposed','pending','appealed')", cid),
    open_handbacks_failed: q("SELECT COUNT(*) n FROM penalty_case p WHERE p.company_id = ? AND p.state = 'reversed' AND p.applied_credits > 0 AND NOT EXISTS (SELECT 1 FROM reward r WHERE (r.idem_key = 'penrev:' || p.id OR r.idem_key LIKE 'penrev:' || p.id || ':g%') AND r.state != 'failed') AND (SELECT COUNT(*) FROM reward r WHERE (r.idem_key = 'penrev:' || p.id OR r.idem_key LIKE 'penrev:' || p.id || ':g%') AND r.state = 'failed') >= 5", cid),
    open_failed_rewards: R.openFailedRewards(cx, cid),
    open_restores_failed: Pen.openRestoresFailed(cx, cid),
    open_debits_failed: Pen.openDebitsFailed(cx, cid),
    open_reverses_failed: R.openReversesFailed(cx, cid),
    shop: shopOn(c.ctx.env, c.company) ? 'on' : 'not enabled in v1',
    buy: buyOn(c.ctx.env, c.company) ? 'on' : 'not enabled in v1',
    needs_admin: R.needsAdminCounts(cx, c.company).then((x) => x.total),
    open_holds_failed: openOps(cx, cid, ['hold_reserve', 'hold_release', 'order_reserve', 'order_release', 'order_decide']),
    open_partial_grants: R.openPartialGrants(cx, cid),
    open_orders_stuck: Promise.all([q("SELECT COUNT(*) n FROM provider_op WHERE company_id = ? AND kind IN ('order_reserve','order_decide','order_release') AND settled = 0 AND created_at < ?", cid, c.ctx.now() - 24 * 3600_000), q("SELECT COUNT(*) n FROM catalogue_order WHERE company_id = ? AND state = 'reserved' AND created_at < ?", cid, c.ctx.now() - 7 * 24 * 3600_000)]).then(([x, y]) => x + y),
    open_failed_periods: q("SELECT COUNT(*) n FROM reward WHERE company_id = ? AND state = 'failed' AND reversed = 0 AND event_id IS NULL AND kind IN ('tier','streak','team') AND person_id IN (SELECT id FROM app_user WHERE erased_at IS NULL)", cid),
    rewards_voided_silent: q("SELECT COUNT(*) n FROM reward WHERE company_id = ? AND state = 'void' AND last_error IN ('season_closed','no_season','season_cap','person_erased') AND created_at > ? AND (event_id IS NULL OR last_error = 'person_erased')", cid, c.ctx.now() - 30 * DAY), // last 30 days; voided EVENT rewards are in the needs-admin list instead
    unconfirmed_credits: q("SELECT COUNT(*) n FROM reward WHERE company_id = ? AND state = 'failed' AND last_error = 'duplicate_unconfirmed' AND reversed = 0 AND person_id IN (SELECT id FROM app_user WHERE erased_at IS NULL)", cid),
    recent_email_changes: q("SELECT COUNT(*) n FROM audit WHERE company_id = ? AND action = 'person.correct' AND at > ? AND instr(data, '\"email\"') > 0", cid, c.ctx.now() - 30 * DAY), // a changed work e-mail changes who a person is to the provider: the admin can see how many were changed lately (the audit lines name the person)
    warnings: cx.db.first("SELECT MAX(m) n FROM (SELECT MAX(t.bonus) m FROM tier t JOIN period_target p ON p.id = t.target_id WHERE p.company_id = ? UNION ALL SELECT MAX(bonus) FROM streak WHERE company_id = ?)", cid, cid).then((x) => providerCapWarnings(c.company, x?.n ?? 0)),
    rewards_waiting_revived: q("SELECT COUNT(*) n FROM reward WHERE company_id = ? AND state = 'waiting' AND last_error = 'revived'", cid),
    rewards_stuck: q("SELECT COUNT(*) n FROM reward WHERE company_id = ? AND state = 'queued' AND attempts >= 10", cid),
    rights_open: q("SELECT COUNT(*) n FROM rights_request WHERE company_id = ? AND state = 'open'", cid),
    ai_enabled: settingsOf(c.company).ai_enabled === true,
    season: cx.db.first("SELECT id, name, budget, ends_at FROM season WHERE company_id = ? AND status = 'published' ORDER BY starts_at DESC LIMIT 1", cid),
    used_budget: q("SELECT COALESCE(SUM(amount),0) n FROM reward WHERE company_id = ? AND amount > 0 AND state IN ('queued','sent')", cid),
  });
  const ts = o.tick_state; o.tick_backlog = ts?.backlog ?? 0; o.tick_sweep_left = ts?.sweep_left ?? 0; o.tick_backlog_ticks = ts?.backlog_ticks ?? 0;
  o.tick_budget_small = ts?.budget_small ?? null;
  const today = Math.floor(c.ctx.now() / DAY), soft = rowsSoftLimit(c.ctx.env);
  o.rows_read_today = ts?.rows_day === today ? ts.rows_read_day : 0; o.rows_written_today = ts?.rows_day === today ? ts.rows_written_day : 0; o.rows_read_soft_limit = soft;
  o.tick_stage_errors = o.stage_errors.map((x) => ({ stage: x.stage, first_at: x.first_at, at: x.last_at, count: x.count }));
  o.tick_stage_error = o.tick_stage_errors[0] ? { stage: o.tick_stage_errors[0].stage, at: o.tick_stage_errors[0].at } : null; // the oldest uncleared one
  const lastOk = o.last_ok; o.last_tick_at = lastOk || null; o.tick_stale = (c.ctx.now() - (lastOk || c.company.created_at || 0)) > 3600_000;
  delete o.tick_state; delete o.stage_errors; delete o.last_ok;
  // One plain line per thing that needs an admin: no code, no names.
  const say = { needs_admin: 'Some rewards need an admin: open "Rewards that need an admin" and check the Moneypenny ledger. A failed or partly granted event reward can be re-issued there as a NEW grant (after you checked the ledger); a period bonus (tier, streak, team) is fixed by hand outside the app in v1. Nothing is paid again by itself. A provider cap such as the daily one may clear within 24 hours.', open_partial_grants: 'A reward was granted only in part (the provider paid less than asked). Check the Moneypenny ledger: an event reward can be re-issued for what is missing; for a period bonus the missing part is added by hand outside the app. Nothing is topped up by itself.', open_failed_periods: 'A period bonus (tier, streak or team) failed or was only partly granted and is blocked: open "Rewards that need an admin", check the Moneypenny ledger and fix it by hand outside the app. Nothing is paid again by itself.', unconfirmed_credits: 'The provider said a credit already exists but could not confirm it. Check the Moneypenny ledger: if the credit landed, record it by hand outside the app; re-issue it only if it did NOT land.', open_orders_stuck: 'A shop order could not be finished for a day or more: check the provider link; the clock keeps retrying it.',   rewards_voided_silent: 'Some rewards were voided because the season had closed or a cap was reached.', open_handbacks_failed: 'Credit hand-backs gave up: use retry-handbacks.', open_restores_failed: 'Restores of a lost-race debit gave up: ask support.', open_holds_failed: 'A hold or an order step could not be confirmed and stopped retrying: use retry-ops.', open_reverses_failed: 'A reversal of a credit could not be confirmed and stopped retrying: ask support.', open_debits_failed: 'A penalty debit could not be confirmed and stopped retrying: ask support.', rewards_stuck: 'Rewards were tried 10 times and are still on their way: check the Moneypenny link.' };
  o.alerts = Object.entries(say).filter(([k]) => o[k] > 0).map(([k, t]) => `${t} (${o[k]})`);
  for (const x of o.tick_stage_errors) o.alerts.push('A step of the clock failed (' + x.stage + ', first ' + new Date(x.first_at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC, ' + x.count + ' time' + (x.count === 1 ? '' : 's') + ') and has not run cleanly since: ask support to look at the audit log (tick.stage_error).');
  if (o.tick_budget_small) { const [need, have] = o.tick_budget_small.split(':'); o.alerts.push('budget_too_small: the last settle turn could not pay a member: one payment needs about ' + need + ' calls and that turn had ' + have + '. Run the clock through the signed tick route (docs/DEPLOY.md), which gets a larger allowance, or raise TICK_QUERY_BUDGET.'); }
  if (o.tick_backlog > 0 && o.tick_backlog_ticks >= 6) o.alerts.push('The clock is behind: ' + o.tick_backlog + ' reward groups or periods are waiting to be checked and have been for ' + o.tick_backlog_ticks + ' runs. Run the clock more often (docs/DEPLOY.md) or raise TICK_QUERY_BUDGET on a paid plan. Nothing is lost; the newest periods are checked first.');
  if (o.rows_read_today >= soft) o.alerts.push('rows_read_high: ' + o.rows_read_today + ' rows read today (soft limit ' + soft + '; the free D1 plan stops at 5,000,000 a day and then every query fails until 00:00 UTC). The clock now does only the essential work (sending, releases, the newest periods) until tomorrow. See docs/DEPLOY.md.');
  if (o.tick_stale) o.alerts.push('Nothing has run the full clock for over an hour: set up the scheduler (docs/DEPLOY.md). Without it period bonuses and streaks are not paid (opening the app only moves the light steps).');
  o.alerts.push(...o.warnings);
  return o;
});
route('GET', '/api/admin/rights', async (c) => { need(c.user, 'admin', 'hr'); return { requests: await c.ctx.db.all('SELECT id, person_id, kind, note, state, created_at FROM rights_request WHERE company_id = ? ORDER BY created_at DESC', c.company.id) }; });

/**
 * Everything the clock drives. Run (1) by the admin button, (2) by an external scheduler calling the signed POST /api/ingest/tick (docs/DEPLOY.md), and
 * (3) lazily: any signed-in request runs a SMALL tick when none ran for 5 minutes (one winner per window, see lazyTick). Nothing else schedules it.
 */
export async function tick(ctx, company, { limit = 100, only = null, lazy = false, driver = false, turn = null } = {}) {
  const r = await tickBody(ctx, company, limit, only, { lazy, driver, turn });
  delete r._errors;
  return r;
}
const LAZY_EVERY = 5 * 60_000, LAZY_MAX_USED = 8, LAZY_BUDGET = 20;
/** The ONLY routes before which the lazy clock may run: light reads that use a few calls. A heavy route (a list, an event submit) never starts a tick: it would overrun the invocation. */
const LAZY_ROUTES = new Set(['GET /api/admin/overview', 'GET /api/me']);
/**
 * A signed-in request may start a TINY tick when none ran for 5 minutes (one winner per window, see the claim). It never settles; it moves the light stages (releases, approvals, reversals, penalty notices, and at most a row or two of sending)
 * inside its own small budget, counted against the invocation the request is already using, and is skipped when the request has already used more than LAZY_MAX_USED (8) calls. It runs only before the routes in LAZY_ROUTES, after the CSRF check. The heavy work (sending, the period settle) belongs
 * to the external driver (docs/DEPLOY.md). A failure never reaches the caller. Not used by signed system calls.
 */
export async function lazyTick(ctx, company) {
  if (ctx.env.LAZY_TICK === '0') return false;
  if (ctx.budget && ctx.budget.used > LAZY_MAX_USED) return false; // this request has used its share already
  const t = ctx.now();
  const claim = await ctx.db.run('UPDATE company SET last_tick_at = ? WHERE id = ? AND last_tick_at <= ?', t, company.id, t - LAZY_EVERY);
  if (claim.changes === 0) return false;
  try { await tick(ctx, company, { limit: 25, lazy: true }); } catch (e) { console.error('lazy tick failed', e?.message); }
  return true;
}

// ---------- rows read and written per UTC day (the free D1 plan: 5 million read, 100 thousand written; past it every query fails until 00:00 UTC) ----------
/** Adds the rows this invocation read and wrote since it started (and, from the settle, the old periods it looked at) to today's total in tick_state. One statement. */
export async function accountRows(ctx, company, { cold = 0, holder = ctx.budget } = {}) {
  const stats = ctx.rawDb?.stats ?? ctx.db.stats, base = holder?.rows0;
  if (!stats || !base) return null;
  const dr = Math.max(0, stats.rowsRead - base.r), dw = Math.max(0, stats.rowsWritten - base.w);
  holder.rows0 = { r: stats.rowsRead, w: stats.rowsWritten + 1 }; // what is counted now is not counted again (the statement below writes one row)
  const day = Math.floor(ctx.now() / DAY);
  await ctx.db.run(`INSERT INTO tick_state (company_id, rows_day, rows_read_day, rows_written_day, cold_day, cold_used) VALUES (?,?,?,?,?,?) ON CONFLICT (company_id) DO UPDATE SET
    rows_read_day = CASE WHEN tick_state.rows_day = excluded.rows_day THEN tick_state.rows_read_day + excluded.rows_read_day ELSE excluded.rows_read_day END,
    rows_written_day = CASE WHEN tick_state.rows_day = excluded.rows_day THEN tick_state.rows_written_day + excluded.rows_written_day ELSE excluded.rows_written_day END,
    rows_day = excluded.rows_day,
    cold_used = CASE WHEN tick_state.cold_day = excluded.cold_day THEN tick_state.cold_used + excluded.cold_used ELSE excluded.cold_used END,
    cold_day = CASE WHEN ? > 0 OR tick_state.cold_day = excluded.cold_day THEN excluded.cold_day ELSE tick_state.cold_day END`, company.id, day, dr, dw, day, cold, cold);
  return { read: dr, written: dw };
}
const ROWS_FLUSH = 20_000; // a request that read more than this many rows adds them to today's total itself
// The stages of the clock. A tick under a query budget (TICK_QUERY_BUDGET, default 40; one worker invocation on a free D1 plan allows 50 queries, a batch counts as one) runs ONE of two turns, so every stage
// gets a useful share: the CORE turn (sending, releases, approvals, reversals, penalties, orders, AI housekeeping) and the SETTLE turn (the period bonuses). They alternate. A tick with no budget (0) runs everything.
// The core stages start at a different one each time round and each has a minimum share (a stage that cannot use its share gives it on), so none is starved by another.
const CORE = ['sent', 'released', 'resumed', 'reversals', 'penalties', 'orders', 'ai_resumed', 'purged'];
const LIGHT = ['released', 'resumed', 'reversals', 'penalties', 'sent']; // what a lazy tick may do (sending at most a row or two); never the settle
const WEIGHT = { sent: 14, released: 5, resumed: 3, reversals: 5, penalties: 5, orders: 4, ai_resumed: 3, purged: 2, settled: 999 };
const RESERVE = 6;             // calls kept for the bookkeeping at the end of a bounded tick (state, stage state, the clock stamp, one audit line)
const MARGIN = 4;              // calls of the invocation left unused
const MIN_DRIVER_BUDGET = 32;  // the signed tick route may use this much even when TICK_QUERY_BUDGET is set lower (one visit of the settle needs about 20)
const CYCLE_WINDOW = 45 * 60_000; // the clock counts as fully run when BOTH turns ran cleanly within this time
async function tickBody(ctx, company, limit, only = null, { lazy = false, driver = false, turn: want = null } = {}) {
  const configured = budgetLimit(ctx.env);
  let limitQ = configured; const bounded = configured > 0 || lazy;
  if (bounded) {
    if (lazy) limitQ = LAZY_BUDGET;
    else if (driver && limitQ < MIN_DRIVER_BUDGET) limitQ = MIN_DRIVER_BUDGET;
    const invLimit = Number(ctx.env.INVOCATION_QUERY_LIMIT) || 50;
    if (ctx.budget) limitQ = Math.max(4, Math.min(limitQ, invLimit - ctx.budget.used - MARGIN)); // what the request itself already used is not available
  }
  const b = makeBudget(limitQ), t = bounded ? withBudget(ctx, b) : ctx;
  const holder = ctx.budget ?? ctx.__rows ?? (ctx.__rows = {}); // where this invocation's starting row counts live (handle() sets them; a direct call starts here)
  { const rs = ctx.rawDb?.stats ?? ctx.db.stats; if (rs && !holder.rows0) holder.rows0 = { r: rs.rowsRead, w: rs.rowsWritten }; }
  const defs = {
    sent: () => R.retryQueued(t, company, limit), released: () => R.releaseWaiting(t, company), resumed: () => E.resumeApproved(t, company),
    reversals: () => E.processReversals(t, company), penalties: () => Pen.tickPenalties(t, company), settled: () => settleCompany(t, company, ctx.now()),
    orders: () => S.finishOrders(t, company), ai_resumed: () => AI.resumeAiRuns(t, company), purged: () => AI.purgeAiData(t, company),
  };
  let st = null, seq = 0; const stageRow = new Map();
  if (!lazy) {
    try { const [s1, s2] = await t.db.reads([['SELECT * FROM tick_state WHERE company_id = ?', company.id], ['SELECT * FROM tick_stage WHERE company_id = ?', company.id]]); st = s1[0] ?? null; for (const r of s2) stageRow.set(r.stage, r); } catch { /* tables missing or the budget: run without state */ }
    seq = st?.tick_seq ?? 0;
  }
  const rot = (list, k) => list.slice(k % list.length).concat(list.slice(0, k % list.length));
  const pick = want === 'core' || want === 'settle' ? want : (seq % 2 === 0 ? 'core' : 'settle'); // a driver may ask for a turn (the settle turn alone pays fastest); otherwise they alternate
  const names = only ?? (lazy ? rot(LIGHT, ctx.now() / LAZY_EVERY | 0) : bounded ? (pick === 'core' ? rot(CORE, seq >> 1) : ['settled']) : [...CORE.slice(0, 5), 'settled', ...CORE.slice(5)]);
  const turn = only ? 'only' : lazy ? 'lazy' : bounded ? pick : 'all';
  const out = {};
  let errored = 0, budgetHit = false; const ran = [], failed = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (bounded) {
      const room = limitQ - (lazy ? 2 : RESERVE) - b.used, share = names.length === 1 ? room : Math.max(WEIGHT[name] ?? 4, Math.floor(room / (names.length - i)));
      b.cap = b.used + Math.min(room, share); b.hit = 0;
      if (room < 2) { out[name] = { budget: true }; budgetHit = true; continue; } // nothing left for this stage in this tick: it goes first at another
    }
    try { out[name] = await defs[name](); } catch (e) {
      if (e instanceof BudgetReached) { out[name] = { budget: true }; budgetHit = true; continue; }
      out[name] = { error: e?.code ?? 'internal' }; errored++; failed.push(name);
      try {
        b.cap = limitQ || Infinity;
        if (!(await t.db.first("SELECT 1 x FROM audit WHERE company_id = ? AND action = 'tick.stage_error' AND at > ? AND instr(data, ?) > 0", company.id, ctx.now() - DAY, '"stage":"' + name + '"'))) await commit(t, company.id, 'system', 'tick.stage_error', { stage: name, code: String(e?.code ?? 'internal').slice(0, 40) });
      } catch { /* the next tick writes it */ }
      continue;
    }
    if (bounded && b.hit > 0) { budgetHit = true; if (out[name] && typeof out[name] === 'object') out[name] = { ...out[name], budget: true }; }
    ran.push(name);
  }
  // The error state is kept PER STAGE: a stage that failed stays flagged until THAT stage runs cleanly again, whichever turn it belongs to.
  const now = ctx.now(); let open = [...stageRow.values()].filter((r) => r.count > 0).map((r) => r.stage);
  if (!lazy || errored) {
    try {
      b.cap = Math.max(b.cap, limitQ || Infinity); b.hit = 0;
      for (const name of failed) await t.db.run('INSERT INTO tick_stage (company_id, stage, first_at, last_at, count, ok_at) VALUES (?,?,?,?,1,0) ON CONFLICT (company_id, stage) DO UPDATE SET first_at = CASE WHEN count = 0 THEN excluded.first_at ELSE first_at END, last_at = excluded.last_at, count = count + 1', company.id, name, now, now);
      for (const name of ran) if (stageRow.get(name)?.count > 0) { await t.db.run('UPDATE tick_stage SET count = 0, ok_at = ? WHERE company_id = ? AND stage = ?', now, company.id, name); open = open.filter((x) => x !== name); }
      open = [...new Set([...open, ...failed])];
    } catch { /* the next tick */ }
  }
  if (bounded && !lazy && !only) { // bookkeeping: cursor, backlog, when each turn last ran cleanly, one 'budget reached' line a day, and the clock stamp
    try {
      b.cap = limitQ; b.hit = 0;
      const ranSettle = turn === 'settle' && !out.settled?.error && !out.settled?.budget_skipped;
      const backlog = ranSettle ? (b.backlog ?? 0) : (st?.backlog ?? 0);
      out.backlog = backlog; // a driver calls again (settle turn) until this is 0
      if (ranSettle && backlog > 0) budgetHit = true; // work was left for the next turn: the budget (not an error) is why
      const bt = ranSettle ? (backlog > 0 ? (st?.backlog_ticks ?? 0) + 1 : 0) : (st?.backlog_ticks ?? 0);
      const cursor = ranSettle ? (b.settleCursorSet ? (b.settleCursor ?? null) : (st?.settle_cursor ?? null)) : (st?.settle_cursor ?? null);
      const small = ranSettle ? (b.budgetSmall ?? null) : (st?.budget_small ?? null); // flagged only when a settle turn REALLY could not pay a member for want of calls (a driver tick gets at least MIN_DRIVER_BUDGET, so a small TICK_QUERY_BUDGET alone is no problem)
      const cleanTurn = errored === 0;
      const coreOk = turn === 'core' && cleanTurn ? now : (st?.core_ok_at ?? 0), settleOk = turn === 'settle' && cleanTurn ? now : (st?.settle_ok_at ?? 0);
      await t.db.run('INSERT INTO tick_state (company_id, tick_seq, settle_cursor, backlog, sweep_left, backlog_ticks, budget_at, core_ok_at, settle_ok_at, budget_small) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT (company_id) DO UPDATE SET tick_seq = excluded.tick_seq, settle_cursor = excluded.settle_cursor, backlog = excluded.backlog, sweep_left = excluded.sweep_left, backlog_ticks = excluded.backlog_ticks, budget_at = excluded.budget_at, core_ok_at = excluded.core_ok_at, settle_ok_at = excluded.settle_ok_at, budget_small = excluded.budget_small',
        company.id, seq + 1, cursor, backlog, ranSettle ? (b.sweepLeft ?? 0) : (st?.sweep_left ?? 0), bt, budgetHit ? now : (st?.budget_at ?? 0), coreOk, settleOk, small);
      if (!open.length && coreOk >= now - CYCLE_WINDOW && settleOk >= now - CYCLE_WINDOW) await t.db.run('UPDATE company SET last_tick_ok_at = ? WHERE id = ?', now, company.id); // fully run: both turns clean, no stage flagged
      await accountRows(t, company, { cold: ranSettle ? (b.coldRead ?? 0) : 0, holder });
      if (budgetHit && !(await t.db.first("SELECT 1 x FROM audit WHERE company_id = ? AND action = 'tick.budget_reached' AND at > ?", company.id, now - DAY))) await commit(t, company.id, 'system', 'tick.budget_reached', { budget: limitQ, backlog });
    } catch { /* the next tick */ }
  } else if (!bounded && !errored && (only || !open.length)) {
    try { await ctx.db.run('UPDATE company SET last_tick_ok_at = ? WHERE id = ?', now, company.id); } catch { /* the next tick */ }
  }
  out._errors = errored;
  return out;
}

// ---------- signed system routes (older paths, still served) ----------
// Key classes: read < event_write < manager < admin. An ai_read key is never allowed here: it uses /api/v1 only.
const SYS = { id: 'api', role: 'system' };
const ABOVE = (k) => AI.KEY_CLASSES.slice(AI.KEY_CLASSES.indexOf(k));
const sysRoutes = [
  ['POST', '/api/ingest/events', ABOVE('event_write'), async (c) => { const r = await AI.ingestEvents(c.ctx, c.company, SYS, c.body, { allowCancel: true }); return r.deferred ? { ...r, _status: 207 } : r; }, 'write', 'ingest.events'],
  ['POST', '/api/ingest/tick', ABOVE('event_write'), async (c) => tick(c.ctx, c.company, { driver: true, turn: c.body?.turn ?? null }), 'write', 'ingest.tick'],
  ['POST', '/api/webhooks/provider', ['provider_webhook'], async (c) => {
    // Stored first, then answered 200. A daily history check repairs anything missed.
    const t = clean(c.body.type, 60);
    if (!['purchase.paid', 'balance.low', 'credit.expired', 'spend.captured', 'credit.added'].includes(t)) throw new ApiError(400, 'bad_type', 'Unknown event type.');
    await c.ctx.db.run('INSERT OR IGNORE INTO provider_event (id, company_id, type, body, at) VALUES (?,?,?,?,?)', clean(c.body.id, 80) || 'pe_' + c.ctx.now(), c.company.id, t, JSON.stringify({ ref: clean(c.body.ref, 80) }), c.ctx.now());
    return { ok: true };
  }, 'write', 'webhooks.provider'],
  // Partner Circle dashboard widgets (design section 8A): company-level numbers, no names, no personal detail.
  ['GET', '/api/v1/widgets/targets', ABOVE('read'), async (c) => ({ v: 1, product: settingsOf(c.company).product_name, targets: await AI.targetsData(c.ctx, c.company) }), 'read', 'widgets.targets'],
  ['GET', '/api/v1/widgets/achievements', ABOVE('read'), async (c) => ({ v: 1, ...(await AI.achievementsData(c.ctx, c.company)) }), 'read', 'widgets.achievements'],
  ['GET', '/api/v1/widgets/board-summary', ABOVE('read'), async (c) => ({ v: 1, ...(await AI.boardNumbers(c.ctx, c.company)), teams: (await c.ctx.db.all('SELECT name FROM team WHERE company_id = ?', c.company.id)).length }), 'read', 'widgets.board-summary'],
];
/** Every /api/v1 route this server answers: the machine API table plus the older widget paths. Tests compare it with the generated spec. */
export const registeredV1Routes = () => [
  ...Object.keys(AI.HANDLERS).map((id) => { const o = AI.OPERATIONS.find((x) => x.id === id); return { method: o.method, path: o.path, id, legacy: false }; }),
  ...sysRoutes.filter((r) => r[1].startsWith('/api/v1/')).map((r) => ({ method: r[0], path: r[1], id: null, legacy: true })),
];

// ---------- entry ----------
export async function handle(ctx0, req, env = {}) {
  // One request is one worker invocation: its database and provider calls are counted from the first one (the lazy tick and the tick routes size themselves from what is left of the invocation's limit).
  const ctx = ctx0.budget ? ctx0 : withBudget(ctx0, makeBudget(0));
  const rs = ctx.rawDb?.stats ?? ctx.db.stats; if (rs && !ctx.budget.rows0) ctx.budget.rows0 = { r: rs.rowsRead, w: rs.rowsWritten }; // what this invocation reads and writes is counted from here (see accountRows)
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (!path.startsWith('/api/')) return out(404, { ok: false, error: { code: 'not_found', message: 'Not found.' } });
    const raw = await readBody(req);
    // the machine API (/api/v1/...): its own front door with its own switches, idempotency and audit
    const v1 = await AI.handleV1(ctx, req, path, raw);
    if (v1) return v1;
    // older signed system routes
    const sys = sysRoutes.find((r) => r[0] === req.method && r[1] === path);
    if (sys) {
      const company = await signed(ctx, req, raw, sys[2]);
      await AI.enforceSwitches(ctx, company, sys[4], sys[5]); // the Hub and platform switches cover every signed route, not only /api/v1
      const result = await sys[3]({ ctx, company, body: parse(raw), url, env });
      if (AI.isV1Path(req.method, path)) return AI.legacyReply(req.method, path, result);
      const { _status, ...rest } = result;
      return out(_status ?? 200, { ok: true, ...rest });
    }
    // platform routes: only with the platform token secret; used to open a company and, later, mark it live. Never to read people data.
    if (path.startsWith('/api/platform/')) {
      const tok = (req.headers.get('authorization') ?? '').replace(/^Bearer /i, '');
      if (!ctx.env.PLATFORM_TOKEN || ctx.env.PLATFORM_TOKEN.length < 24 || !safeEqual(tok, ctx.env.PLATFORM_TOKEN)) throw new ApiError(401, 'platform_only', 'Not allowed.');
      const body = parse(raw);
      if (req.method === 'POST' && path === '/api/platform/reseal') return out(200, { ok: true, ...(await P.resealAll(ctx)) }); // key rotation, see docs/ROTATION.md
      if (req.method === 'POST' && path === '/api/platform/company') {
        const r = await P.createCompany(ctx, { name: body.name, slug: body.slug, provider: body.provider === 'moneypenny' ? 'moneypenny' : 'stub', adminEmail: body.admin_email, adminName: body.admin_name });
        return out(200, { ok: true, company_id: r.company.id, admin_id: r.admin.id, invite_code: r.code, note: 'The code is shown once.' });
      }
      const live = path.match(/^\/api\/platform\/company\/([A-Za-z0-9_]+)\/live$/);
      if (req.method === 'POST' && live) {
        const co = await ctx.db.first('SELECT * FROM company WHERE id = ?', live[1]);
        if (!co) throw new ApiError(404, 'no_company', 'No such company.');
        if (co.provider !== 'moneypenny') throw new ApiError(409, 'demo_provider', 'Only a company on the real credit provider can go live.');
        if (body.contract_tests_passed !== true) throw new ApiError(409, 'tests_first', 'The contract tests must pass against the real provider first.');
        try { await commit(ctx, co.id, 'platform', 'company.live', {}, [['UPDATE company SET live = 1 WHERE id = ?', co.id]]); }
        catch (e) { if (/UNIQUE|constraint/i.test(String(e?.message))) throw new ApiError(409, 'one_live_provider_company', 'Only one company can be live on this credit provider connection.'); throw e; }
        return out(200, { ok: true });
      }
      throw new ApiError(404, 'not_found', 'Not found.');
    }
    const hit = routes.map((r) => ({ r, m: r.method === req.method ? path.match(r.re) : null })).find((x) => x.m);
    if (!hit) return out(404, { ok: false, error: { code: 'not_found', message: 'Not found.' } });
    const open = ['/api/health', '/api/config', '/api/auth/request-code', '/api/auth/login'].includes(path);
    const c = { ctx, env, url, ip: ipOf(req), body: parse(raw), token: cookieOf(req, 'floor_session') ?? (req.headers.get('authorization') ?? '').replace(/^Bearer /i, '') };
    if (!open) {
      const a = await P.authenticate(ctx, c.token);
      if (!a) throw new ApiError(401, 'sign_in', 'Please sign in.');
      c.user = a.user; c.company = a.company;
      if (req.method !== 'GET') { // cross-site writes: require our own header, and a same-site Origin when one is sent
        if (req.headers.get('x-floor') !== '1') throw new ApiError(403, 'csrf', 'Missing request header.');
        const o = req.headers.get('origin');
        if (o && !sameOrigin(o, url.host)) throw new ApiError(403, 'csrf', 'Cross-site request refused.'); // also for Origin: null
      }
    } else if (req.method !== 'GET') {
      const o = req.headers.get('origin');
      if (o && !sameOrigin(o, url.host)) throw new ApiError(403, 'csrf', 'Cross-site request refused.');
    }
    // The lazy clock runs only before a LIGHT read (a few calls) and only when the request has hardly used its invocation yet, and after the CSRF check. Every other route is left alone: the driver does the work.
    if (!open && LAZY_ROUTES.has(`${req.method} ${path}`)) await lazyTick(ctx, c.company);
    const result = await hit.r.fn(c, hit.m);
    return out(200, { ok: true, ...result }, c.setCookie ? { 'set-cookie': c.setCookie } : {});
  } catch (e) {
    if (AI.isV1Path(req.method, path)) return AI.v1Error(e); // errors before the v1 front door (a too-large body) keep the v1 shape: meta and x-content-trust
    if (e instanceof ApiError) return out(e.status, { ok: false, error: { code: e.code, message: e.message, ...e.extra } }, e.extra?.retry_after ? { 'retry-after': String(e.extra.retry_after) } : {});
    if (e instanceof ProviderError) return out(502, { ok: false, error: { code: e.code, message: 'The credit service said no.' } });
    console.error('internal error', e?.message);
    return out(500, { ok: false, error: { code: 'internal', message: 'Something went wrong on our side.' } });
  }
}
