// Companies, teams, people and sign-in. Sign-in is an e-mail code, no passwords. Personal fields are sealed at rest.
import { ApiError, newId, randomCode, sha256Hex, normEmail, isEmail, clean, MIN, HOUR, DAY, safeEqual } from './util.js';
import { commit } from './audit.js';
import { assertV1Settings, assertCreditAmount } from './v1.js';
import { SCRUB_NOTE_SQL } from './rewards.js';
import { settingsOf, DEFAULTS, validateSettings, TOKENS } from './config.js';
import { ensureBoard } from './board.js';

export const ROLES = ['admin', 'manager', 'hr', 'employee'];

export async function createCompany(ctx, { name, slug, provider = 'stub', adminEmail, adminName = 'Admin', settings = {} }) {
  assertV1Settings(ctx.env, { live: 0, provider }, settings);
  slug = String(slug).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  if (!slug || !name) throw new ApiError(400, 'bad_company', 'Name and slug are needed.');
  const id = newId('co');
  await ctx.db.run('INSERT INTO company (id, name, slug, provider, settings, created_at) VALUES (?,?,?,?,?,?)', id, clean(name, 80), slug, provider, JSON.stringify(validateSettings(settings)), ctx.now());
  const company = await ctx.db.first('SELECT * FROM company WHERE id = ?', id);
  const { user, code } = await addPerson(ctx, company, { id: 'platform', role: 'admin' }, { email: adminEmail, name: adminName, role: 'admin' }, true);
  return { company, admin: user, code };
}

