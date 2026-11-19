-- Floor 0005: one table for every outbound provider operation whose reply can be lost (see docs/design/PROVIDER-OPS.md).
-- key = the idempotency key sent to the provider. state: intended | landed | refused | unknown.
-- claim_until: a per-call lease, so two overlapping workers never both decide. tries counts calls (counted at claim, so a crash counts too).
-- params / result hold ids and amounts only: never a secret, never a person's e-mail.
CREATE TABLE IF NOT EXISTS provider_op (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  subject TEXT,
  params TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'intended',
  tries INTEGER NOT NULL DEFAULT 0,
  budget INTEGER NOT NULL DEFAULT 5,
  last_code TEXT,
  result TEXT,
  settled INTEGER NOT NULL DEFAULT 0,
  claim_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (company_id, key)
);
CREATE INDEX IF NOT EXISTS pop_open ON provider_op(company_id, kind, settled);
CREATE INDEX IF NOT EXISTS audit_action ON audit(company_id, action);
