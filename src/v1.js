// v1 is CREDIT-ONLY. Season budget holds, credit-loss penalties (debit/restore) and credit reversals are NOT ENABLED in v1:
// the code is kept, unreachable and unaudited. This is the ONE place that decides it (used by provider/index.js, setup of settings and makeCtx).
// Only the demo provider of a non-live company in a non-production deployment can switch them on, with FUTURE_OPS=1 (tests and local demos).
import { ApiError } from './util.js';

export const FUTURE_CAPS = ['hold', 'debit', 'reverse'];
const isProd = (env) => /^prod/i.test(String(env?.ENVIRONMENT ?? env?.NODE_ENV ?? ''));
export const futureOn = (env, company) => String(env?.FUTURE_OPS) === '1' && !company?.live && !isProd(env);

/** Startup / deploy check: the switch must never be set in a production deployment. */
export function assertStartup(env) {
  if (String(env?.FUTURE_OPS) === '1' && isProd(env)) throw new Error('FUTURE_OPS is a test-only switch and must not be set in production: hold, debit and reverse are not enabled in v1.');
}
/** Moneypenny grants at most 500 credits in ONE bonus (manual_bonus_max). v1 does not split a credit: anything above is refused when it is configured (and again, as a safety net, when it would be sent). */
export const MAX_SINGLE_CREDIT = 500;
export function assertCreditAmount(company, n, what) {
  if (company?.provider === 'moneypenny' && Number(n) > MAX_SINGLE_CREDIT) throw new ApiError(400, 'above_provider_max', `${what} (${n}) is above Moneypenny's single bonus maximum (${MAX_SINGLE_CREDIT}). Use a smaller amount.`);
}
/** A company setting that would enable credit-loss penalties is refused while the future abilities are off. */
export function assertV1Settings(env, company, patch) {
  if (patch) for (const k of ['cap_event', 'lap_bonus_credits']) if (patch[k] !== undefined) assertCreditAmount(company, patch[k], 'The setting ' + k);
  if (patch && (patch.penalty_credit_loss === true || patch.penalty_credit_loss === 'true') && !futureOn(env, company)) {
    throw new ApiError(409, 'not_enabled_in_v1', 'Credit-loss penalties are not enabled in v1 (penalties are points and steps only).');
  }
}
/** Capabilities as the game sees them: hold/debit/reverse are false in v1. A real provider that DECLARES them is a configuration error, not something to use. */
export function v1Caps(env, company, caps, isDemo) {
  if (futureOn(env, company)) return caps;
  const out = { ...caps };
  for (const k of FUTURE_CAPS) {
    if (!caps[k]) continue;
    if (!isDemo) throw Object.assign(new Error(`The provider declares "${k}", which is not enabled in v1.`), { v1: true });
    out[k] = false;
  }
  return out;
}
