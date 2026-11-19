# Deploy

Cloudflare Pages (static `public/` plus Pages Functions in `functions/`) with one D1 database. No secrets belong in this file or in the repo.
Do the steps in order and tick them off. Write each id you receive into the rollback record at the end.

## 0. Before anything
1. Work from a clean checkout, node 22.5 or newer.
2. `npm test` passes (run it alone; it is memory-hungry).
3. Words and secrets:
   * `node scripts/scan-words.js` prints "Word scan clean."
   * `node scripts/scan-secrets.js` prints clean.
   * If `gitleaks` is installed: `gitleaks detect --source . --no-banner` finds nothing. If it is not installed, say so in the record and rely on the scan above.
4. Confirm the provider rule: no real company data until the credit provider is live and `test/contract-live.test.js` passes against it.

## 1. GitHub repository
1. Create the repository under the owner account (public or private as the owner chose; all rights reserved, see LICENSE).
2. Push the code only after step 0.3 is clean. Never push `.dev.vars`, `.env`, exported databases or key files.

## 2. D1 database
1. `npx wrangler d1 create <database-name>` (use the name in `wrangler.toml`). Copy the printed database id into `wrangler.toml` `database_id`.
2. Apply the migrations IN ORDER, lowest number first, each exactly once:
   `npx wrangler d1 migrations apply <database-name> --remote`
   (the files are in `migrations/`, `0001_...` then `0002_...` and so on up to `0011_rows_quota.sql` (new tables and columns only: tick_state, settle_mark, tick_stage, the rows-per-day counters; `0008_idx.sql` and the `ev_type_time` index in 0011 are indexes only, safe to re-run). Apply 0009, 0010 and 0011 BEFORE deploying this code; apply only that folder to D1).
3. Check: `npx wrangler d1 execute <database-name> --remote --command "SELECT name FROM sqlite_master WHERE type='table'"` lists the tables and none is a balance table.
4. Record the time of the first good backup point (see ROLLBACK.md, time travel).

## 3. Pages project
1. `npx wrangler pages project create <project-name> --production-branch main`.
2. Connect the GitHub repository, or deploy by hand: `npx wrangler pages deploy public --project-name <project-name>`.
3. Under Settings > Functions, bind the D1 database to the variable name used in `wrangler.toml`.
4. Set the compatibility date from `wrangler.toml`.

## 4. Secrets (names only; set values in the Cloudflare dashboard or with `wrangler pages secret put`)
Never type a value into chat, a file in the repo, or a shell history you share.
* `MASTER_SECRET` (at least 32 random characters; protects sealed personal data and signing; see rotation in ROLLBACK.md)
* Provider credentials for the credit provider (key id and secret), one set per live company
* Mail sender credentials for sign-in codes
* Any key the AI feature needs (kept off until the owner switches AI on)
* `NODE_ENV` must NOT be `dev` in production; the dev server refuses to start without it and never runs there.

## 5. Domain (DNS)
1. In Pages > Custom domains, add the hostname.
2. At the DNS host add a CNAME from the hostname to `<project-name>.pages.dev`. Proxy on.
3. Wait for the certificate to show active. Note the DNS record id.

## 6. Smoke test (against the live hostname)
1. `GET /api/health` returns ok.
2. `GET /api/config` returns the product name, tagline, footer and the Terms link only if one is set (https only).
3. The sign-in page loads, CSP shows no console errors, the footer text is present.
4. Sign in as the first admin, accept both notices, open My board: the six-sided track shows 24 squares and your token.
5. Make a small test event for a demo company, check the reward row, then reverse it.
6. Admin > Run now works; Admin > AI access shows AI off.
7. Sign out. Confirm the cookie is gone and `/api/me` answers "Please sign in."

## 7. Rollback record (write these down before announcing)
* Pages: project name, the previous good deployment id and the new one
* D1: database name and id, the time (with timezone) just before the first migration, and the bookmark printed by `wrangler d1 time-travel info`
* DNS: the record id of the CNAME, and the previous value if one existed
* Keys: the key ids of every ingest or provider key you created, with their labels
* AI: confirm the kill switch works (Admin > AI access > Switch AI off) and note who may press it

