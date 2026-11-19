-- Round 27: the error state of the clock is kept PER STAGE (a stage that failed stays flagged until THAT stage runs cleanly again, whichever turn it belongs to), the tick state remembers when each turn
-- (core, settle) last ran cleanly, and whether the budget is too small for one unit of work. New table plus new columns only: safe on a fresh database and on an upgrade from 0009.
CREATE TABLE IF NOT EXISTS tick_stage (
  company_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  first_at INTEGER NOT NULL DEFAULT 0,  -- first failure of the current streak of failures
  last_at INTEGER NOT NULL DEFAULT 0,   -- last failure
  count INTEGER NOT NULL DEFAULT 0,     -- failures since the stage last ran cleanly (0 = healthy)
  ok_at INTEGER NOT NULL DEFAULT 0,     -- last clean run
  PRIMARY KEY (company_id, stage)
);
ALTER TABLE tick_state ADD COLUMN core_ok_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tick_state ADD COLUMN settle_ok_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tick_state ADD COLUMN budget_small TEXT;  -- 'needs:have' when one visit does not fit the budget (shown as an alert), else NULL
