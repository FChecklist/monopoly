// Run the clock from outside: one signed call to POST /api/ingest/tick (CONTRACT/signed-v1.md).
// TICK_URL (https://host), TICK_KEY_ID and TICK_SECRET come from the environment; nothing is stored in the repo.
import { createHmac } from 'node:crypto';

const { TICK_URL, TICK_KEY_ID, TICK_SECRET } = process.env;
if (!TICK_URL || !TICK_KEY_ID || !TICK_SECRET) { console.error('Set TICK_URL, TICK_KEY_ID and TICK_SECRET.'); process.exit(2); }
const path = '/api/ingest/tick', body = '{}', ts = String(Date.now());
const sig = createHmac('sha256', TICK_SECRET).update(`${ts}.POST ${path}.${body}`).digest('hex');
const res = await fetch(TICK_URL.replace(/\/$/, '') + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-key-id': TICK_KEY_ID, 'x-timestamp': ts, 'x-signature': sig }, body });
console.log('tick', res.status);
if (!res.ok) process.exit(1);
