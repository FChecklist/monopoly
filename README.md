# Office floor game (product code MON; code name `floor`)

An office target-and-reward game. A company sets targets and a rate card. Real work events (manual entry, CSV, a signed
API) are checked, approved and paid in credits through ONE adapter to a credit provider (Corporate Moneypenny). The same events
move a player's token round our own 24-square office ring (six zones of four, on a six-sided track). This product stores no credit
balances and moves no real money.

All rights reserved (see LICENSE). Independent product. Not made by or linked to any board-game maker.

* Stack: Cloudflare Pages Functions + D1 (free tier), plain JavaScript, no build step.
* Local: `node scripts/dev-server.js` (node 22.5+), then open http://localhost:8788. `npm test` runs every test.
* Deploy and roll back: `docs/DEPLOY.md`, `docs/ROLLBACK.md`.
* Borders and example messages: `CONTRACT/`. Design: the owner's design report (not in this repo).
* The product name is a config string (`src/config.js`, `product_name` setting). Code, tables and routes use the neutral name `floor`.
* Currency: the unit name, symbol, rate and local currency are company settings (`unit_name`, `unit_symbol`, `credits_per_usd`,
  `local_*`). Screens always show the real-money price beside an amount.

## What it does
* Admin: teams, people, rate card per event type and stage (versioned), period targets (week to year) with tiers and streaks,
  team splits, seasons and budgets, surprise notes, desks, penalty rules, keys, catalogue, buying credits, AI access.
* Game: individual board, shared team view, league, dice (server-side, optional bonus roll inside a funded range), desks, swaps,
  upgrades, collaboration fees from a company pool, Catch-up Lane (cooldown and coaching), fresh start.
* Safety: penalties are board steps or points only (credit loss exists only if the provider can take back earned, unspent credits
  and the company switches it on); notice, appeal, silence reverses; leaderboards off by default; sealed personal data;
  append-only hash-chained audit trail; no code path touches pay.

## Checks before you ship
* `node scripts/scan-words.js` (words that belong to someone else's game), `node scripts/scan-secrets.js` (secrets in files).

## Not live yet
No company may hold real data here until Corporate Moneypenny is live and `test/contract-live.test.js` passes against it.
The demo provider keeps demo numbers and is refused for a live company.
