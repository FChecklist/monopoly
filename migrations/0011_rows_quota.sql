-- Round 28: the free D1 plan also limits ROWS (5 million read and 100 thousand written per day; past it every query fails until 00:00 UTC).
-- 1. An index for the queries of the settle (events of one type and stage in a time range): without it every such query scanned all events of the company.
-- 2. The clock counts the rows it reads and writes per UTC day (rows_read_day / rows_written_day), and how many OLD periods (cold rotation) it looked at today (cold_used), so that
--    a driver run stops when only cold work is left and the settle keeps to hot work above the soft limit.
CREATE INDEX IF NOT EXISTS ev_type_time ON event (company_id, event_type, stage, occurred_at);
ALTER TABLE tick_state ADD COLUMN rows_day INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tick_state ADD COLUMN rows_read_day INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tick_state ADD COLUMN rows_written_day INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tick_state ADD COLUMN cold_day INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tick_state ADD COLUMN cold_used INTEGER NOT NULL DEFAULT 0;
