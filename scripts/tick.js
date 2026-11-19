// Run the clock from outside: signed calls to POST /api/ingest/tick (CONTRACT/signed-v1.md). Every call is its OWN worker invocation with its own limits, so this loops:
// first a core turn (sending, releases, reversals, penalty notices) until nothing is left over, then settle turns (the period bonuses and streaks) until the backlog is 0.
// TICK_URL (https://host), TICK_KEY_ID and TICK_SECRET come from the environment; nothing is stored in the repo. TICK_MAX_CALLS (default 300) bounds one run.
import { createHmac } from 'node:crypto';

const { TICK_URL, TICK_KEY_ID, TICK_SECRET } = process.env;
if (!TICK_URL || !TICK_KEY_ID || !TICK_SECRET) { console.error('Set TICK_URL, TICK_KEY_ID and TICK_SECRET.'); process.exit(2); }
const path = '/api/ingest/tick', max = Number(process.env.TICK_MAX_CALLS) || 300;
let calls = 0, last = 0;
async function post(turn) {
  const body = JSON.stringify({ turn }), ts = String(Math.max(Date.now(), last + 1)); last = Number(ts);
  const sig = createHmac('sha256', TICK_SECRET).update(`${ts}.POST ${path}.${body}`).digest('hex');
  const res = await fetch(TICK_URL.replace(/[/]$/, '') + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-key-id': TICK_KEY_ID, 'x-timestamp': ts, 'x-signature': sig }, body });
  calls++;
  let j = null; try { j = await res.json(); } catch { /* not json */ }
  if (!res.ok) { console.error('tick', turn, res.status); process.exit(1); }
  return j ?? {};
}
// core: repeat while a stage was cut by its budget (more queued rewards to send, more to release), at most 20 turns
for (let i = 0; i < 20 && calls < max; i++) { const j = await post('core'); const cut = Object.entries(j).some(([k, v]) => k !== 'ok' && v && typeof v === 'object' && v.budget); console.log('core', i + 1, cut ? 'more' : 'done'); if (!cut) break; }
// settle: until the backlog is 0
for (let i = 0; calls < max; i++) { const j = await post('settle'); const left = j.backlog ?? j.settled?.backlog ?? 0; console.log('settle', i + 1, 'backlog', left); if (!left) break; }
console.log('ticks', calls);
