-- Floor 0003: AI-ready machine API, key classes, per-key sealed secrets, erasure marker, temporary login lock.
-- Key classes: read < event_write < manager < admin ; ai_read is separate ; provider_webhook is separate.
-- Old scope names: widgets -> read, ingest -> event_write.
CREATE TABLE company_key_v3 (
  key_id TEXT PRIMARY KEY, company_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('read','event_write','manager','admin','ai_read','provider_webhook')),
  label TEXT, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL,
  secret_sealed TEXT                                   -- random signing secret, sealed. NULL = older key whose secret is derived (still works)
);
INSERT INTO company_key_v3 (key_id, company_id, scope, label, status, created_at)
  SELECT key_id, company_id, CASE scope WHEN 'widgets' THEN 'read' WHEN 'ingest' THEN 'event_write' ELSE scope END, label, status, created_at FROM company_key;
DROP TABLE company_key;
ALTER TABLE company_key_v3 RENAME TO company_key;
CREATE INDEX IF NOT EXISTS key_company ON company_key(company_id);

ALTER TABLE app_user ADD COLUMN erased_at INTEGER;     -- set when a leaver's personal fields were scrubbed (DPDP)
ALTER TABLE login_code ADD COLUMN locked_until INTEGER NOT NULL DEFAULT 0;

-- A request from a machine (AI agent or system) that only a signed-in human can decide. It never executes by itself.
CREATE TABLE IF NOT EXISTS ai_request (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, key_id TEXT NOT NULL, caller_type TEXT NOT NULL CHECK (caller_type IN ('ai','system')),
  op TEXT NOT NULL, payload TEXT NOT NULL, reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired','cancelled')),
  decided_by TEXT, decided_at INTEGER, idem TEXT, result TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS air_company ON ai_request(company_id, status, created_at);
CREATE INDEX IF NOT EXISTS air_key ON ai_request(key_id, status);

-- Idempotency for every v1 write: same key + same body replays the stored answer.
CREATE TABLE IF NOT EXISTS api_idem (
  key_id TEXT NOT NULL, idem TEXT NOT NULL, req_hash TEXT NOT NULL, state TEXT NOT NULL, body TEXT, status INTEGER, at INTEGER NOT NULL,
  UNIQUE (key_id, idem)
);
