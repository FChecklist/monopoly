# Credit provider port v1 (the adapter)

All credit calls in the game go through `src/provider/index.js`. Nothing else may import a provider class
(test `single door`). Moneypenny is one implementation (`moneypenny.js`); the demo provider (`stub.js`) is another and is
refused for a live company and when `ALLOW_DEMO_PROVIDER` is not `1`.

Methods (all take one object; all writes take `idem`):

| Method | Meaning | Returns |
|---|---|---|
| `capabilities()` | `{hold, debit, reverse, expiry, batch, cash_out, spend, max_batch}` booleans. `cash_out` is never true here | object |
| `link()` | connect company to provider tenant | `{tenant_ref, capabilities}` |
| `ensureAccount({externalRef, email})` | get or create an account reference (the person's opaque id; Moneypenny uses the verified work e-mail) | `{account_ref}` |
| `getBalance({accountRef})` | live balance. Never cached for decisions | `{balance, spendable, holds, next_expiry_at, unit_name}` |
| `reserveBudget({amount, name, idem})` | season hold (only if `hold`) | `{hold_id, remaining}` |
| `releaseHold({holdId, amount?})` | give back all or part (only if `hold`) | `{remaining, released}` |
| `credit({accountRef, amount, fromHoldId, expiresAt, reasonCode, ref, idem})` | reward | `{entry_id, balance}` |
| `debit({accountRef, amount, reasonCode, ref, idem, monthlyCap})` | penalty: earned, unspent credits only, never below zero (only if `debit`) | `{entry_id, debited, balance}` |
| `reverse({entryId, reasonCode, idem})` | undo a credit (only if `reverse`) | `{entry_id, reversed, owed}` |
| `reserveSpend / captureSpend / releaseSpend` | catalogue spend | `{hold_id}` / `{entry_id}` / `{released}` |
| `history({accountRef, limit})` | statement lines | `{lines:[{entry_id, kind, amount, ref, at}]}` |
| `startPurchase({accountRef, credits, ref, idem})` | company buys credits (real money only through IT Services + Razorpay, inside the provider) | `{purchase_id, pay_url}` |
| `creditBatch({items})` | many credits (only if `batch`) | list |

Errors (`ProviderError.code`): `insufficient_budget`, `hold_expired`, `account_closed`, `cap_reached`, `duplicate`,
`unsupported`, `rate_limited`, `provider_down`, `bad_request`, `insufficient_credits`. `provider_down` and `rate_limited` are retried;
the same idempotency key is used on every retry.

## Idempotency keys the game sends

| Reward | Key |
|---|---|
| per-event stage | `event:<event_id>:<stage>` |
| bonus roll | `bonus:<event_id>:<stage>` |
| tier / period bonus | `tier:<person>:<period_key>:<target_id>[:r<n>]` |
| streak | `streak:<person>:<period_key>:<streak_id>[:r<n>]` |
| team split | `team:<person>:<period_key>:<target_id>[:r<n>]` |
| lap, note | `lap:<person>:<event>:<i>`, `note:<person>:<event>` |
| reversal at provider | `rev:<provider entry id>` |
| penalty debit / give-back | `pen:<case_id>` / `penrev:<case_id>` |
| season hold | `hold:<season_id>` (`hold:<season_id>:<budget>` when raised) |
| catalogue | `order:<id>`, `cap:<id>`, `rel:<id>` |

`[:r<n>]` is added only when a bonus was reversed and later earned again, so a re-earn is a new payment.

## If the provider is down
Rewards stay `queued` ("on its way") with the same key and are retried by the tick (admin button or an `ingest` key call).
After 24 hours the admin overview shows them. Nothing is ever paid twice.

## Not enabled in v1
The shop is NOT enabled in v1 (a v2 item, BOSS decision): `reserveSpend / captureSpend / releaseSpend` are never called; the provider wrapper reports `spend: false`; orders answer 409 `not_enabled_in_v1`. The code and its tests stay for v2.
Also not enabled in v1 (round 18): topping up a partial grant (refs `<id>:r<k>`), reviving failed rewards (`revive-failed`, `:v<n>`, `:short`, weekly slow retry) and any credit above 500 in one bonus. A failed or partial reward is closed by an admin who checked the ledger and re-issued as a NEW grant (`POST /api/admin/reissue`).

The game does not use hold, debit or reverse in v1 even when a provider declares them: the game forces them to false, and a real provider that declares them true is treated as a configuration error ('not enabled in v1'). Code for them is kept, unreachable and unaudited. Reward credit, balance, spend (shop orders) and purchase links are the v1 surface.
