// A fake Moneypenny for the real adapter (shared by the round-20 tests): history ref "manual:<ref>", ext_ref null, pages of 100, duplicate_ref before headroom, max 500, lifetime cap.
import { world } from './helpers.js';
import { MoneypennyProvider } from '../src/provider/moneypenny.js';
const A = 'a@acme.test';
/** Fake Moneypenny (see money-round18): history ref "manual:<ref>", ext_ref null, pages of 100 with next_before_seq, 30-day idempotency purge is simulated by st.idem.clear(). */
export function fakeMnp({ lifetime = 800, now = () => Date.now() } = {}) {
  const st = { events: new Map(), idem: new Map(), grants: [], lifetime, down: false, lose: 0, calls: [] };
  const mine = (email) => st.grants.filter((g) => g.email === email);
  st.fetchImpl = async (url, init) => {
    const u = new URL(url), path = u.pathname, key = (init.headers ?? {})['idempotency-key'] ?? null;
    const rep = (status, j, extra = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => extra[k] ?? null }, json: async () => j });
    st.calls.push({ path, key, q: u.search });
    if (st.down) throw new TypeError('fetch failed');
    if (path === '/v1/history') {
      const all = mine(u.searchParams.get('email')).map((g, i) => ({ id: i + 1, kind: 'bonus', delta: g.amount, ref: 'manual:' + g.ref, ext_ref: null })).reverse();
      const limit = Math.min(+u.searchParams.get('limit') || 50, 100); const before = u.searchParams.get('before_seq');
      const rows = all.filter((e) => before == null || e.id < +before).slice(0, limit);
      return rep(200, { ok: true, entries: rows, next_before_seq: rows.length === limit ? rows[rows.length - 1].id : null });
    }
    if (path !== '/v1/credit') return rep(404, { ok: false, error: { code: 'not_found' } });
    const body = init.body ?? '', j = JSON.parse(body), prior = st.idem.get(key);
    if (prior) return prior.body !== body ? rep(400, { ok: false, error: { code: 'idempotency_conflict' } }) : rep(200, prior.res, { 'idempotent-replay': 'true' });
    if (st.events.has('manual:' + j.ref)) return rep(409, { ok: false, error: { code: 'duplicate_ref' } });
    if (j.amount > 500) return rep(400, { ok: false, error: { code: 'bad_amount' } });
    const total = mine(j.email).reduce((a, g) => a + g.amount, 0), headroom = Math.min(j.amount, st.lifetime - total);
    if (headroom < 1) return rep(422, { ok: false, error: { code: 'cap_reached' } });
    st.events.set('manual:' + j.ref, true); st.grants.push({ email: j.email, amount: headroom, ref: j.ref, at: now() });
    const res = { ok: true, granted: headroom, balance: total + headroom }; st.idem.set(key, { body, res });
    if (st.lose > 0) { st.lose--; throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); }
    return rep(200, res);
  };
  st.total = (email) => mine(email).reduce((a, g) => a + g.amount, 0);
  st.credits = () => st.calls.filter((c) => c.path === '/v1/credit').length;
  return st;
}
export async function mworld(mopts = {}, wopts = {}) {
  let clock; const f = fakeMnp({ ...mopts, now: () => clock?.t ?? Date.now() });
  const prov = new MoneypennyProvider({ baseUrl: 'https://mnp.test', keyId: 'k', secret: 's'.repeat(32) }, { fetchImpl: f.fetchImpl });
  const w = await world({ v1: true, providerOverride: () => prov, ...wopts, settings: { cap_person_month: 1e6, cap_person_season: 1e6, cap_period_bonus_person_period: 1e6, cap_event: 500, ...(wopts.settings ?? {}) } });
  clock = w.clock; w.f = f;
  await w.db.run("UPDATE company SET provider = 'moneypenny' WHERE id = ?", w.company.id); await w.reload();
  return w;
}