export async function addPerson(ctx, company, actor, input, skipActorCheck = false) {
  if (!skipActorCheck && actor.role !== 'admin') throw new ApiError(403, 'admin_only', 'Only the company admin adds people.');
  const email = normEmail(input.email);
  if (!isEmail(email)) throw new ApiError(400, 'bad_email', 'A valid work e-mail is needed.');
  const role = ROLES.includes(input.role) ? input.role : 'employee';
  let teamId = input.team_id ?? null;
  if (teamId && !(await ctx.db.first('SELECT id FROM team WHERE id = ? AND company_id = ?', teamId, company.id))) throw new ApiError(404, 'no_team', 'No such team.');
  const id = newId('u');
  const eh = await ctx.hash('email', email);
  // One answer whether the e-mail is used here or at another company, so this call cannot be used to find out who is registered elsewhere.
  if (await ctx.db.first('SELECT id FROM app_user WHERE email_hash = ?', eh)) throw new ApiError(409, 'email_taken', 'This e-mail cannot be added. It may already be in use.');
  const wid = input.work_id ? clean(input.work_id, 60) : null;
  await commit(ctx, company.id, actor.id, 'person.add', { id, role, team: teamId }, [
    ['INSERT INTO app_user (id, company_id, team_id, role, work_id_sealed, work_id_hash, name_sealed, email_hash, email_sealed, avatar, joined_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      id, company.id, teamId, role, wid ? await ctx.seal(wid, 'app_user.work_id:' + id) : null, wid ? await ctx.hash('workid', wid) : null, await ctx.seal(clean(input.name, 80) || 'Player', 'app_user.name:' + id), eh, await ctx.seal(email, 'app_user.email:' + id), 'badge', input.joined_at ?? ctx.now(), ctx.now()],
  ]);
  const user = await ctx.db.first('SELECT * FROM app_user WHERE id = ?', id);
  await ensureBoard(ctx, company, id);
  const code = await issueCode(ctx, user, 7 * DAY);
  return { user, code };
}

/** A one-time sign-in code. Shown once to the admin (invite) or sent by the mailer. Only its hash is kept. */
export async function issueCode(ctx, user, ttl = 15 * MIN) {
  const code = randomCode(8);
  await ctx.db.run('DELETE FROM login_code WHERE user_id = ?', user.id);
  await ctx.db.run('INSERT INTO login_code (id, user_id, code_hash, expires_at) VALUES (?,?,?,?)', newId('lc'), user.id, await ctx.hash('code', code + ':' + user.id), ctx.now() + ttl);
  return code;
}

const WINDOW = 15 * MIN;
async function bump(ctx, key) {
  const w = Math.floor(ctx.now() / WINDOW);
  await ctx.db.run('INSERT INTO login_attempt (k, window, n) VALUES (?,?,1) ON CONFLICT(k, window) DO UPDATE SET n = n + 1', key, w);
  await ctx.db.run('DELETE FROM login_attempt WHERE window < ?', w - 4);
}
/** Refuse when any counter is at its limit. The block lasts to the end of the 15 minute window, then lifts by itself. */
async function guard(ctx, ...pairs) {
  const w = Math.floor(ctx.now() / WINDOW);
  for (const [key, limit] of pairs) {
    const r = await ctx.db.first('SELECT n FROM login_attempt WHERE k = ? AND window = ?', key, w);
    if ((r?.n ?? 0) >= limit) throw new ApiError(429, 'slow_down', 'Too many tries. Wait a few minutes and try again.', { retry_after: Math.max(1, Math.ceil(((w + 1) * WINDOW - ctx.now()) / 1000)) });
  }
}
const ipKey = async (ctx, ip) => 'ip:' + (ip ? await ctx.hash('ip', ip) : 'none');

/** Same answer whether or not the e-mail exists. With no mailer set, people ask their admin for a code. */
export async function requestCode(ctx, emailRaw, mailer, { ip } = {}) {
  const email = normEmail(emailRaw);
  const eh = await ctx.hash('email', email), ik = await ipKey(ctx, ip);
  await guard(ctx, ['req:' + eh, 5], ['reqip:' + ik, 20]);
  await bump(ctx, 'req:' + eh); await bump(ctx, 'reqip:' + ik);
  const user = isEmail(email) ? await ctx.db.first("SELECT * FROM app_user WHERE email_hash = ? AND status = 'active'", eh) : null;
  if (user && mailer) await mailer(email, await issueCode(ctx, user));
  return { ok: true, message: mailer ? 'If this e-mail is registered, a code is on its way.' : 'If this e-mail is registered, ask your company admin for a sign-in code.' };
}

/**
 * Wrong tries are counted per (e-mail, address), per address, and per e-mail overall. A counter at its limit blocks until
 * the 15 minute window ends. Nobody can lock another person out for good, and one address cannot guess endlessly.
 */
export async function login(ctx, emailRaw, code, { ip } = {}) {
  const email = normEmail(emailRaw);
  const eh = await ctx.hash('email', email), ik = await ipKey(ctx, ip);
  const keys = ['lf:' + eh + ':' + ik, 'lfip:' + ik, 'lfuser:' + eh];
  await guard(ctx, [keys[0], 5], [keys[1], 30], [keys[2], 60]);
  const bad = async () => { for (const k of keys) await bump(ctx, k); return new ApiError(401, 'bad_code', 'That code did not work.'); };
  const user = await ctx.db.first("SELECT * FROM app_user WHERE email_hash = ? AND status = 'active'", eh);
  if (!user) throw await bad();
  const lc = await ctx.db.first('SELECT * FROM login_code WHERE user_id = ? AND used = 0', user.id);
  if (!lc || lc.expires_at < ctx.now()) throw await bad();
  await ctx.db.run('UPDATE login_code SET tries = tries + 1 WHERE id = ?', lc.id);
  const given = await ctx.hash('code', String(code ?? '').trim().toUpperCase() + ':' + user.id);
  if (!safeEqual(given, lc.code_hash)) throw await bad();
  await ctx.db.run('UPDATE login_code SET used = 1 WHERE id = ?', lc.id);
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await ctx.db.run('INSERT INTO session (token_hash, user_id, company_id, expires_at) VALUES (?,?,?,?)', await sha256Hex(token), user.id, user.company_id, ctx.now() + 12 * HOUR);
  await ctx.db.run('DELETE FROM session WHERE expires_at < ?', ctx.now());
  return { token, user };
}
export async function logout(ctx, token) { await ctx.db.run('DELETE FROM session WHERE token_hash = ?', await sha256Hex(String(token))); }

export async function authenticate(ctx, token) {
  if (!token) return null;
  const s = await ctx.db.first('SELECT * FROM session WHERE token_hash = ? AND expires_at > ?', await sha256Hex(String(token)), ctx.now());
  if (!s) return null;
  const user = await ctx.db.first("SELECT * FROM app_user WHERE id = ? AND status = 'active'", s.user_id);
  if (!user) return null;
  const company = await ctx.db.first("SELECT * FROM company WHERE id = ? AND status = 'active'", user.company_id);
  return company ? { user, company } : null;
}

/** What the person sees about someone: a name, or "Player N" when they hide their name. */
export async function displayName(ctx, user, { forceReal = false } = {}) {
  if (user.hide_name && !forceReal) return 'Player ' + (parseInt(user.id.slice(-4), 16) % 900 + 100);
  if (!user.name_sealed) return 'Former player';
  return ctx.unseal(user.name_sealed, 'app_user.name:' + user.id);
}
export async function publicUser(ctx, user, opts) {
  return { id: user.id, role: user.role, team_id: user.team_id, name: await displayName(ctx, user, opts), avatar: user.avatar, status: user.status };
}
export async function privateUser(ctx, user) {
  return {
    id: user.id, role: user.role, team_id: user.team_id,
    name: user.name_sealed ? await ctx.unseal(user.name_sealed, 'app_user.name:' + user.id) : 'Former player',
    email: user.email_sealed ? await ctx.unseal(user.email_sealed, 'app_user.email:' + user.id) : null,
    work_id: user.work_id_sealed ? await ctx.unseal(user.work_id_sealed, 'app_user.work_id:' + user.id) : null,
    avatar: user.avatar, hide_name: !!user.hide_name, status: user.status,
  };
}

export async function updateProfile(ctx, company, user, { avatar, hide_name }) {
  const sets = [], p = [];
  if (avatar !== undefined) { if (!TOKENS.includes(avatar)) throw new ApiError(400, 'bad_avatar', 'Pick one of our tokens.'); sets.push('avatar = ?'); p.push(avatar); }
  if (hide_name !== undefined) { sets.push('hide_name = ?'); p.push(hide_name ? 1 : 0); }
  if (sets.length) await commit(ctx, company.id, user.id, 'profile.update', { avatar, hide_name }, [[`UPDATE app_user SET ${sets.join(', ')} WHERE id = ?`, ...p, user.id]]);
}

export const CONSENT_VERSION = '2026-11-17';
export async function recordConsent(ctx, company, user, kind, accepted) {
  if (accepted !== true) throw new ApiError(400, 'tick_needed', 'The box must be ticked by you. It is never pre-ticked.');
  if (!['employee_notice', 'penalty_rules', 'terms'].includes(kind)) throw new ApiError(400, 'bad_kind', 'Unknown notice.');
  await commit(ctx, company.id, user.id, 'consent', { kind, version: CONSENT_VERSION }, [['INSERT INTO consent (id, user_id, company_id, kind, version, at) VALUES (?,?,?,?,?,?)', newId('cn'), user.id, company.id, kind, CONSENT_VERSION, ctx.now()]]);
}
export async function consentsOf(ctx, user) {
  const rows = await ctx.db.all('SELECT DISTINCT kind FROM consent WHERE user_id = ?', user.id);
  return { employee_notice: rows.some((r) => r.kind === 'employee_notice'), penalty_rules: rows.some((r) => r.kind === 'penalty_rules') };
}

export async function updateSettings(ctx, company, actor, patch) {
  const cur = JSON.parse(company.settings || '{}');
  assertV1Settings(ctx.env, company, patch);
  if (company.provider === 'moneypenny' && patch.bonus_max_pct !== undefined && (await ctx.db.first("SELECT 1 x FROM season WHERE company_id = ? AND mode = 'dice'", company.id))) {
    const top = (await ctx.db.first('SELECT MAX(credits) m FROM rate_card WHERE company_id = ?', company.id))?.m ?? 0;
    assertCreditAmount(company, Math.ceil((top * Number(patch.bonus_max_pct)) / 100), 'The top of the dice bonus');
  }
  const next = { ...cur, ...validateSettings(patch) };
  await commit(ctx, company.id, actor.id, 'settings.update', { keys: Object.keys(patch) }, [['UPDATE company SET settings = ? WHERE id = ?', JSON.stringify(next), company.id]]);
  return settingsOf({ settings: JSON.stringify(next) });
}
export { DEFAULTS };

// ---------- DPDP: correction, scrub of leavers, retention, key rotation ----------
export const RETENTION_NOTE = 'We keep ids, events, rewards and the audit trail: the company needs them for its accounts and for appeals. The name, e-mail and work id of a person who left are scrubbed when they ask, or when an admin or HR runs the scrub after the retention period (retention_days, 365 by default).';

/** Correct a person's own details (name, work id, e-mail). The person does it for themselves; an admin may do it on a rights request. */
export async function correctDetails(ctx, company, actor, personId, input) {
  const p = await ctx.db.first("SELECT * FROM app_user WHERE id = ? AND company_id = ? AND status = 'active'", personId, company.id);
  if (!p) throw new ApiError(404, 'no_person', 'No such person.');
  if (actor.id !== p.id && actor.role !== 'admin') throw new ApiError(403, 'not_allowed', 'You can only correct your own details.');
  const sets = [], par = [], fields = [];
  if (input.name !== undefined) {
    const n = clean(input.name, 80);
    if (!n) throw new ApiError(400, 'bad_name', 'A name is needed.');
    sets.push('name_sealed = ?'); par.push(await ctx.seal(n, 'app_user.name:' + p.id)); fields.push('name');
  }
  if (input.work_id !== undefined) {
    const w = clean(input.work_id, 60);
    sets.push('work_id_sealed = ?', 'work_id_hash = ?'); par.push(w ? await ctx.seal(w, 'app_user.work_id:' + p.id) : null, w ? await ctx.hash('workid', w) : null); fields.push('work_id');
  }
  if (input.email !== undefined) {
    const e = normEmail(input.email);
    if (!isEmail(e)) throw new ApiError(400, 'bad_email', 'A valid work e-mail is needed.');
    const eh = await ctx.hash('email', e);
    if (await ctx.db.first('SELECT id FROM app_user WHERE email_hash = ? AND id != ?', eh, p.id)) throw new ApiError(409, 'email_taken', 'This e-mail cannot be used. It may already be in use.');
    sets.push('provider_account_ref = NULL'); sets.push('email_hash = ?', 'email_sealed = ?'); par.push(eh, await ctx.seal(e, 'app_user.email:' + p.id)); fields.push('email');
  }
  if (!sets.length) throw new ApiError(400, 'nothing', 'Send name, work_id or email.');
  await commit(ctx, company.id, actor.id, 'person.correct', { person: p.id, fields }, [['UPDATE app_user SET ' + sets.join(', ') + ' WHERE id = ? AND company_id = ?', ...par, p.id, company.id]]);
  return { ok: true, fields };
}

/** Scrub the sealed name, e-mail and work id (and the e-mail hash) of a person who has left. Ids and the ledger stay. */
/** The audit chain can be busy when many writers commit at once (the batch is rolled back, nothing applied): try a few times with a small back-off before failing. */
async function withBusyRetry(fn, tries = 6) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) { if (i >= tries - 1 || !/audit chain is busy/i.test(String(e?.message))) throw e; await new Promise((r) => setTimeout(r, 5 * (i + 1) + Math.floor(Math.random() * 10))); }
  }
}
export async function eraseLeaver(ctx, company, actor, personId) {
  if (!['admin', 'hr'].includes(actor.role)) throw new ApiError(403, 'not_allowed', 'Only the company admin or HR can do this.');
  const p = await ctx.db.first('SELECT * FROM app_user WHERE id = ? AND company_id = ?', personId, company.id);
  if (!p) throw new ApiError(404, 'no_person', 'No such person.');
  if (p.status !== 'left') throw new ApiError(409, 'still_active', 'Remove the person first. Only people who left can be scrubbed.');
  if (p.erased_at) return { ok: true, already: true, note: RETENTION_NOTE };
  // Machine-API leftovers: requests about this person (by id, or mentioning their e-mail or name) lose their text, pending ones are cancelled,
  // and stored idempotent answers about them are dropped. Read the sealed values BEFORE they are wiped.
  const email = p.email_sealed ? await ctx.unseal(p.email_sealed, 'app_user.email:' + p.id).catch(() => '') : '';
  const name = p.name_sealed ? await ctx.unseal(p.name_sealed, 'app_user.name:' + p.id).catch(() => '') : '';
  const likeOf = (x) => '%' + x.toLowerCase().replace(/[\\%_]/g, (m) => '\\' + m) + '%';
  const needles = [email, name.length >= 4 ? name : ''].filter(Boolean).map(likeOf);
  const hit = ['person_id = ?', ...needles.flatMap(() => ["lower(payload) LIKE ? ESCAPE '\\'", "lower(COALESCE(reason, '')) LIKE ? ESCAPE '\\'"])].join(' OR ');
  const aiScrub = ["UPDATE ai_request SET payload = '{\"erased\":true}', reason = '', result = NULL, status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END, run_state = NULL WHERE company_id = ? AND (" + hit + ')', company.id, p.id, ...needles.flatMap((x) => [x, x])];
  const idemScrub = ["UPDATE api_idem SET body = NULL, subject = NULL WHERE subject IS NOT NULL AND instr(subject, ',' || ? || ',') > 0 AND key_id IN (SELECT key_id FROM company_key WHERE company_id = ?)", p.id, company.id];
  await withBusyRetry(() => commit(ctx, company.id, actor.id, 'person.erase', { person: p.id }, [
    ["UPDATE app_user SET name_sealed = NULL, email_sealed = '', email_hash = ?, work_id_sealed = NULL, work_id_hash = NULL, provider_account_ref = NULL, erased_at = ? WHERE id = ? AND company_id = ?", 'erased:' + p.id, ctx.now(), p.id, company.id],
    ['DELETE FROM session WHERE user_id = ? AND company_id = ?', p.id, company.id],
    ['DELETE FROM login_code WHERE user_id = ?', p.id],
    ["UPDATE rights_request SET note = '' WHERE person_id = ? AND company_id = ?", p.id, company.id],
    ['UPDATE swap_offer SET help_text = NULL WHERE from_person = ? AND company_id = ?', p.id, company.id],
    aiScrub, idemScrub,
    // the reward rows keep amounts, ids, states and the maybe_landed marker; the sealed account and any admin/ledger note are scrubbed
    ["UPDATE reward SET note = " + SCRUB_NOTE_SQL + " WHERE person_id = ? AND company_id = ?", p.id, company.id],
  ]));
  return { ok: true, note: RETENTION_NOTE };
}
/** Leavers whose retention period has passed and who are not scrubbed yet. */
export async function retentionDue(ctx, company) {
  const days = settingsOf(company).retention_days;
  const rows = await ctx.db.all("SELECT id, left_at FROM app_user WHERE company_id = ? AND status = 'left' AND erased_at IS NULL AND left_at IS NOT NULL AND left_at < ?", company.id, ctx.now() - days * DAY);
  return { retention_days: days, due: rows, note: RETENTION_NOTE };
}

