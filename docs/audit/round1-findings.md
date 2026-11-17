# Audit round 1 findings (all three FAILED). Fix every BLOCKER and MAJOR; MINORs where cheap.

## MONEY auditor (FAIL)
1 BLOCKER caps/budget not race-safe (rewards.js ~39-79; audit.js commit retry reuses stale amount/takes). Only person-month cap is in the guarded INSERT. Put event cap, row month/day caps, season cap, period-bonus cap and season-budget checks into the INSERT guard SQL, or recompute inside the retry.
2 BLOCKER rewards with no season (tier/streak/team bonuses granted at period end outside a published season) skip the season cap and sit in 'waiting' with season_id null; releaseWaiting later assigns them to the current season without re-checking the person-season cap. Refuse/hold properly, or re-run the full cap check at release.
3 BLOCKER settleCompany ignores period_target.active_from and re-evaluates every closed period (up to 400): adding a target later pays all past months. Skip periods starting before active_from (never backwards).
4 BLOCKER team bonus double pay: teamMembers uses CURRENT team_id/status, settle replays closed periods. Mover paid again by new team; a leaver makes remaining shares exceed the pool. Snapshot team membership per closed period (new table, migrations/0002_money.sql) and never recompute a paid period.
5 MAJOR countFor counts only status='applied', so a reversal_pending event stops counting immediately: tiers/streaks reversed during the 3-day notice and appeal freeze; a won appeal re-pays under a new :rN key. Count reversal_pending until the reversal executes.
6 MAJOR tier settlement idempotency key includes seq = count of existing rows: two concurrent settle runs can pay twice. Make the key independent of row count (use a reversal generation).
7 MAJOR correction UPDATE recovered = recovered + ? has no `recovered + ? <= amount` guard; make grant depend on change count.
8 MAJOR queued reward can be voided after provider already credited it (crash between provider.credit and state='sent'); never void a row with attempts>0: send first, then reverse.
9 MAJOR one global MNP_KEY_ID/MNP_SECRET for every company (provider/index.js:11): refuse a second live moneypenny company, or per-company keys.
10 MAJOR dice bonus floor: floor(paid*pct/100) is 0 for paid<=9; bonus is a separate grant that can be clamped/waiting; top of range not reserved. Reserve base + top of range together; min 1 credit when bonus on.
11 MINOR moneypenny.js:52 partial `granted` recorded as full: compare granted to requested.
12 MINOR credit-loss penalty: setting and debit capability checked only at proposal; applyPenalty/reversePenalty not state-guarded (double deduct/restore under concurrent ticks).
13 MINOR applyEvent can re-run on an applied event and re-propose penalty: make proposals idempotent on (event, rule).
14 MINOR non-retriable reward failures are re-granted every tick under a new key.
15 MINOR cap 0 disables the cap (rewards.js:39); add upper bounds on caps.
16 MINOR employee-supplied min_approvals can switch off cap_event (events.js:88,156); corrections not applied to rewards 'waiting' at grant; simulateBudget reads dice mode from company not season; /api/admin/buy starts a Moneypenny purchase (keep, but document: the product itself moves no money).
Passed: no stored balances, signing matches Moneypenny API.md, cash-out off, system can only propose penalties, 494/313/193/0 and 2,275->1,945.

## SECURITY auditor (FAIL)
S1 BLOCKER events.js:172-174 proposePenalty not wrapped; penalty.js:28 throws 409 no_notice when person has not acknowledged rules -> applyEvent throws after reward+move, event stuck 'approved', resumeApproved throws every tick so reversals/penalty clock/settlement never run; signed ingest batch 500s halfway. Fix: catch per rule and skip when no acknowledgement; wrap each event in resumeApproved; proposals idempotent on (event, rule).
S2 MAJOR api.js:199-202 HR gets every person's real name via GET /api/events (forceReal). HR must get person_id only / aggregates, detail only for an open case and logged.
S3 MAJOR no DPDP correction/erasure/retention: add admin/HR action to scrub sealed name/email/work id of leavers (keep ids and ledger), a correction endpoint, rights/:id/resolve doing real work; email_hash globally UNIQUE blocks re-registering a leaver (scrub the hash on erasure).
S4 MAJOR free text in immutable audit data (lane.enter reason board.js:203, penalty.reverse note penalty.js:128, event.submit ext): store ids and codes only.
S5 MAJOR no rotation: signing secret derived from MASTER_SECRET; sealed blobs only tag 's1' (no key id, no AAD); secrets min 16 chars. Fix: key-version tag + AAD(table+id) in seal; secret min 32; document rotation; per-key random secrets stored sealed.
S6 MAJOR authority scope: penalty.js:74 decideAppeal level 1 accepts any manager (must be person's own manager or HR); POST /api/lane/:id/finish lets any manager clear anyone's task (own team only); events.js:226 decideReversalAppeal blocks only reversal_by, not the person (also block deciding own appeal).
S7 MINOR hide-name ignored in manager/admin views (forceReal in events list, contributions, summary): state it in the notice or honour it in contributions.
S8 MINOR board.reset rows visible to HR/admin via GET /api/admin/audit and manager summary shows `resets`: filter reset rows from HR view, drop `resets` from manager view (design 4A.8).
S9 MINOR consent checked for existence only: require acknowledgement after the rule's published_at.
S10 MINOR 5 wrong login tries permanently kill the code (DoS by e-mail): temporary lock + IP throttle.
S11 MINOR employee ext_id can pre-empt a real CRM event (namespace employee ext_ids); dedupe_key optional for employees; addPerson email_taken oracle across companies; person.remove deletes sessions without company filter; addDesk does not check target_id company.
S12 MINOR readBody buffers before size check (check content-length first); new URL(origin) throws on 'null' -> 500; negative limit -> LIMIT -1; swaps ignore targets/levels and PK clash gives 500; scripts/dev-server.js falls back to public default secrets (fail closed unless NODE_ENV=dev) and its startsWith(root) check lets sibling dirs through.
Passed: role gates, CSRF, company scoping, HMAC signing design, no innerHTML/eval, CSP clean, CSV defuse, cookies, fail-closed entry.

## TRADEMARK/SPEC auditor (FAIL, conservative)
T1 MAJOR public/board.js:16-22 puts 24 squares round the edge of a 7x7 grid with a boxed centre panel (.ctrbox): too close to the famous square-ring. Design 4.2 says hexagon-ish ring/oval track with NO central rectangle. Redraw as a hexagonal/oval track; check Catch-up Lane/Rest Stop positions do not mimic the famous corner order.
T2 MINOR brand string outside the one config string: CONTRACT/examples.json:24 (hard-coded "product"), CONTRACT/README.md:3, README.md:1, docs/REGISTRY-NOTE.md, test/safety.test.js:16. Use a placeholder / "this product" in docs; keep infrastructure names (wrangler.toml, repo) as accepted.
T3 MINOR scripts/scan-words.js skips README, CONTRACT, docs, test; word list lacked several short and multi-word terms (since added). Widen.
T4 MINOR stub_account.balance / stub_hold in main migration 0001: move demo tables to a dev-only migration so the production schema has no balance column.
T5 MINOR bonus-roll die/percentage returned but not shown in the UI; league per head only; Tambola hooks deferred (leave).
