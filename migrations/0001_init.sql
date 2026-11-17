-- Corporate floor game: schema. No credit balances live here. Only rules, events, board state and receipts.
CREATE TABLE IF NOT EXISTS company (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  provider TEXT NOT NULL DEFAULT 'stub',          -- credit_provider: stub (demo only) | moneypenny
  provider_tenant_ref TEXT,
  settings TEXT NOT NULL DEFAULT '{}',
  live INTEGER NOT NULL DEFAULT 0,                 -- 1 only after contract tests pass against the real provider
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS team (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES company(id), name TEXT NOT NULL,
  manager_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS app_user (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES company(id), team_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','hr','employee')),
  work_id_sealed TEXT, work_id_hash TEXT, name_sealed TEXT, email_hash TEXT NOT NULL UNIQUE, email_sealed TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', avatar TEXT NOT NULL DEFAULT 'badge', hide_name INTEGER NOT NULL DEFAULT 0,
  provider_account_ref TEXT, joined_at INTEGER NOT NULL, left_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS user_company ON app_user(company_id, team_id);
CREATE TABLE IF NOT EXISTS session (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, company_id TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_code (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, tries INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS login_attempt (k TEXT NOT NULL, window INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (k, window));
CREATE TABLE IF NOT EXISTS consent (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, company_id TEXT NOT NULL, kind TEXT NOT NULL, version TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS season (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, name TEXT NOT NULL, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
  budget INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL DEFAULT 'steady', status TEXT NOT NULL DEFAULT 'draft', published_at INTEGER,
  hold_id TEXT
);
CREATE TABLE IF NOT EXISTS rate_card (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, event_type TEXT NOT NULL, stage TEXT NOT NULL, stage_no INTEGER NOT NULL DEFAULT 1,
  credits INTEGER NOT NULL, cap_month INTEGER NOT NULL DEFAULT 0, cap_day INTEGER NOT NULL DEFAULT 0,
  state_needed TEXT NOT NULL DEFAULT 'auto' CHECK (state_needed IN ('auto','manager','system')),
  mode TEXT NOT NULL DEFAULT 'individual' CHECK (mode IN ('individual','team','both')),
  rolls INTEGER NOT NULL DEFAULT 1, moves INTEGER NOT NULL DEFAULT 1,
  active_from INTEGER NOT NULL, active_to INTEGER, version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rc_lookup ON rate_card(company_id, event_type, stage, active_from);
CREATE TABLE IF NOT EXISTS period_target (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, name TEXT NOT NULL, scope TEXT NOT NULL CHECK (scope IN ('person','team')),
  period TEXT NOT NULL CHECK (period IN ('week','month','quarter','half','year')),
  event_type TEXT NOT NULL, stage TEXT NOT NULL, active_from INTEGER NOT NULL, active_to INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tier (
  id TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES period_target(id), idx INTEGER NOT NULL, count INTEGER NOT NULL, bonus INTEGER NOT NULL,
  UNIQUE (target_id, idx)
);
CREATE TABLE IF NOT EXISTS streak (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, target_id TEXT NOT NULL REFERENCES period_target(id), length INTEGER NOT NULL, bonus INTEGER NOT NULL,
  freeze_per_quarter INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS event (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, person_id TEXT NOT NULL, submitted_by TEXT, source TEXT NOT NULL,
  event_type TEXT NOT NULL, stage TEXT NOT NULL, ext_id TEXT NOT NULL, occurred_at INTEGER NOT NULL, value INTEGER NOT NULL DEFAULT 0,
  dedupe_hash TEXT, status TEXT NOT NULL, reason TEXT, approvals_required INTEGER NOT NULL DEFAULT 0, approvals_done INTEGER NOT NULL DEFAULT 0,
  rate_card_id TEXT, season_id TEXT, meta TEXT, created_at INTEGER NOT NULL, applied_at INTEGER, reversed_at INTEGER,
  reversal_due INTEGER, reversal_by TEXT, reversal_reason TEXT, reversal_kind TEXT, reversal_appeal INTEGER NOT NULL DEFAULT 0,
  UNIQUE (company_id, event_type, ext_id, stage)
);
CREATE INDEX IF NOT EXISTS ev_person ON event(company_id, person_id, event_type, stage, occurred_at);
CREATE INDEX IF NOT EXISTS ev_status ON event(company_id, status);
CREATE INDEX IF NOT EXISTS ev_dedupe ON event(company_id, event_type, dedupe_hash);
CREATE TABLE IF NOT EXISTS approval (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL, approver_id TEXT NOT NULL, decision TEXT NOT NULL, at INTEGER NOT NULL,
  UNIQUE (event_id, approver_id)
);
-- A reward row is a decision plus a receipt. It is NOT a balance. state: queued -> sent | failed | void
CREATE TABLE IF NOT EXISTS reward (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, person_id TEXT NOT NULL, kind TEXT NOT NULL,
  group_key TEXT, idem_key TEXT NOT NULL UNIQUE, amount INTEGER NOT NULL, period_key TEXT, month_key TEXT, day_key TEXT, season_id TEXT,
  event_id TEXT, rate_card_id TEXT, rate_version INTEGER, state TEXT NOT NULL DEFAULT 'queued',
  provider_ref TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, note TEXT, created_at INTEGER NOT NULL, sent_at INTEGER,
  sent_amount INTEGER, reversed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS rw_person ON reward(company_id, person_id, month_key);
CREATE INDEX IF NOT EXISTS rw_group ON reward(company_id, group_key, person_id);
CREATE INDEX IF NOT EXISTS rw_state ON reward(state);
-- A pending correction is a case record, not a balance and not a debt on wages.
CREATE TABLE IF NOT EXISTS correction (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, person_id TEXT NOT NULL, amount INTEGER NOT NULL, recovered INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'open', reason TEXT, event_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS board_state (
  person_id TEXT PRIMARY KEY, company_id TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, points INTEGER NOT NULL DEFAULT 0,
  laps INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 1, in_lane INTEGER NOT NULL DEFAULT 0, skip_roll INTEGER NOT NULL DEFAULT 0,
  note_ctr INTEGER NOT NULL DEFAULT 0, resets INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS move_log (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, person_id TEXT NOT NULL, event_id TEXT UNIQUE, seed TEXT, dice TEXT,
  from_pos INTEGER, to_pos INTEGER, effects TEXT, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS desk (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, square_idx INTEGER NOT NULL, name TEXT NOT NULL, target_id TEXT,
  price_points INTEGER NOT NULL DEFAULT 200, base_fee INTEGER NOT NULL DEFAULT 20, scope TEXT NOT NULL DEFAULT 'person',
  max_level INTEGER NOT NULL DEFAULT 5, UNIQUE (company_id, square_idx)
);
CREATE TABLE IF NOT EXISTS desk_owner (
  desk_id TEXT NOT NULL, owner_key TEXT NOT NULL, person_id TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 1, claimed_at INTEGER NOT NULL,
  PRIMARY KEY (desk_id, owner_key)
);
CREATE TABLE IF NOT EXISTS pool (company_id TEXT NOT NULL, team_id TEXT NOT NULL, points INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (company_id, team_id));
CREATE TABLE IF NOT EXISTS swap_offer (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, from_person TEXT NOT NULL, to_person TEXT NOT NULL, desk_from TEXT, desk_to TEXT,
  help_text TEXT, state TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS note_card (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'note', text TEXT NOT NULL,
  effect TEXT NOT NULL DEFAULT 'message' CHECK (effect IN ('message','credits','steps','points')), amount INTEGER NOT NULL DEFAULT 0, order_no INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS penalty_rule (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, event_type TEXT NOT NULL, effect TEXT NOT NULL CHECK (effect IN ('steps_back','points','credits','lane')),
  amount INTEGER NOT NULL DEFAULT 0, published_at INTEGER, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS penalty_case (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, person_id TEXT NOT NULL, proposer_id TEXT NOT NULL, event_id TEXT,
  effect TEXT NOT NULL, amount INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'proposed', -- proposed approved pending applied appealed upheld reversed rejected
  approver_id TEXT, approved_at INTEGER, apply_at INTEGER, applied_at INTEGER, appeal_by INTEGER,
  appeal_at INTEGER, appeal_level INTEGER NOT NULL DEFAULT 0, appeal_deadline INTEGER, appeal_final INTEGER,
  applied_credits INTEGER NOT NULL DEFAULT 0, applied_steps INTEGER NOT NULL DEFAULT 0, applied_points INTEGER NOT NULL DEFAULT 0, prev_pos INTEGER,
  decision_note TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lane_task (id TEXT PRIMARY KEY, company_id TEXT NOT NULL, person_id TEXT NOT NULL, task TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL);
-- Append-only hash chain per company.
CREATE TABLE IF NOT EXISTS audit (
  company_id TEXT NOT NULL, n INTEGER NOT NULL, actor TEXT, action TEXT NOT NULL, data TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (company_id, n)
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit rows cannot change'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit rows cannot be deleted'); END;
CREATE TABLE IF NOT EXISTS company_key (
  key_id TEXT PRIMARY KEY, company_id TEXT NOT NULL, scope TEXT NOT NULL CHECK (scope IN ('ingest','widgets','provider_webhook')), label TEXT, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS replay (sig TEXT PRIMARY KEY, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ingest_rate (key_id TEXT NOT NULL, window INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (key_id, window));
CREATE TABLE IF NOT EXISTS catalogue_item (id TEXT PRIMARY KEY, company_id TEXT NOT NULL, name TEXT NOT NULL, credits INTEGER NOT NULL, needs_approval INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS catalogue_order (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, person_id TEXT NOT NULL, item_id TEXT NOT NULL, credits INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'reserved', hold_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rights_request (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, person_id TEXT NOT NULL, kind TEXT NOT NULL, note TEXT, state TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_event (id TEXT PRIMARY KEY, company_id TEXT, type TEXT NOT NULL, body TEXT, at INTEGER NOT NULL);