## The clock (tick): who runs it
**On the free plan a deploy needs one of the two drivers below.** Period bonuses (tiers, team, streaks) are settled by the clock, and the clock needs more calls than one web request may use (Cloudflare Free: 50 queries per invocation, a D1 batch counts as one; limits verified in docs/STATE.md round 27). A signed-in request only starts a tiny tick (light stages and a row or two of sending, never the settle). Without a driver the overview shows the alert "Nothing has run the full clock for over an hour" and period bonuses and streaks are not paid.
* DRIVER A (recommended, free): a scheduled GitHub Actions workflow. Copy docs/templates/tick-workflow.yml to .github/workflows/tick.yml (it is disabled where it is and holds no secret; add the secrets TICK_KEY_ID and TICK_SECRET and the variable TICK_URL). It runs scripts/tick.js every 10 minutes: that script POSTs the signed /api/ingest/tick in a LOOP (body {"turn":"core"} until nothing is cut by the budget, then {"turn":"settle"} until the answer says backlog 0). Every POST is its own invocation with its own limit, so the loop pays a whole month end in minutes.
* DRIVER B (alternative): a Cloudflare Cron Trigger on a tiny separate Worker (cron "*/5 * * * *") that makes the same signed calls in the same loop (keep the secret as a Worker secret, never in the repo). It must loop for the same reason (each fetch from the Worker is a subrequest of the Worker, so loop at most about 40 calls per run on the free plan).
The tick body accepts {"turn":"core"} or {"turn":"settle"} (default: the two alternate). Details below.

The game does nothing by itself. Retries, releases, reversals, penalty notices and period settlement are all done by one function, tick(). Three ways to run it, use at least one:
1. Lazy (built in): any signed-in request runs a small tick when none ran for 5 minutes (one winner per window, errors never reach the user). This keeps a company that is used daily moving, nothing to set up. Set LAZY_TICK=0 to switch it off.
2. External scheduler (recommended for a company that may sit unused): call the signed route POST /api/ingest/tick with an ingest key (CONTRACT/signed-v1.md) every 5 to 15 minutes. scripts/tick.js does the signing: `TICK_URL=https://<host> TICK_KEY_ID=<id> TICK_SECRET=<secret> node scripts/tick.js`.
   - Cloudflare: a Cron Trigger on a tiny separate Worker that makes the same signed call (keep the secret as a Worker secret, never in the repo).
   - GitHub Actions: copy docs/templates/tick-workflow.yml to .github/workflows/ (it is NOT active where it is). It needs two repository secrets the owner adds (TICK_KEY_ID, TICK_SECRET) and one variable (TICK_URL). No secret is stored in the repo.
3. The admin button (POST /api/admin/tick).
The admin overview shows last_tick_at and raises an alert when nothing ran for over an hour.

Query budget: one tick is one worker invocation. A free D1 plan allows about 50 queries per invocation (1,000 on a paid plan: check the current Cloudflare limits page), so the tick counts its queries and provider calls and stops cleanly at TICK_QUERY_BUDGET (default 40; 0 = no limit; about 800 on a paid plan). The next tick carries on (newest periods first). The overview shows tick_backlog and alerts when the clock stays behind for 6 runs, and shows tick_stage_error when a step of the clock failed; run the clock every 5 minutes and read those two fields. Set TICK_QUERY_BUDGET as a Pages variable (it is forwarded to the app).

## Moneypenny caps versus game caps
No single credit may exceed 500 (manual_bonus_max): the game refuses such an amount when it is set up. A failed or partly granted EVENT reward is never retried by itself. The admin page (Overview) lists it under "Rewards that need an admin": check the Moneypenny ledger first, then press Re-issue (confirm, and write what you checked, at least 10 characters). The old row is closed and a NEW grant is made, with a new reference. A period bonus (tier, streak, team) that failed, was granted only in part or was voided by the system is listed there read only: check the ledger and fix it by hand outside the app in v1.
Rotating the Moneypenny key: calls whose answer was lost are retried under the same idempotency key; after a key rotation that key may be rejected (idempotency_conflict, shown as a provider problem). Let the queue empty (nothing 'on its way') before you rotate.

Moneypenny's own default limits are: lifetime 800 credits per person, manual bonus maximum 500, 20 events per person per day. The game's defaults are higher (season cap per person 15000, event cap 1000, daily event limit 60). Where the game promises more than Moneypenny grants, Moneypenny grants only part: an event row is recorded as a partial grant with the sent amount and is never topped up by itself; it appears under "Rewards that need an admin" (see above).

## Shop orders (not enabled in v1)
The shop (hold, capture, release) is NOT enabled in v1: it is a v2 item (BOSS decision). The shop page says it is not available, orders answer 409 not_enabled_in_v1 and the clock does not run order steps.
Moneypenny holds expire (about 15 minutes plus a grace). An order that is captured after that is refused for good (hold_expired): the order becomes "expired", nobody is charged, and the person orders again. Orders that cannot finish for a day are shown in the overview (open_orders_stuck).

