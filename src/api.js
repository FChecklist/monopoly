// HTTP API. One function: handle(ctx, Request) -> Response. Works in Workers, Pages Functions and the local server.
import { ApiError, newId, safeEqual, clean, mustInt, DAY, int, clampLimit, periodOf, jsonOut as out, parseBody as parse, sameOrigin } from './util.js';
import { PRODUCT, DEFAULTS, settingsOf, SQUARES, TOKENS, HIDE_NAME_NOTICE } from './config.js';
import { commit, verifyChain } from './audit.js';
import * as P from './people.js';
import * as S from './setup.js';
import * as E from './events.js';
import * as B from './board.js';
import * as Pen from './penalty.js';
import * as R from './rewards.js';
import * as AI from './aiapi.js';
import { settleCompany, simulateBudget, countFor, tiersOf } from './periods.js';
import { ProviderError } from './provider/errors.js';

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
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:id/g, '([A-Za-z0-9_\\-]+)') + '$'), fn });

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
  rewards: await Promise.all((await c.ctx.db.all("SELECT id, kind, amount, state, created_at, event_id, rate_version, period_key FROM reward WHERE company_id = ? AND person_id = ? AND state != 'void' ORDER BY created_at DESC LIMIT 200", c.company.id, c.user.id)).map(async (r) => ({ ...r, ...moneyView(c.company, r.amount), ...(r.kind === 'bonus_roll' && r.event_id ? { roll: await rollOf(c.ctx, c.company, c.user.id, r.event_id) } : {}) }))),
  corrections: await c.ctx.db.all("SELECT id, amount, recovered, state, reason FROM correction WHERE company_id = ? AND person_id = ? AND state IN ('open','frozen')", c.company.id, c.user.id),
}));
route('GET', '/api/me/targets', async (c) => {
  const s = settingsOf(c.company), now = c.ctx.now(), res = [];
  for (const t of await c.ctx.db.all("SELECT * FROM period_target WHERE company_id = ? AND scope = 'person'", c.company.id)) {
    const p = periodOf(t.period, now, s.fy_start_month), tiers = await tiersOf(c.ctx, t.id);
    res.push({ id: t.id, name: t.name, period: t.period, period_key: p.key, ends_at: p.end, count: await countFor(c.ctx, c.company, t, c.user.id, p.start, p.end), tiers: tiers.map((x) => ({ count: x.count, bonus: x.bonus })) });
  }
  return { targets: res };
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
route('GET', '/api/shop/items', async (c) => ({ items: await c.ctx.db.all('SELECT id, name, credits, needs_approval FROM catalogue_item WHERE company_id = ? AND active = 1', c.company.id) }));
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
  const members = await c.ctx.db.all("SELECT * FROM app_user WHERE company_id = ? AND team_id = ? AND status = 'active'", c.company.id, team.id);
  const tokens = [];
  for (const u of members) { const b = await B.ensureBoard(c.ctx, c.company, u.id); tokens.push({ id: u.id, name: await P.displayName(c.ctx, u), avatar: u.avatar, position: b.position, level: b.level, laps: b.laps }); }
  const pool = await c.ctx.db.first('SELECT points FROM pool WHERE company_id = ? AND team_id = ?', c.company.id, team.id);
  return { team: { id: team.id, name: team.name }, squares: SQUARES, tokens, pool_points: pool?.points ?? 0 };
});
/** Team-vs-team league: ranked by verified achievement per head, so small teams are not punished. Visible by role and setting. */
route('GET', '/api/league', async (c) => {
  const s = settingsOf(c.company);
  if (c.user.role === 'employee' && !s.leaderboard) throw new ApiError(403, 'leaderboard_off', 'The leaderboard is switched off for this company.');
  const p = periodOf(c.url.searchParams.get('period') === 'week' ? 'week' : 'month', c.ctx.now(), s.fy_start_month);
  const teams = await c.ctx.db.all('SELECT * FROM team WHERE company_id = ?', c.company.id);
  const rows = [];
  for (const t of teams) {
    const head = (await c.ctx.db.first("SELECT COUNT(*) n FROM app_user WHERE team_id = ? AND status = 'active'", t.id)).n;
    const ev = (await c.ctx.db.first("SELECT COUNT(*) n FROM event e JOIN app_user u ON u.id = e.person_id WHERE e.company_id = ? AND u.team_id = ? AND e.status = 'applied' AND e.occurred_at >= ? AND e.occurred_at < ?", c.company.id, t.id, p.start, p.end)).n;
    rows.push({ team_id: t.id, team: t.name, members: head, achievements: ev, per_head: head ? Math.round((ev / head) * 100) / 100 : 0 });
  }
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
route('POST', '/api/events/csv', async (c) => { need(c.user, 'manager', 'admin', 'hr'); return E.importCsv(c.ctx, c.company, c.user, String(c.body.csv ?? ''), { commit: c.body.commit === true }); });
route('GET', '/api/events', async (c) => {
  need(c.user, 'manager', 'admin', 'hr');
  const status = c.url.searchParams.get('status');
  const where = ['e.company_id = ?'], p = [c.company.id];
  if (status) { where.push('e.status = ?'); p.push(status); }
  if (c.user.role === 'manager') { where.push('u.team_id IN (SELECT id FROM team WHERE manager_id = ?)'); p.push(c.user.id); }
  const rows = await c.ctx.db.all(`SELECT e.id, e.person_id, e.event_type, e.stage, e.ext_id, e.occurred_at, e.status, e.source, e.approvals_required, e.approvals_done, e.submitted_by, e.reason, e.reversal_kind, e.reversal_due, e.reversal_appeal FROM event e JOIN app_user u ON u.id = e.person_id WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC LIMIT 200`, ...p);
  // Managers and admin see real names (their job needs it; the notice says so). HR sees person ids only, and a name only for a person
  // with an open case, and every such look is written to the audit trail.
  const names = new Map();
  for (const r of rows) {
    if (names.has(r.person_id)) continue;
    const person = await c.ctx.db.first('SELECT * FROM app_user WHERE id = ?', r.person_id);
    if (c.user.role !== 'hr') { names.set(r.person_id, await P.displayName(c.ctx, person, { forceReal: true })); continue; }
    const open = !!(await c.ctx.db.first("SELECT id FROM penalty_case WHERE person_id = ? AND state IN ('proposed','pending','appealed')", person.id)) || !!(await c.ctx.db.first("SELECT id FROM event WHERE person_id = ? AND status = 'reversal_pending'", person.id));
    if (open) { names.set(r.person_id, await P.displayName(c.ctx, person, { forceReal: true })); await commit(c.ctx, c.company.id, c.user.id, 'view.person', { person: person.id, via: 'events' }); }
  }
  return { events: rows.map((r) => (names.has(r.person_id) ? { ...r, person: names.get(r.person_id) } : { ...r })) };
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
  const rows = await c.ctx.db.all(c.user.role === 'manager'
    ? "SELECT u.* FROM app_user u JOIN team t ON t.id = u.team_id WHERE u.company_id = ? AND t.manager_id = ? AND u.status = 'active'"
    : "SELECT * FROM app_user WHERE company_id = ? AND ? IS NOT NULL AND status = 'active'", c.company.id, c.user.id);
  const people = [];
  for (const u of rows) people.push(c.user.role === 'hr' ? { id: u.id, team_id: u.team_id, role: u.role } : await P.privateUser(c.ctx, u).then(({ work_id, ...x }) => ({ ...x, work_id })));
  return { people };
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
  const teamQ = c.user.role === 'manager' ? 'AND t.manager_id = ?' : 'AND ? IS NOT NULL';
  const rows = await c.ctx.db.all(`SELECT u.id, COUNT(e.id) n FROM app_user u JOIN team t ON t.id = u.team_id LEFT JOIN event e ON e.person_id = u.id AND e.status = 'applied' AND e.occurred_at >= ? AND e.occurred_at < ? WHERE u.company_id = ? ${teamQ} GROUP BY u.id`, p.start, p.end, c.company.id, c.user.id);
  const res = [];
  for (const r of rows) res.push({ person: await P.displayName(c.ctx, await c.ctx.db.first('SELECT * FROM app_user WHERE id = ?', r.id), { forceReal: true }), events: r.n });
  return { period: p.key, contributions: res };
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
  for (const r of rows) {
    if (c.body.commit !== true) { res.push({ email_ok: !!r.work_email, name: r.name }); continue; }
    try { const { user, code } = await P.addPerson(c.ctx, c.company, c.user, { email: r.work_email, name: r.name, work_id: r.work_id, role: ['manager', 'hr', 'employee'].includes(r.role) ? r.role : 'employee', team_id: r.team_id || null }); res.push({ ok: true, id: user.id, invite_code: code }); }
    catch (e) { res.push({ ok: false, reason: e.code ?? 'error' }); }
  }
  return { committed: c.body.commit === true, rows: res };
});
route('GET', '/api/admin/rate-card', async (c) => { adm(c); return { rows: await c.ctx.db.all('SELECT * FROM rate_card WHERE company_id = ? ORDER BY event_type, stage_no, version DESC', c.company.id) }; });
route('POST', '/api/admin/rate-card', async (c) => { adm(c); return S.addRateCard(c.ctx, c.company, c.user, c.body); });
route('GET', '/api/admin/targets', async (c) => {
  adm(c);
  const ts = await c.ctx.db.all('SELECT * FROM period_target WHERE company_id = ?', c.company.id);
  for (const t of ts) { t.tiers = await tiersOf(c.ctx, t.id); t.streak = await c.ctx.db.first('SELECT length, bonus, freeze_per_quarter FROM streak WHERE target_id = ?', t.id); }
  return { targets: ts };
});
route('POST', '/api/admin/targets', async (c) => { adm(c); return S.addTarget(c.ctx, c.company, c.user, c.body); });
route('GET', '/api/admin/seasons', async (c) => { adm(c); return { seasons: await c.ctx.db.all('SELECT * FROM season WHERE company_id = ? ORDER BY starts_at DESC', c.company.id) }; });
route('POST', '/api/admin/seasons', async (c) => { adm(c); return S.createSeason(c.ctx, c.company, c.user, c.body); });
route('POST', '/api/admin/seasons/:id/publish', async (c, m) => { adm(c); return S.publishSeason(c.ctx, c.company, c.user, idOf(m)); });
route('POST', '/api/admin/seasons/:id/budget', async (c, m) => { adm(c); await S.raiseBudget(c.ctx, c.company, c.user, idOf(m), c.body.budget); return R.releaseWaiting(c.ctx, c.company); });
route('POST', '/api/admin/seasons/:id/close', async (c, m) => { adm(c); await settleCompany(c.ctx, c.company, c.ctx.now(), { force: true }); return S.closeSeason(c.ctx, c.company, c.user, idOf(m)); });
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
  const prov = c.ctx.provider(c.company);
  try { return await prov.startPurchase({ accountRef: await R.accountRef(c.ctx, c.company, c.user), credits: mustInt(c.body.credits, 'credits', { min: 100, max: 10_000_000 }), ref: 'buy:' + c.ctx.now(), idem: 'buy:' + (c.body.request_id ?? c.ctx.now()) }); }
  catch (e) { if (e instanceof ProviderError) throw new ApiError(409, e.code, e.message); throw e; }
});
route('POST', '/api/admin/settle', async (c) => { adm(c); return settleCompany(c.ctx, c.company, c.ctx.now(), { force: c.body.force === true }); });
route('POST', '/api/admin/tick', async (c) => { adm(c); return tick(c.ctx, c.company); });
route('GET', '/api/admin/audit', async (c) => {
  need(c.user, 'admin', 'hr');
  const limit = clampLimit(c.url.searchParams.get('limit'), 100, 500);
  const hide = c.user.role === 'hr' ? "AND action NOT IN ('board.reset')" : ''; // HR does not see board resets (design 4A.8)
  return { verify: await verifyChain(c.ctx.db, c.company.id), rows: await c.ctx.db.all(`SELECT n, actor, action, data, at FROM audit WHERE company_id = ? ${hide} ORDER BY n DESC LIMIT ?`, c.company.id, limit) };
});
route('GET', '/api/admin/overview', async (c) => {
  need(c.user, 'admin', 'hr');
  const q = (sql, ...p) => c.ctx.db.first(sql, ...p).then((r) => r.n);
  const cid = c.company.id;
  return {
    people: await q("SELECT COUNT(*) n FROM app_user WHERE company_id = ? AND status = 'active'", cid),
    events_pending: await q("SELECT COUNT(*) n FROM event WHERE company_id = ? AND status IN ('pending','held')", cid),
    rewards_on_the_way: await q("SELECT COUNT(*) n FROM reward WHERE company_id = ? AND state = 'queued'", cid),
    rewards_waiting_budget: await q("SELECT COUNT(*) n FROM reward WHERE company_id = ? AND state = 'waiting'", cid),
    open_corrections: await q("SELECT COUNT(*) n FROM correction WHERE company_id = ? AND state IN ('open','frozen')", cid),
    penalties_open: await q("SELECT COUNT(*) n FROM penalty_case WHERE company_id = ? AND state IN ('proposed','pending','appealed')", cid),
    rights_open: await q("SELECT COUNT(*) n FROM rights_request WHERE company_id = ? AND state = 'open'", cid),
    ai_enabled: settingsOf(c.company).ai_enabled === true,
    season: await c.ctx.db.first("SELECT id, name, budget, ends_at FROM season WHERE company_id = ? AND status = 'published' ORDER BY starts_at DESC LIMIT 1", cid),
    used_budget: (await c.ctx.db.first("SELECT COALESCE(SUM(amount),0) n FROM reward WHERE company_id = ? AND amount > 0 AND state IN ('queued','sent')", cid)).n,
  };
});
route('GET', '/api/admin/rights', async (c) => { need(c.user, 'admin', 'hr'); return { requests: await c.ctx.db.all('SELECT id, person_id, kind, note, state, created_at FROM rights_request WHERE company_id = ? ORDER BY created_at DESC', c.company.id) }; });