/** Key rotation: re-seal every sealed value with the current key and the record label, rebuild the lookup hashes with the current MASTER_SECRET. See docs/ROTATION.md. */
export async function resealAll(ctx) {
  const n = { people: 0, keys: 0 };
  const redo = async (blob, label) => (blob ? ctx.seal(await ctx.unseal(blob), label) : blob);
  for (const u of await ctx.db.all('SELECT * FROM app_user')) {
    const email = u.email_sealed ? await ctx.unseal(u.email_sealed) : null, wid = u.work_id_sealed ? await ctx.unseal(u.work_id_sealed) : null;
    await ctx.db.run('UPDATE app_user SET name_sealed = ?, email_sealed = ?, work_id_sealed = ?, email_hash = ?, work_id_hash = ?, provider_account_ref = ? WHERE id = ?',
      await redo(u.name_sealed, 'app_user.name:' + u.id), email ? await ctx.seal(email, 'app_user.email:' + u.id) : u.email_sealed,
      wid ? await ctx.seal(wid, 'app_user.work_id:' + u.id) : null,
      email ? await ctx.hash('email', normEmail(email)) : u.email_hash, wid ? await ctx.hash('workid', wid) : null, await redo(u.provider_account_ref, ''), u.id);
    n.people++;
  }
  for (const r of await ctx.db.all("SELECT id, note FROM reward WHERE json_extract(COALESCE(note, '{}'), '$.acct') IS NOT NULL")) { // the account sealed on a reward row (the first try's account)
    const nn = JSON.parse(r.note); nn.acct = await ctx.seal(await ctx.unseal(nn.acct, 'reward.acct:' + r.id), 'reward.acct:' + r.id);
    await ctx.db.run('UPDATE reward SET note = ? WHERE id = ?', JSON.stringify(nn), r.id);
  }
  const { secretOfKey } = await import('./setup.js');
  for (const k of await ctx.db.all('SELECT * FROM company_key')) {
    await ctx.db.run('UPDATE company_key SET secret_sealed = ? WHERE key_id = ?', await ctx.seal(await secretOfKey(ctx, k), 'company_key.secret:' + k.key_id), k.key_id);
    n.keys++;
  }
  return { ...n, sealed_with: ctx.sealKeyId };
}
