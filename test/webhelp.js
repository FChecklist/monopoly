// HTTP test world: sign in as a person (session cookie), or call signed as a key.
import assert from 'node:assert/strict';
import { world } from './helpers.js';
import { handle } from '../src/api.js';
import { hmacHex } from '../src/util.js';
import { issueCode } from '../src/people.js';

export async function boot(opts) {
  const w = await world(opts);
  w.sessions = {}; w.codes = { ...w.codes };
  w.call = async (who, method, path, body, hdrs = {}) => {
    const headers = { 'content-type': 'application/json', ...hdrs };
    if (who && w.sessions[who]) headers.cookie = 'floor_session=' + w.sessions[who];
    if (method !== 'GET' && who) headers['x-floor'] = '1';
    const res = await handle(w.ctx, new Request('https://floor.test' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: res.status, json: await res.json(), headers: res.headers };
  };
  w.login = async (who) => {
    const email = (who === 'admin' ? 'boss' : who) + '@acme.test';
    const u = await w.db.first('SELECT * FROM app_user WHERE email_hash = ?', await w.ctx.hash('email', email));
    w.codes[who] = await issueCode(w.ctx, u);
    const r = await w.call(null, 'POST', '/api/auth/login', { email, code: w.codes[who] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    w.sessions[who] = /floor_session=([a-f0-9]+)/.exec(r.headers.get('set-cookie'))[1];
  };
  w.ctx.env.PLATFORM_TOKEN = 'platform-token-0123456789-abcdef';
  return w;
}
let nonce = 0;
/** A signed call as a key. Returns { status, json, headers }. over = extra headers (for example Idempotency-Key). */
export async function keyCall(w, key, method, path, body, over = {}) {
  const raw = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  const ts = String(w.clock.t + (nonce++ % 1000)); // distinct signature for every call
  const headers = { 'x-key-id': key.key_id, 'x-timestamp': ts, 'x-signature': await hmacHex(key.secret, ts + '.' + method + ' ' + path + '.' + raw), 'content-type': 'application/json', ...over };
  const res = await handle(w.ctx, new Request('https://floor.test' + path, { method, headers, body: method === 'GET' ? undefined : raw }));
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, headers: res.headers, text };
}
