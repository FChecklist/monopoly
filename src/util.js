// Small shared helpers: ids, hashing, errors, India-time periods.
export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(s) {
  return hex(await crypto.subtle.digest('SHA-256', typeof s === 'string' ? enc.encode(s) : s));
}
export async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
export function safeEqual(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
export function newId(prefix = 'id') {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return prefix + '_' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export function randomCode(n = 8) {
  const al = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => al[x % al.length]).join('');
}
export const normEmail = (e) => String(e ?? '').trim().toLowerCase();
export const isEmail = (e) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e);
export const int = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
export function mustInt(v, name, { min = 0, max = 1e9 } = {}) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ApiError(400, 'bad_number', `${name} must be a whole number from ${min} to ${max}.`);
  return n;
}
export const clean = (s, max = 200) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
/** Defuse spreadsheet formulas on anything read from a file. */
export const defuse = (s) => (/^[=+\-@\t\r]/.test(String(s)) ? "'" + s : String(s));

// ---------- India-time periods ----------
const IST = 330 * MIN;
const clock = (ms) => new Date(ms + IST); // read with getUTC*
const fromClock = (y, m, d = 1) => Date.UTC(y, m, d) - IST;
export const PERIODS = ['week', 'month', 'quarter', 'half', 'year'];

/** Bounds of the period that contains `ms`. end is exclusive. fy = first month (1..12) of the company year. */
export function periodOf(period, ms, fy = 4) {
  const c = clock(ms);
  const y = c.getUTCFullYear(), mo = c.getUTCMonth();
  if (period === 'week') {
    const dow = (c.getUTCDay() + 6) % 7; // Monday = 0
    const start = fromClock(y, mo, c.getUTCDate() - dow);
    const k = new Date(start + IST);
    return { key: `W${k.getUTCFullYear()}-${String(k.getUTCMonth() + 1).padStart(2, '0')}-${String(k.getUTCDate()).padStart(2, '0')}`, start, end: start + 7 * DAY, period };
  }
  if (period === 'month') return { key: `M${y}-${String(mo + 1).padStart(2, '0')}`, start: fromClock(y, mo), end: fromClock(y, mo + 1), period };
  const fyYear = mo + 1 >= fy ? y : y - 1;
  const m0 = (mo + 1 - fy + 12) % 12;
  const months = period === 'quarter' ? 3 : period === 'half' ? 6 : 12;
  const idx = Math.floor(m0 / months);
  const startMonth = fy - 1 + idx * months; // may exceed 11: Date.UTC rolls over
  const tag = period === 'quarter' ? 'Q' : period === 'half' ? 'H' : 'Y';
  return { key: `${tag}${fyYear}-${idx + 1}`, start: fromClock(fyYear, startMonth), end: fromClock(fyYear, startMonth + months), period };
}
/** The period just before the one containing ms. */
export const prevPeriod = (period, ms, fy) => periodOf(period, periodOf(period, ms, fy).start - 1, fy);
export const monthKey = (ms) => periodOf('month', ms).key;
export const dayKey = (ms) => {
  const c = clock(ms);
  return `${c.getUTCFullYear()}-${String(c.getUTCMonth() + 1).padStart(2, '0')}-${String(c.getUTCDate()).padStart(2, '0')}`;
};

// ---------- one response shape for the whole API ----------
export const SEC_HEADERS = {
  'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
};
export const jsonOut = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { ...SEC_HEADERS, ...extra } });
/** True when an Origin header names this same host. Anything unparseable (for example "null") is not same-site. */
export function sameOrigin(origin, host) {
  try { return new URL(origin).host === host; } catch { return false; }
}
/** Parse a JSON body into an object. Empty is {}. Anything that is not an object is {}. */
export function parseBody(raw) {
  if (!raw) return {};
  try { const j = JSON.parse(raw); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { throw new ApiError(400, 'bad_json', 'The body is not valid JSON.'); }
}
/** A list limit from a query string: missing or not a number gives the default; always between 1 and max. */
export function clampLimit(raw, def = 50, max = 100) {
  const n = raw == null || raw === '' ? NaN : Number(raw);
  return Math.max(1, Math.min(max, Number.isFinite(n) ? Math.trunc(n) : def));
}
