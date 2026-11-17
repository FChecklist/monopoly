// Seal personal data at rest (AES-GCM). Keys come from secrets (SEAL_KEY, optionally SEAL_KEYS_OLD), never from code.
// Format s2: s2.<key id>.<b64 label>.<b64 iv>.<b64 ciphertext>. The label (table.column:row id) is also the AES-GCM
// additional data, so a sealed blob cannot be moved to another row without being noticed by callers that pass the label.
// Format s1 (older: s1.<iv>.<ct>, no key id, no label) can still be read. See docs/ROTATION.md.
import { hmacHex } from './util.js';
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const cache = new Map();
async function key(secret) {
  if (!cache.has(secret)) {
    const raw = await crypto.subtle.digest('SHA-256', enc.encode('seal:' + secret));
    cache.set(secret, await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']));
  }
  return cache.get(secret);
}
/** keys = { id, secret, old: [{id, secret}] }. A bare string is accepted as a single key (older callers). */
const norm = (k) => (typeof k === 'string' ? { id: 'k1', secret: k, old: [] } : k);

export async function seal(keys, text, aad = '') {
  if (text == null) return null;
  keys = norm(keys);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, await key(keys.secret), enc.encode(String(text))));
  return ['s2', keys.id, b64(enc.encode(aad)), b64(iv), b64(ct)].join('.');
}
/** Which key id sealed this blob (null for the older s1 format or an empty value). */
export const sealedWith = (blob) => { const p = String(blob ?? '').split('.'); return p[0] === 's2' ? p[1] : null; };

export async function unseal(keys, blob, aad) {
  if (blob == null || blob === '') return null; // erased or never set
  keys = norm(keys);
  const p = String(blob).split('.');
  const all = [{ id: keys.id, secret: keys.secret }, ...(keys.old ?? [])];
  if (p[0] === 's1') {
    for (const k of all) { try { return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(p[1]) }, await key(k.secret), unb64(p[2]))); } catch { /* try the next key */ } }
    throw new Error('bad seal');
  }
  if (p[0] !== 's2' || p.length !== 5) throw new Error('bad seal');
  const label = dec.decode(unb64(p[2]));
  if (aad !== undefined && aad !== label) throw new Error('seal belongs to another record');
  const order = [...all.filter((k) => k.id === p[1]), ...all.filter((k) => k.id !== p[1])];
  for (const k of order) {
    try { return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(p[3]), additionalData: enc.encode(label) }, await key(k.secret), unb64(p[4]))); } catch { /* try the next key */ }
  }
  throw new Error('bad seal');
}
/** Keyed hash for lookups (login e-mail, lead de-duplication). Pseudonymised, not anonymous. */
export const keyedHash = (secret, purpose, value) => hmacHex(secret, `${purpose}:${value}`);
