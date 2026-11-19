-- The clock: when a tick was last claimed and when one last finished (lazy tick, overview alert when stale).
ALTER TABLE company ADD COLUMN last_tick_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE company ADD COLUMN last_tick_ok_at INTEGER NOT NULL DEFAULT 0;
