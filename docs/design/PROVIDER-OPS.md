# Outbound provider operations (src/provider-ops.js)

One state machine for every provider call whose reply can be lost: debit, restore, reverse, hold reserve, hold release, order reserve, order decision.

## The problem it removes
A provider call can land and its reply be lost (timeout, 5xx). Two workers can overlap. A later definitive 4xx can then contradict the call that really landed. Before this, every caller guarded that with its own audit-line markers; each guard had a hole.

## The row (`provider_op`, migrations/0005)
`company_id + key` is unique and the key is the provider idempotency key. Fields: `kind`, `subject` (the caller's record), `params` (fixed at intent, never recomputed), `state`, `tries`, `budget` (5), `last_code`, `result`, `settled`, `claim_until`.

States: `intended` (written, never answered) -> `landed` | `refused` | `unknown`.

## Rules
1. `intend()` writes the row BEFORE the call. The first writer's params win; every worker uses the stored ones.
2. `run()` claims the row with a lease (`claim_until`, 60 s) and counts the try at claim time (a crash is an attempt). A worker that cannot claim gets `busy` and does not call the provider.
3. The provider reply decides the state:
   - success -> `landed` (result stored). A code in `okCodes` (e.g. `hold_expired` on release) is also `landed`.
   - a non-retriable refusal is believed (`refused`) ONLY on the first try (`tries` was 0 before this call) and only for kinds that opt in (`believeRefusal`, off for restore and release).
   - anything else (outage, retriable code, or a refusal after an earlier try) -> `unknown`. The same key is replayed on the next tick.
4. After `budget` tries the row is exhausted: it shows in the overview (`open_*_failed`) and gets one slow retry per day. `POST /api/admin/retry-ops` adds 5 tries at once.
5. `settled` means the caller's own record now matches the provider. Settling is in the SAME atomic commit as the caller's record where there is one (publish, raise, order place, order decision, reward reversal). Otherwise a finisher settles it.

## Finishers (the tick)
- `finishDebits`: for an unsettled debit, if the case holds it (`applied_credits > 0`) settle; if the case will still be applied, leave it to that apply; otherwise replay the same debit and hand back what it took.
- `finishRestores`: replays the restore key until the provider confirms; writes the `penalty.restore` receipt once.
- `healPendingReverses` / `reverseReward`: replays `rev:<entry>`; the person is not counted paid or owed until it is decided. Skipped when the provider cannot reverse.
- `releasePendingHolds`: replays unsettled `hold_release` ops, and replays a `hold_reserve` older than 10 min that no season recorded, then releases that hold.
- `finishOrders`: finishes a captured/released decision; releases an order hold that was reserved but never recorded.

## Callers
| caller | kinds | key |
|---|---|---|
| applyPenalty / finishDebits | debit | `pen:<case>[:g<n>]` |
| restoreDebit / finishRestores | restore | `penrestore:<case>[:g<n>]` |
| reverseReward | reverse | `rev:<entry>` |
| publishSeason / raiseBudget | hold_reserve, hold_release | `hold:<season>...`, `hrel:<hold>` |
| placeOrder / decideOrder / finishOrders | order_reserve, order_decide, order_release | `ores:<id>`, `odec:<id>`, `orel:<id>` |

## What stays outside it
Reward credit (`sendReward`) keeps its own idempotency key and the `attempts` ambiguity rule; hand-back credit (`penrev:`) keeps its own bounded retry. Both satisfy the same rules but are not rows of this table.

## For auditors
To break it you need a path where a provider call is made without an intent row, where a refusal is believed with `tries > 0`, or where a caller recomputes an amount instead of reading `params`.

## v1 status and corrections
- NOT ENABLED IN v1: hold reserve/release, debit, restore and reverse are forced off (src/v1.js). Only the demo provider with the test-only FUTURE_OPS switch reaches them; the code is kept, unreachable and unaudited. Order reserve/decision (spend) stay live.
- Round 15: a claim moves the row to 'unknown' at once and carries a token; only the token holder may record the answer and only while the row is open (landed/refused are terminal); a worker whose write changes nothing re-reads and uses the stored state. Exhausted ops in state intended or unknown are surfaced, retried by retry-ops and by the daily slow retry.
- Correction: a reversal's op is settled right after its commit, not inside it; the replay of the same key makes that safe.