## Environment name
wrangler.toml sets `ENVIRONMENT = "production"` under [vars] (functions/[[path]].js forwards it). Keep it in a production deployment. FUTURE_OPS (the test-only switch for hold, debit, reverse, shop, buying credits) is never forwarded by functions/[[path]].js, so a deployed site cannot turn it on; ENVIRONMENT = "production" is set in wrangler.toml and IS forwarded, and the server refuses to start with FUTURE_OPS set when ENVIRONMENT or NODE_ENV starts with "prod". Even where it is set, only a non-live company on the demo provider reaches those paths.

## Provider limits to know
A Moneypenny tenant has a rolling 24-hour bonus cap: a credit refused with cap_reached for that reason may succeed a day later. The game does not retry a refused credit by itself in v1 (the row needs an admin): look at the ledger after 24 hours, then re-issue the event reward (with a ledger note); a period bonus is fixed by hand.
Key rotation: a credit whose answer was lost is retried under the same idempotency key. If the Moneypenny key is rotated in between, that key can be answered with idempotency_conflict (shown as a provider problem, retried forever, never paid twice). Empty the queue (nothing "on its way") before rotating; if it happens, check the ledger and re-issue the event reward.

## Buying credits (not enabled in v1)
POST /api/admin/buy (the provider's purchase page) is a v2 item: it answers 409 not_enabled_in_v1 and the admin page says it is not available. The code and its demo-provider tests stay.

## Free-plan quotas and what the app does about them (round 28)
Verified 19 Nov 2026 (re-check the pages before relying on them: https://developers.cloudflare.com/d1/platform/limits/, https://developers.cloudflare.com/workers/platform/limits/):
Workers Free = 50 database queries (a D1 batch counts as one) and 50 subrequests per invocation; D1 Free = 5,000,000 rows read per day and 100,000 rows written per day (past it EVERY query fails until 00:00 UTC, the whole app).

* Queries per invocation: every route of the route table is crawled by `test/routes-budget.test.js` with 60 and 200 people x 12 months and must stay at 45 calls or fewer. Lists are pages (50 by default, 100 at most).
* Event intake: one event costs about 25 calls (about 30 over HTTP with the signed-call checks), whatever the number of people. A call therefore takes 1 to 2 events on the free plan (`max_per_call` in the answer); a batch is answered 207 with `next_index` (CONTRACT/signed-v1.md) and the sender goes on. Practical free-plan rate: about 1 to 2 events per call, so a sender calling back to back gets a few thousand events a day through (a paid plan, TICK_QUERY_BUDGET=0, has no such cut). A CSV import goes the same way (`more`, `next_row`; the screen loops by itself).
* Rows read per day: the clock keeps today's rows read and written in `tick_state` (D1 reports them per statement; the local harness counts rows returned) and shows them in the overview (`rows_read_today`). Above ROWS_READ_SOFT_LIMIT (default 3,500,000) the settle does only hot work (the two newest periods of each target and the streaks) and the overview alert `rows_read_high` names the number. Old periods are looked at in rotation, at most max(40, one fifth of them) idle ones per UTC day; a period that has something to pay is not counted. A driver run ends when only that rotation is left (the answer's `backlog` counts hot work only). A streak target is read whole at most once a day (its recent periods and rewards are checked on every turn with a few statements).
* Estimate: rows read per day in steady state is about runs/day x (core turn + settle turn rows), where a settle turn reads about 600 + 2 x targets x (events of one period of that type) rows and a core turn about 600. Measured: 60 people, 7 targets, 12 periods of history, 144 runs a day = 2 driver invocations and about 1,230 rows returned per idle run (about 180,000 a day; 278,000 on the first catch-up day). D1 counts rows scanned, which the `ev_type_time` index keeps close to rows returned. Rows written per day is about events/day x 12 + payments/day x 8 (an event writes its row, a reward, a move and their audit lines). With p people and e events per person per day that is p x e x 12, so 100,000 writes a day allow about 8,000 events a day.
* GitHub Actions for the driver (https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions): standard runners in public repositories are free; a private repository on the Free plan has an allowance of $12 a month, about 2,000 Linux minutes (that conversion is arithmetic, the page gives dollars). At a 10-minute cadence the clock runs 4,320 times a month, each run at least one billed minute: more than the allowance. Use a PUBLIC repository (the workflow holds no secret), or a 30-minute cadence (1,440 runs a month), or the Cloudflare Cron Trigger (driver B). In a public repository GitHub turns scheduled workflows off after 60 days without repository activity (https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows): commit now and then or re-enable the workflow. The shortest schedule is 5 minutes and runs can be delayed.
* The driver (scripts/tick.js) answers a 429 by waiting for Retry-After (at most 120 s, up to 5 times) and then ends the run with exit 0; a 5xx or network error is tried twice more before it fails.

