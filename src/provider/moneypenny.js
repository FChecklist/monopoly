// The one door to Corporate Moneypenny. It speaks Moneypenny's real, signed API (see CONTRACT/MAPPING.md).
// Moneypenny identifies people by verified e-mail, so accountRef = the person's work e-mail (sealed in our DB).
// Features Moneypenny does not have today (budget holds, debit, reversal of a bonus) are reported as false in
// capabilities(); the game then switches the matching feature off. It never fakes them with its own numbers.
import { ProviderError, NO_CAPS } from './errors.js';
import { hmacHex, sha256Hex, newId } from '../util.js';

const MAP_CODES = {
  insufficient_credits: 'insufficient_credits', cap_reached: 'cap_reached', daily_cap_reached: 'cap_reached', limit_reached: 'cap_reached',
  account_frozen: 'account_closed', frozen: 'account_closed', rate_limited: 'rate_limited', conversion_off: 'unsupported',
};

export class MoneypennyProvider {
  /** cfg: { baseUrl, keyId, secret, product? }. fetchImpl and clock can be replaced in tests. */
  constructor(cfg, { fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    if (!cfg?.baseUrl || !cfg.keyId || !cfg.secret) throw new ProviderError('bad_request', 'Moneypenny settings are incomplete.');
    if (!/^https:\/\//.test(cfg.baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(cfg.baseUrl)) throw new ProviderError('bad_request', 'Moneypenny must be reached over https.');
    this.cfg = cfg; this.fetch = fetchImpl; this.now = now; this.name = 'moneypenny';
  }
  async capabilities() { return { ...NO_CAPS, spend: true }; }
  async link() { return { tenant_ref: this.cfg.tenantRef ?? 'key:' + this.cfg.keyId, capabilities: await this.capabilities() }; }
  async ensureAccount({ email }) { return { account_ref: String(email).toLowerCase() }; }

  async #call(method, path, body, idem) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const ts = String(this.now());
    const nonce = newId('n');
    const sig = await hmacHex(this.cfg.secret, [ts, nonce, method, path, await sha256Hex(raw)].join('\n'));
    const headers = { 'x-mnp-key': this.cfg.keyId, 'x-mnp-timestamp': ts, 'x-mnp-nonce': nonce, 'x-mnp-signature': sig, 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = String(idem ?? nonce).slice(0, 120);
    let res;
    try { res = await this.fetch(this.cfg.baseUrl.replace(/\/$/, '') + path, { method, headers, body: raw || undefined }); }
    catch { throw new ProviderError('provider_down', 'Moneypenny could not be reached.', { retriable: true }); }
    let j = null;
    try { j = await res.json(); } catch { /* not json */ }
    if (res.status >= 500) throw new ProviderError('provider_down', 'Moneypenny is down.', { retriable: true });
    if (res.status === 429) throw new ProviderError('rate_limited', 'Slow down.', { retriable: true });
    if (!res.ok || j?.ok === false) {
      const code = j?.error?.code ?? 'bad_request';
      throw new ProviderError(MAP_CODES[code] ?? (res.status === 402 ? 'insufficient_credits' : 'bad_request'), j?.error?.message ?? code);
    }
    return { json: j, replay: res.headers?.get?.('idempotent-replay') === 'true' };
  }

  async getBalance({ accountRef }) {
    const { json } = await this.#call('GET', '/v1/balance?email=' + encodeURIComponent(accountRef));
    return { balance: json.balance, spendable: json.balance, holds: 0, next_expiry_at: json.next_expiry ?? null, unit_name: json.display?.label ?? 'Moneypenny Credits' };
  }
  async credit({ accountRef, amount, reasonCode, ref, idem }) {
    if (!Number.isInteger(amount) || amount <= 0) throw new ProviderError('bad_request', 'amount');
    const { json, replay } = await this.#call('POST', '/v1/credit', { email: accountRef, bucket: 'bonus', amount, ref: String(ref ?? idem).slice(0, 120) }, idem);
    if (json.granted === false || json.granted === 0) throw new ProviderError('cap_reached', 'Moneypenny did not grant the credit.');
    // A partial grant is reported as partial, never recorded as the full amount.
    const granted = Number.isInteger(json.granted) && json.granted > 0 && json.granted < amount ? json.granted : amount;
    return { entry_id: idem, balance: json.balance ?? null, duplicate: replay, granted, partial: granted < amount };
  }
  async history({ accountRef, limit = 50 }) {
    const { json } = await this.#call('GET', `/v1/history?email=${encodeURIComponent(accountRef)}&limit=${limit}`);
    return { lines: (json.entries ?? json.lines ?? []).map((e) => ({ entry_id: e.id ?? e.seq, kind: e.kind, amount: e.delta, ref: e.ext_ref, at: e.at })) };
  }
  async reserveSpend({ accountRef, amount, ref, idem, item }) {
    const { json } = await this.#call('POST', '/v1/spend/reserve_item', { email: accountRef, product: this.cfg.product ?? 'floor', item: item ?? ref, order_ref: ref, credits: amount }, idem);
    return { hold_id: json.hold_id, credit_applied: json.credits };
  }
  async captureSpend({ holdId, idem }) {
    const { json } = await this.#call('POST', '/v1/spend/capture', { hold_id: holdId }, idem);
    return { entry_id: json.status === 'captured' ? 'cap_' + holdId : null };
  }
  async releaseSpend({ holdId, idem }) {
    await this.#call('POST', '/v1/spend/release', { hold_id: holdId }, idem);
    return { released: 1 };
  }
  async startPurchase({ accountRef, credits, ref, idem }) {
    const { json } = await this.#call('POST', '/v1/buy_credits', { email: accountRef, credits, order_ref: ref }, idem);
    return { purchase_id: json.order_id, pay_url: json.pay_url };
  }
  // Not offered by Moneypenny today. The game checks capabilities() first and never calls these.
  async reserveBudget() { throw new ProviderError('unsupported'); }
  async releaseHold() { throw new ProviderError('unsupported'); }
  async debit() { throw new ProviderError('unsupported'); }
  async reverse() { throw new ProviderError('unsupported'); }
  async creditBatch() { throw new ProviderError('unsupported'); }
}
