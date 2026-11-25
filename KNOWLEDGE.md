# KNOWLEDGE (office floor game, product code MON)

Short facts for anyone picking this product up. The long handover (audit rounds, open list, round-29 fix list) is in `docs/STATE.md`.
Deploy and roll back: `docs/DEPLOY.md`, `docs/ROLLBACK.md`.

## Version
- Current version: **0.1.1** (see `CHANGELOG.md`). Not deployed; no company is live.
- Where it lives:
  - `public/version.json` (served as a static file at `/version.json` once deployed; `public/` is the Pages output folder in `wrangler.toml`).
  - `package.json` `version` field (must match).
  - `CHANGELOG.md` (newest first, IST dates).
  - This file (current version line above).
- How to bump (every deployed change, no exceptions): choose the new MAJOR.MINOR.PATCH, then in the SAME pull request
  1. update `version` in `package.json`,
  2. update `public/version.json` (`version`, `releasedAt`, `releasedAtIST`, `commit`, and add an entry at the top of `changes[]`),
  3. add an entry at the top of `CHANGELOG.md` in plain words,
  4. update the "Current version" line in this file.
- Rule of thumb: PATCH = fix with no new behaviour, MINOR = new behaviour that does not break callers, MAJOR = breaking change (API contract in `CONTRACT/`, data, or money behaviour).
- `releasedAt` is the time the version was deployed. `commit` is the commit that was deployed.
