# Changelog

Newest first. Dates are in IST (Indian Standard Time). Every deployed change gets a new version number
(MAJOR.MINOR.PATCH), a new entry here, an updated `public/version.json` and an updated `KNOWLEDGE.md`, all in the same pull request.

## 0.1.0 - 19 Nov 2026 (current)
- First numbered version. It describes the code as it stands at commit `c505465` (after audit round 28). The date is the date of that commit.
- NOT deployed. Deploy is on hold. No company is live. The product only pays plain credits (credit-only v1).
- No code changed to create this version: only version files were added (`CHANGELOG.md`, `KNOWLEDGE.md`, `public/version.json`).
- Version numbering starts here. The work before it was not numbered; it is listed below as milestones.

## Before numbering (milestones from git history, not versions)

- 19 Nov 2026, 22:47 IST: work paused by order of the boss; state and the round-29 fix list written to `docs/STATE.md`.
- 19 Nov 2026, 21:22 IST, round 28: free-plan limits are kept on every route, and the number of rows written per day is bounded.
- 19 Nov 2026, 20:24 IST, round 27: the payout run no longer starves (reads done in sets, one slow member no longer blocks the rest, errors shown per stage, bounded lazy tick).
- 19 Nov 2026, 19:26 IST, round 26: the background clock is bounded (query budget per run, a saved place to continue from, alerts for backlog and stage errors).
- 19 Nov 2026, 18:30 IST, round 25: two payout runs at the same time can no longer pay from an old figure.
- 19 Nov 2026, 17:14 IST, round 24: a fall followed by a rise in a period reward is netted against the open correction.
- 19 Nov 2026, 16:14 IST, round 23: a partly paid period row stays on the list; lists are paged; overview shows counts only.
- 19 Nov 2026, 15:17 IST, round 22: one rule for blocked period groups, re-issue chains and real totals.
- 19 Nov 2026, 14:33 IST, round 21: the remedy was simplified (one re-issue for event rewards); the rest was cut.
- 19 Nov 2026, 14:11 IST, round 20: one re-issue wins; blocked groups are shown with a remedy; buying credits is not enabled in v1.
- 19 Nov 2026, 13:53 IST, round 19: re-issue is one atomic step; the settle never pays a re-issue chain; the shop is not enabled in v1.
- 19 Nov 2026, 13:21 IST, round 18: credit-only scope cut (no top-up, no revive; ledger check and re-issue only).
- 19 Nov 2026, 11:50 IST, round 17: credit-path fixes Z1 to Z7.
- 19 Nov 2026, 11:04-11:17 IST, round 16: credit-path audit 15 fixes (X1 to X9) and simulation checks for period-bonus caps.
- 19 Nov 2026, 10:21 IST, round 15: v1 becomes credit-only (hold, debit and reverse not enabled); claim tokens for provider operations.
- 19 Nov 2026, 09:57 IST, round 14: one outbound provider-operation state machine for all calls to the credit provider.
- 19 Nov 2026, 09:10-09:26 IST, rounds 12 and 13: holds that must go back are retried; reverse retries are bounded; a lost reply is not contradicted by a later "no".
- 17 Nov 2026, 19:00 IST, round 11: provider setup faults never fail rewards; lost-answer debit and reverse are finished.
- 17 Nov 2026, 18:28 IST, round 10: Moneypenny statuses are mapped by cause; event rewards survive config faults.
- 17 Nov 2026, 18:12 IST: fixes found by the simulation (tier underpay, failed-row revival, penalty restore repair).
- 17 Nov 2026, 17:46-18:00 IST: sharded simulation workflow (free CI) and simulation harness added.
- 17 Nov 2026, 17:32 IST, round 8: one restore generation per apply.
- 17 Nov 2026, 17:26 IST: initial public release of the code (code only, not deployed). `package.json` already said version 0.1.0 at this point, but no version notes existed.
