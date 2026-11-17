-- Money hardening. Every statement is idempotent: the harness re-runs all migration files on start.
-- Team bonus: who was in which team for a closed period. Written once, when the period first closes.
CREATE TABLE IF NOT EXISTS team_period (
  target_id TEXT NOT NULL, period_key TEXT NOT NULL, team_id TEXT NOT NULL, company_id TEXT NOT NULL, closed_at INTEGER NOT NULL,
  PRIMARY KEY (target_id, period_key, team_id)
);
CREATE TABLE IF NOT EXISTS team_period_member (
  target_id TEXT NOT NULL, period_key TEXT NOT NULL, team_id TEXT NOT NULL, person_id TEXT NOT NULL, company_id TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1, entitled INTEGER,
  PRIMARY KEY (target_id, period_key, team_id, person_id),
  UNIQUE (target_id, period_key, person_id)       -- a person is paid by one team per period, never two
);
-- A penalty rule proposes at most one case per event.
CREATE TABLE IF NOT EXISTS penalty_rule_hit (
  event_id TEXT NOT NULL, rule_id TEXT NOT NULL, case_id TEXT, at INTEGER NOT NULL,
  PRIMARY KEY (event_id, rule_id)
);
-- One live Moneypenny company per deployment: the signing key in the environment belongs to exactly one company.
CREATE UNIQUE INDEX IF NOT EXISTS one_live_moneypenny ON company(provider) WHERE provider = 'moneypenny' AND live = 1;
