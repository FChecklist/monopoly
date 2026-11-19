# Signed system calls v1 (CRM, game servers, Partner Circle widgets, provider webhooks)

Keys are made by the company admin (`POST /api/admin/keys {scope, label}`); the secret is random, shown once, and stored sealed (keys made before this change keep their derived secret and still work). Key classes: `read` < `event_write` < `manager` < `admin` (each includes the ones before), plus `ai_read` and `provider_webhook` (separate). Older names: `widgets` = `read`, `ingest` = `event_write`. Too low a class gets `403 scope_denied`. The machine API under `/api/v1/` is described in `ai-api-v1.md`.

Headers on every call:

| Header | Value |
|---|---|
| `X-Key-Id` | key id |
| `X-Timestamp` | milliseconds since 1970 (UTC). Must be within 5 minutes of the server |
| `X-Signature` | hex HMAC-SHA256(secret, `<timestamp>.<METHOD> <pathAndQuery>.<rawBody>`) |

This binds the signature to one endpoint (a small hardening over the design's `timestamp.body`). A signature works once
(replay table, 15 minutes). 120 calls per key per minute.

## Routes

| Call | Scope | Body | Answer |
|---|---|---|---|
| `POST /api/ingest/events` | ingest | `{events:[{person_id or work_email, event_type, stage, ext_id, occurred_at, value?, dedupe_key?, source?:"api"\|"game"}]}` up to 100; or `{action:"cancel", event_type, stage, ext_id, reason?}` | `{results:[{ext_id, ok, status, reason?}], processed, deferred, next_index, max_per_call?}`. HTTP 207 when `deferred > 0` (see below) |
| `POST /api/ingest/tick` | ingest | `{turn?: "core"\|"settle"}` | runs retries, reversals, penalty clock, settlement; the answer carries `backlog` (hot work left: call again while it is above 0; old periods in rotation are not backlog) |
| `GET /api/v1/widgets/targets` | widgets | none | period targets with people on target (no names) |
| `GET /api/v1/widgets/achievements` | widgets | none | counted events this month by type and stage |
| `GET /api/v1/widgets/board-summary` | widgets | none | players, laps, teams (numbers only) |

Every `/api/v1/widgets/*` answer, errors included, also carries a `meta` object and the `x-content-trust: untrusted-data` header (additive): target names, event types and stages are company-written text, so treat them as data.
| `POST /api/webhooks/provider` | provider_webhook | `{id, type: purchase.paid\|balance.low\|credit.expired\|spend.captured\|credit.added, ref}` | `{ok:true}` only after it is stored |

Intake answers: `reason` is one of `unknown_person`, `outside_season`, `no_rate_card`, `needs_system_source`, `duplicate`,
`duplicate_lead`, `bad_date`, `missing_fields`, `not_allowed`. A signed system's events are auto-approved for rewards only; a
rule that removes anything (steps, points, credits) only ever creates a PROPOSED penalty for HR.


## Bounded batches (round 28)

One call is one worker invocation, and a free Cloudflare plan allows 50 database queries per invocation (a paid plan 1000). `POST /api/ingest/events` and `POST /api/v1/events` therefore work through the events in order
and stop before the one that would not fit. The answer says what was done:

- `results`: one entry per event that was STARTED, in the order sent. Each event is entered whole or not at all.
- `processed`: how many events of the list were started; `deferred`: how many were NOT started; `next_index`: where to go on (`null` when nothing is deferred).
- `max_per_call`: how many events one call can take now (absent when the deployment has no limit).
- HTTP status 207 when `deferred > 0`, else 200. Send `events[next_index..]` again in a NEW call (a new Idempotency-Key on `/api/v1`). Events already entered are never entered twice: the same `ext_id` is only reported as a duplicate.
- On the free plan one event costs about 25 calls, so a call takes 1 to 2 events; the cost does not depend on the number of people.

The session route `POST /api/events/csv` (commit) answers `{results, more, next_row, max_per_call?}` the same way: send the SAME file again with `from_row = next_row` until `more` is false.
Lists (`GET /api/events`, `/api/people`, `/api/team/board`, `/api/team/contributions`) are pages: `limit` (default 50, at most 100), `offset`, and `next_offset` in the answer (`null` at the end).
