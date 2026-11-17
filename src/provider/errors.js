// Errors a credit provider may raise. Stable codes (contract v1).
export const PROVIDER_CODES = ['insufficient_budget', 'hold_expired', 'account_closed', 'cap_reached', 'duplicate', 'unsupported', 'rate_limited', 'provider_down', 'bad_request', 'insufficient_credits'];
export class ProviderError extends Error {
  constructor(code, message = code, { retriable = false } = {}) {
    super(message);
    this.code = code;
    this.retriable = retriable || code === 'provider_down' || code === 'rate_limited';
  }
}
/** Features a provider may not have. The game turns the matching feature off instead of faking it. */
export const NO_CAPS = { hold: false, debit: false, reverse: false, expiry: false, batch: false, cash_out: false, spend: false, max_batch: 1 };
