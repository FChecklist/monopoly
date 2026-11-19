-- Round 23: the needs-admin counts and lists filter rewards by company and state. Plain CREATE INDEX IF NOT EXISTS: safe on a fresh database and on an upgrade.
CREATE INDEX IF NOT EXISTS rw_company_state ON reward(company_id, state);