/** Everything the clock drives. Run from the admin button or a scheduled caller with an ingest key. */
export async function tick(ctx, company) {
  return {
    sent: await R.retryQueued(ctx, company), released: await R.releaseWaiting(ctx, company), resumed: await E.resumeApproved(ctx, company),
    reversals: await E.processReversals(ctx, company), penalties: await Pen.tickPenalties(ctx, company), settled: await settleCompany(ctx, company, ctx.now()),
    ai_resumed: await AI.resumeAiRuns(ctx, company), purged: await AI.purgeAiData(ctx, company),
  };
}

// ---------- signed system routes (older paths, still served) ----------
// Key classes: read < event_write < manager < admin. An ai_read key is never allowed here: it uses /api/v1 only.
const SYS = { id: 'api', role: 'system' };
const ABOVE = (k) => AI.KEY_CLASSES.slice(AI.KEY_CLASSES.indexOf(k));
const sysRoutes = [
  ['POST', '/api/ingest/events', ABOVE('event_write'), async (c) => AI.ingestEvents(c.ctx, c.company, SYS, c.body, { allowCancel: true }), 'write', 'ingest.events'],
  ['POST', '/api/ingest/tick', ABOVE('event_write'), async (c) => tick(c.ctx, c.company), 'write', 'ingest.tick'],
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
export async function handle(ctx, req, env = {}) {
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
      return out(200, { ok: true, ...result });
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
