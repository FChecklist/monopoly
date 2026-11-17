// The ONLY place that picks a credit provider. Nothing else in the game may import a provider class.
import { StubProvider } from './stub.js';
import { MoneypennyProvider } from './moneypenny.js';
import { ProviderError } from './errors.js';

export { ProviderError } from './errors.js';

/** env: { MNP_BASE_URL, MNP_KEY_ID, MNP_SECRET, ALLOW_DEMO_PROVIDER }. Secrets come from the environment, never the database. */
export function getProvider(env, db, company, opts = {}) {
  if (company.provider === 'moneypenny') {
    // One signing key belongs to ONE company. Either a per-company key map (MNP_KEYS = JSON {company_id: {key_id, secret}})
    // or the single global key, which is only usable by the company named in MNP_COMPANY_ID. Never shared across companies.
    let keyId = null, secret = null;
    if (env.MNP_KEYS) {
      let map = {};
      try { map = typeof env.MNP_KEYS === 'string' ? JSON.parse(env.MNP_KEYS) : env.MNP_KEYS; } catch { map = {}; }
      const k = map?.[company.id];
      if (k?.key_id && k?.secret) { keyId = k.key_id; secret = k.secret; }
    }
    if (!keyId) {
      if (!env.MNP_COMPANY_ID || env.MNP_COMPANY_ID !== company.id) throw new ProviderError('unsupported', 'No Moneypenny key is set up for this company.');
      keyId = env.MNP_KEY_ID; secret = env.MNP_SECRET;
    }
    return new MoneypennyProvider({ baseUrl: env.MNP_BASE_URL, keyId, secret, tenantRef: company.provider_tenant_ref }, opts);
  }
  if (company.provider === 'stub') {
    if (company.live) throw new ProviderError('unsupported', 'The demo provider is refused for a live company.');
    if (String(env.ALLOW_DEMO_PROVIDER) !== '1') throw new ProviderError('unsupported', 'The demo provider is switched off in this deployment.');
    return new StubProvider(db, company.id, opts);
  }
  throw new ProviderError('unsupported', 'Unknown credit provider.');
}
