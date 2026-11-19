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
   (the files are in `migrations/`, `0001_...` then `0002_...` and so on; apply only that folder to D1).
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
The game does nothing by itself. Retries, releases, reversals, penalty notices and period settlement are all done by one function, tick(). Three ways to run it, use at least one:
1. Lazy (built in): any signed-in request runs a small tick when none ran for 5 minutes (one winner per window, errors never reach the user). This keeps a company that is used daily moving, nothing to set up. Set LAZY_TICK=0 to switch it off.
2. External scheduler (recommended for a company that may sit unused): call the signed route POST /api/ingest/tick with an ingest key (CONTRACT/signed-v1.md) every 5 to 15 minutes. scripts/tick.js does the signing: `TICK_URL=https://<host> TICK_KEY_ID=<id> TICK_SECRET=<secret> node scripts/tick.js`.
   - Cloudflare: a Cron Trigger on a tiny separate Worker that makes the same signed call (keep the secret as a Worker secret, never in the repo).
   - GitHub Actions: copy docs/templates/tick-workflow.yml to .github/workflows/ (it is NOT active where it is). It needs two repository secrets the owner adds (TICK_KEY_ID, TICK_SECRET) and one variable (TICK_URL). No secret is stored in the repo.
3. The admin button (POST /api/admin/tick).
The admin overview shows last_tick_at and raises an alert when nothing ran for over an hour.

## Moneypenny caps versus game caps
Moneypenny's own default limits are: lifetime 800 credits per person, manual bonus maximum 500, 20 events per person per day. The game's defaults are higher (season cap per person 15000, event cap 1000, daily event limit 60). Where the game promises more than Moneypenny grants, Moneypenny grants only part: the row is recorded as a partial grant and the remainder is retried every 6 hours (up to 20 times); the admin overview lists open_partial_grants. Raise Moneypenny's limits for the tenant or lower the game caps: the overview shows a warning for each game cap above these numbers (no network call; the numbers are in src/config.js, MNP_LIMITS).

## Shop orders and expiring holds
Moneypenny holds expire (about 15 minutes plus a grace). An order that is captured after that is refused for good (hold_expired): the order becomes "expired", nobody is charged, and the person orders again. Orders that cannot finish for a day are shown in the overview (open_orders_stuck).
