// Run the clock from outside: signed calls to POST /api/ingest/tick (CONTRACT/signed-v1.md). Every call is its OWN worker invocation with its own limits, so this loops:
// first a core turn (sending, releases, reversals, penalty notices) until nothing is left over, then settle turns (the period bonuses and streaks) until the backlog is 0.
// TICK_URL (https://host), TICK_KEY_ID and TICK_SECRET come from the environment; nothing is stored in the repo. TICK_MAX_CALLS (default 300) bounds one run.
import { createHmac } from 'node:crypto';

const { TICK_URL, TICK_KEY_ID, TICK_SECRET } = process.env;
if (!TICK_URL || !TICK_KEY_ID || !TICK_SECRET) { console.error('Set TICK_URL, TICK_KEY_ID and TICK_SECRET.'); process.exit(2); }
const path = '/api/ingest/tick', max = Number(process.env.TICK_MAX_CALLS) || 300;
let calls = 0, last = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** One signed call. 429 (rate limit) is not a failure: wait for Retry-After (30 s when absent, at most 120 s), try again up to 5 times, and when it still says 429 end this run quietly (exit 0: the next run goes on).
 *  A 5xx or a network error is retried twice with a pause; only then the run fails (exit 1). */
async function post(turn) {
  let bad = 0, limited = 0;
  for (;;) {
    const body = JSON.stringify({ turn }), ts = String(Math.max(Date.now(), last + 1)); last = Number(ts);
    const sig = createHmac('sha256', TICK_SECRET).update(`${ts}.POST ${path}.${body}`).digest('hex');
    let res;
    try { res = await fetch(TICK_URL.replace(/[/]$/, '') + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-key-id': TICK_KEY_ID, 'x-timestamp': ts, 'x-signature': sig }, body }); }
    catch (e) { if (++bad > 2) { console.error('tick', turn, 'network error'); process.exit(1); } await sleep(5000 * bad); continue; }
    calls++;
    if (res.status === 429) {
      if (++limited > 5) { console.log('tick', turn, 'still rate limited: ending this run, the next one goes on'); console.log('ticks', calls); process.exit(0); }
      const wait = Math.min(120, Math.max(1, Number(res.headers.get('retry-after')) || 30 * limited));
      console.log('tick', turn, '429: waiting', wait, 's'); await sleep(wait * 1000); continue;
    }
    if (res.status >= 500) { if (++bad > 2) { console.error('tick', turn, res.status); process.exit(1); } await sleep(5000 * bad); continue; }
    let j = null; try { j = await res.json(); } catch { /* not json */ }
    if (!res.ok) { console.error('tick', turn, res.status); process.exit(1); } // a 4xx other than 429 is a setup problem (key, signature, switches): the run fails so somebody looks
    return j ?? {};
  }
}
// core: repeat while a stage was cut by its budget (more queued rewards to send, more to release), at most 20 turns
for (let i = 0; i < 20 && calls < max; i++) { const j = await post('core'); const cut = Object.entries(j).some(([k, v]) => k !== 'ok' && v && typeof v === 'object' && v.budget); console.log('core', i + 1, cut ? 'more' : 'done'); if (!cut) break; }
// settle: until the backlog is 0. The backlog counts members known to need work and the newest periods not looked at yet; old periods in rotation are not backlog (they have a daily quota), so a run ends when only that is left.
// A turn that left the backlog where it was and paid nothing three times in a row ends the run too (the next run tries again).
let still = 0, prev = Infinity;
for (let i = 0; calls < max; i++) {
  const j = await post('settle'); const left = j.backlog ?? j.settled?.backlog ?? 0, paid = j.settled?.paid ?? 0;
  console.log('settle', i + 1, 'backlog', left);
  if (!left) break;
  still = left >= prev && !paid ? still + 1 : 0; prev = left; if (still >= 3) { console.log('settle: no progress, ending this run'); break; }
}
console.log('ticks', calls);
