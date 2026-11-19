// One context object passed everywhere: database, secrets, clock, and the (single) route to a credit provider.
import { seal, unseal, keyedHash } from './seal.js';
import { getProvider } from './provider/index.js';
import { assertStartup } from './v1.js';
import { ApiError } from './util.js';

export const MIN_SECRET = 32;
/** SEAL_KEYS_OLD = "k0:oldsecret,k1:older" : keys that may still be needed to read older sealed values (rotation). */
const parseOld = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const i = x.indexOf(':'); return i > 0 ? { id: x.slice(0, i), secret: x.slice(i + 1) } : { id: 'old', secret: x }; });

export function makeCtx({ db, env = {}, now = () => Date.now(), providerOpts = {}, providerOverride = null, hubFetch = null }) {
  assertStartup(env);
  const secret = env.SEAL_KEY, master = env.MASTER_SECRET;
  if (!secret || !master || secret.length < MIN_SECRET || master.length < MIN_SECRET) throw new Error(`SEAL_KEY and MASTER_SECRET must be set (${MIN_SECRET}+ characters).`);
  const keys = { id: env.SEAL_KEY_ID || 'k1', secret, old: parseOld(env.SEAL_KEYS_OLD) };
  return {
    db, env, now, secret, master, hubFetch,
    /** aad = the record label, for example `app_user.name:${id}`. Pass the same label when reading. */
    seal: (t, aad = '') => seal(keys, t, aad),
    unseal: (b, aad) => unseal(keys, b, aad),
    sealKeyId: keys.id,
    hash: (purpose, v) => keyedHash(master, purpose, v),
    /** The only way into a provider. Tests can pass providerOverride (a fake that follows contract v1). */
    provider: (company) => (providerOverride ? providerOverride(company) : getProvider(env, db, company, { now, ...providerOpts })),
  };
}

export async function loadCompany(ctx, id) {
  const c = await ctx.db.first('SELECT * FROM company WHERE id = ?', id);
  if (!c || c.status !== 'active') throw new ApiError(404, 'no_company', 'Company not found.');
  return c;
}
export async function loadUser(ctx, companyId, userId) {
  return ctx.db.first('SELECT * FROM app_user WHERE id = ? AND company_id = ?', userId, companyId);
}
