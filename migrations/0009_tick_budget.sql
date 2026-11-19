-- Round 26: the clock is bounded. One row per company remembers where the settle stopped (cursor), how many groups are still waiting (backlog) and the last stage error;
-- settle_mark remembers, per (group, person), the fingerprint the group had when it was last settled, so a group that did not change costs no query of its own.
CREATE TABLE IF NOT EXISTS tick_state (
  company_id TEXT PRIMARY KEY REFERENCES company(id),
  tick_seq INTEGER NOT NULL DEFAULT 0,
  settle_cursor TEXT,
  backlog INTEGER NOT NULL DEFAULT 0,      -- groups known to need a visit that the budget did not reach
  sweep_left INTEGER NOT NULL DEFAULT 0,   -- periods the rotating sweep has not looked at yet in this round (information only)
  backlog_ticks INTEGER NOT NULL DEFAULT 0,
  budget_at INTEGER NOT NULL DEFAULT 0,
  err_stage TEXT,
  err_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settle_mark (
  company_id TEXT NOT NULL,
  group_key TEXT NOT NULL,
  person_id TEXT NOT NULL,
  sig TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (company_id, group_key, person_id)
);
