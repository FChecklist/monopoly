// PERMANENT route crawler. Every route of the route table is run with a realistic volume (60 people, 12 months of events and rewards) under a per-invocation call counter.
// A Cloudflare free plan allows 50 D1 queries per invocation; a route above the limit below fails the test, so a new route cannot silently break the free plan.
// A route may exceed it only when it is listed in EXCEPTIONS with a reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crawlWorld } from './crawlworld.js';
import { listRoutes } from '../src/api.js';
import { keyCall } from './webhelp.js';
import { createKey } from '../src/setup.js';

const LIMIT = 45;
/** Documented exceptions: route -> reason. (Empty on purpose: B=0 unbounded paid mode is not crawled, the free-plan limit applies to every route.) */
const EXCEPTIONS = {};
const SKIP = /^(POST \/api\/auth\/logout|POST \/api\/admin\/people\/:id\/(erase|remove))$/; // end the session or the person the crawl itself uses; covered by their own tests
const BODY = {
  'POST /api/events': (w) => ({ person_id: w.ids[3], event_type: 'lead', stage: 'entered', ext_id: 'crawl-1' }),
  'POST /api/events/csv': (w) => ({ csv: 'work_email,event_type,stage,ext_id\n' + Array.from({ length: 30 }, (_, i) => `p${i}@acme.test,lead,entered,csv-${i}`).join('\n'), commit: true }),
  'POST /api/admin/people': () => ({ email: 'new1@acme.test', name: 'New One', role: 'employee' }),
  'POST /api/penalties': (w) => ({ person_id: w.ids[5], effect: 'points', amount: 5, reason: 'crawl' }),
};
const idFor = (w, path) => (path.includes('/events/') ? w.eventId : path.includes('/people/') ? w.ids[0] : path.includes('/rewards/') ? w.rewardId : 'x');

for (const people of [60, 200]) {
  test(`route crawler at ${people} people x 12 months: no route needs more than ${LIMIT} calls`, async () => {
    const w = await crawlWorld({ people, months: 12 });
    const over = [], seen = [];
    for (const r of listRoutes().filter((x) => x.kind === 'session')) {
      const id = `${r.method} ${r.path}`;
      if (SKIP.test(id)) continue;
      const path = r.path.replace(':id', idFor(w, r.path));
      const roles = r.method === 'GET' ? ['admin', 'hr', 'mgr', 'a'] : ['admin'];
      for (const who of roles) {
        await w.login(who); // sessions end as the clock moves
        const before = w.calls;
        const body = r.method === 'GET' ? undefined : (BODY[id]?.(w) ?? {});
        const res = await w.call(who, r.method, path, body);
        const used = w.calls - before;
        seen.push(id);
        if (used > LIMIT && !EXCEPTIONS[id]) over.push(`${id} as ${who}: ${used} calls (status ${res.status})`);
        if (r.method === 'GET' && res.status === 200 && Array.isArray(res.json?.events)) assert.ok(res.json.events.length <= 100, 'a list is a page');
      }
    }
    assert.ok(seen.length >= 90, 'the crawler really walks the route table: ' + seen.length);
    assert.deepEqual(over, [], 'routes above the free-plan limit');
  });
}

test('the clock routes (tick, settle) stay inside the invocation limit at 60 people x 12 months', async () => {
  const w = await crawlWorld({ people: 60, months: 12 });
  for (const path of ['/api/admin/tick', '/api/admin/settle', '/api/admin/tick', '/api/admin/settle']) {
    await w.login('admin');
    const before = w.calls;
    const res = await w.call('admin', 'POST', path, {});
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.ok(w.calls - before <= 50, `${path} used ${w.calls - before} calls`);
  }
});

test('the signed routes and /api/v1 reads stay inside the limit, and event intake is bounded by the invocation (HTTP 207 with next_index)', async () => {
  const w = await crawlWorld({ people: 60, months: 12 });
  const key = await createKey(w.ctx, w.company, w.admin, { scope: 'admin' });
  for (const path of ['/api/v1/status', '/api/v1/board/summary', '/api/v1/targets', '/api/v1/achievements', '/api/v1/proposals', '/api/v1/widgets/targets', '/api/v1/widgets/achievements', '/api/v1/widgets/board-summary']) {
    const before = w.calls;
    const res = await keyCall(w, key, 'GET', path);
    assert.equal(res.status, 200, path + ' ' + res.text);
    assert.ok(w.calls - before <= LIMIT, `${path} used ${w.calls - before}`);
  }
  const events = Array.from({ length: 100 }, (_, i) => ({ person_id: w.ids[i % 60], event_type: 'lead', stage: 'entered', ext_id: 'L-' + i, occurred_at: w.clock.t - 1000 - i }));
  const before = w.calls;
  const res = await keyCall(w, key, 'POST', '/api/ingest/events', { events });
  const used = w.calls - before;
  assert.ok(used <= 50, `ingest used ${used}`);
  assert.equal(res.status, 207, res.text);
  assert.ok(res.json.deferred > 0 && res.json.next_index === res.json.processed && res.json.results.length === res.json.processed, JSON.stringify({ d: res.json.deferred, n: res.json.next_index, p: res.json.processed }));
});
