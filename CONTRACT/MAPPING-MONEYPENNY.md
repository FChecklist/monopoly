# Mapping to the real Corporate Moneypenny (read from C:\ct\moneypenny API.md and CONTRACT\v1\openapi.json, 17 Nov 2026)

Moneypenny's real API differs from the proposal in the design (section 8A.3). The adapter follows the REAL one.

| Port method | Real Moneypenny call | Notes |
|---|---|---|
| signing | headers `x-mnp-key`, `x-mnp-timestamp` (ms), `x-mnp-nonce`, `x-mnp-signature` = HMAC-SHA256(secret, ts \n nonce \n METHOD \n pathWithQuery \n sha256hex(body)) | every call; `Idempotency-Key` on writes |
| `ensureAccount` | none | identity is the lower-cased verified e-mail. `account_ref` = work e-mail (sealed in our database) |
| `getBalance` | `GET /v1/balance?email=` | needs a `read` or `api` key |
| `credit` | `POST /v1/credit {email, bucket:"bonus", amount, ref}` | `api` key. Moneypenny enforces its own caps; a refusal maps to `cap_reached` |
| `history` | `GET /v1/history?email=&limit=` | |
| `reserveSpend` | `POST /v1/spend/reserve_item {email, product, item, order_ref, credits}` | catalogue items must exist in Moneypenny's price list for product `floor` |
| `captureSpend` / `releaseSpend` | `POST /v1/spend/capture` / `/release {hold_id}` | |
| `startPurchase` | `POST /v1/buy_credits {email, credits, order_ref}` | real money goes through IT Services + Razorpay inside Moneypenny; the game never touches it |

## Gaps (the adapter reports them as `false` and the game keeps the feature OFF)

| Missing in Moneypenny | Effect in the game |
|---|---|
| Season budget hold (`hold`) | The game enforces the season budget itself as a CEILING on what it will send (rewards beyond it wait). That is a rule, not a balance. Funding the pool before the season is then the company's manual top-up |
| Debit of earned credits (`debit`) | Credit-loss penalties stay OFF. Board-step and board-point penalties still work |
| Reversal of a bonus credit (`reverse`) | A cancelled lead/game becomes a pending correction case that later rewards pay down as smaller credits (max 50% of one reward), never a debt on wages |
| Batch credit | One call per reward |
| Per-lot expiry set at credit time | Expiry is Moneypenny's own rule |
| Tenant sub-accounts | One game company = one Moneypenny key. Employees are accounts by e-mail |
| Outgoing webhooks to the game | `credit.added`, `spend.captured` can be pointed at `POST /api/webhooks/provider` (signed, see `signed-v1.md`) |

To close the gaps Moneypenny would need: budget holds, a debit-earned call, a reverse-credit call and tenant keys. Until then the
company can still run: events pay credits, tiers and streaks pay and are corrected at close, spending works.

**Before any company goes live** (hard rule): run `test/contract-live.test.js` against a Moneypenny test tenant, then
`POST /api/platform/company/:id/live`.
