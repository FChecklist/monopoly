// Product config and per-company settings. Nothing about a company lives in code: it all lives in the database.
import { ApiError, mustInt } from './util.js';

export const PRODUCT = {
  name: 'Corporate Monopoly',           // product_name: the ONLY place the brand is a string. Change here or per company setting.
  slug: 'floor',                        // neutral code name, used in URLs, tables and keys
  tagline: 'Real work moves your token.',
  footer: 'Independent product. Not made by or linked to any board-game maker.',
};

export const DEFAULTS = {
  product_name: PRODUCT.name,
  unit_name: 'Moneypenny', unit_symbol: 'moneypenny', terms_url: '', ai_enabled: false, retention_days: 365, ai_retention_days: 90, credits_per_usd: 100, local_currency: 'INR', local_per_usd: 85,
  mode: 'steady',                       // steady (no random number) | dice (bonus roll on top of a fixed base)
  bonus_floor_pct: 10, bonus_max_pct: 50,
  squares: 24, start_points: 1000, lap_points: 200, lap_bonus_credits: 0,
  cap_person_month: 5000, cap_person_season: 15000, cap_event: 1000, cap_period_bonus_person_period: 5000,
  second_approver_over: 1000, backdate_days: 7, late_close_days: 7, fy_start_month: 4,
  dedupe_window_days: 365, csv_max_rows: 2000, daily_event_limit: 60,
  split_contrib_pct: 60, split_head_cap: 5000,
  reversal_window_days: 30, reversal_notice_days: 3, offset_max_pct: 50,
  penalty_cap_pct: 20, penalty_credit_loss: false,
  leaderboard: false, cards_on: false, cash_out: false,
};
const BOOL = ['penalty_credit_loss', 'leaderboard', 'cards_on', 'cash_out', 'ai_enabled'];

export function settingsOf(company) {
  let s = {};
  try { s = JSON.parse(company.settings || '{}'); } catch { s = {}; }
  const out = { ...DEFAULTS, ...s };
  out.cash_out = false; // never on in this product: cash-out is a provider and CA decision, off by design
  return out;
}

/** Validate a settings patch. Hard limits live here, in one place. */
export function validateSettings(patch) {
  const o = {};
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (!(k in DEFAULTS)) throw new ApiError(400, 'unknown_setting', `Unknown setting: ${k}`);
    if (BOOL.includes(k)) { o[k] = v === true || v === 'true'; continue; }
    if (['product_name', 'unit_name', 'unit_symbol', 'local_currency'].includes(k)) {
      const s = String(v ?? '').trim().slice(0, 40);
      if (!s) throw new ApiError(400, 'bad_setting', `${k} cannot be empty.`);
      o[k] = s; continue;
    }
    if (k === 'terms_url') {
      const u = String(v ?? '').trim();
      if (u === '') { o[k] = ''; continue; }
      let ok = u.length <= 300 && !/\s/.test(u);
      try { ok = ok && new URL(u).protocol === 'https:'; } catch { ok = false; }
      if (!ok) throw new ApiError(400, 'bad_setting', 'terms_url must be a web address that starts with https://');
      o[k] = u; continue;
    }
    if (k === 'retention_days') { o[k] = mustInt(v, k, { min: 30, max: 3650 }); continue; }
    if (k === 'ai_retention_days') { o[k] = mustInt(v, k, { min: 7, max: 3650 }); continue; }
    if (k === 'mode') {
      if (!['steady', 'dice'].includes(v)) throw new ApiError(400, 'bad_setting', 'mode must be steady or dice.');
      o[k] = v; continue;
    }
    const n = mustInt(v, k, { min: 0, max: /^(cap_|split_head_cap)/.test(k) ? 1_000_000 : 1_000_000_000 }); // caps have a hard ceiling
    o[k] = n;
  }
  if (o.penalty_cap_pct !== undefined && (o.penalty_cap_pct > 50)) throw new ApiError(400, 'bad_setting', 'The penalty cap can never be above 50 percent.');
  if (o.bonus_floor_pct !== undefined && o.bonus_floor_pct < 10) throw new ApiError(400, 'bad_setting', 'The bonus floor is never below 10 percent.');
  if (o.bonus_max_pct !== undefined && o.bonus_max_pct > 300) throw new ApiError(400, 'bad_setting', 'The bonus range is too wide.');
  if (o.fy_start_month !== undefined && (o.fy_start_month < 1 || o.fy_start_month > 12)) throw new ApiError(400, 'bad_setting', 'fy_start_month is 1 to 12.');
  if (o.split_contrib_pct !== undefined && o.split_contrib_pct > 100) throw new ApiError(400, 'bad_setting', 'split_contrib_pct is 0 to 100.');
  if (o.offset_max_pct !== undefined && o.offset_max_pct > 50) throw new ApiError(400, 'bad_setting', 'A correction may take at most 50 percent of one reward.');
  if (o.credits_per_usd !== undefined && o.credits_per_usd < 1) throw new ApiError(400, 'bad_setting', 'credits_per_usd must be at least 1.');
  if (o.squares !== undefined && o.squares !== 24) throw new ApiError(400, 'bad_setting', 'The ring has 24 squares in this version.');
  return o;
}

/** Our own ring: 24 squares in 6 zones of 4. Our names, our layout. */
export const ZONES = ['Front Hall', 'Desk Row', 'Meeting Rooms', 'Lift Lobby', 'Canteen', 'Roof Terrace'];
const L = [
  ['start', 'Start Desk'], ['desk', 'Window Desk'], ['desk', 'Corner Desk'], ['note', 'Surprise Note'],
  ['desk', 'Stand-up Desk'], ['desk', 'Quiet Desk'], ['hub', 'Team Hub North'], ['lane', 'Catch-up Lane'],
  ['desk', 'Huddle Desk'], ['note', 'Surprise Note'], ['desk', 'Whiteboard Desk'], ['rest', 'Rest Stop'],
  ['desk', 'Lobby Desk'], ['hub', 'Team Hub East'], ['desk', 'Stairwell Desk'], ['note', 'Surprise Note'],
  ['desk', 'Pantry Desk'], ['desk', 'Tea Counter Desk'], ['hub', 'Team Hub South'], ['note', 'Surprise Note'],
  ['desk', 'Terrace Desk'], ['landmark', 'Skyline Landmark'], ['desk', 'Garden Desk'], ['note', 'Surprise Note'],
];
export const SQUARES = L.map(([type, name], idx) => ({ idx, type, name, zone: ZONES[Math.floor(idx / 4)] }));
/** Shown with the hide-name switch, so nobody is told more privacy than they get. */
export const HIDE_NAME_NOTICE = 'Hiding your name shows you as Player N to other players. Your manager, HR and the company admin can still see your real name where their job needs it: approving or checking an event, a penalty case, a rights request, and team lists. Hiding your name does not hide your results from them.';
export const LEVEL_NAMES = ['Desk Hand', 'Floor Lead', 'Room Captain', 'Hall Hero'];
export const TOKENS = ['badge', 'mug', 'plant', 'rocket', 'lamp'];
