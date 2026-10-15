CREATE TABLE IF NOT EXISTS mintchat_wallet_connections (
  id BIGSERIAL PRIMARY KEY,
  session_id CHAR(64) NOT NULL,
  wallet_address VARCHAR(64) NOT NULL,
  network VARCHAR(32) NOT NULL DEFAULT 'devnet',
  permission_scope JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS mintchat_wallet_session_idx ON mintchat_wallet_connections (session_id, status);

CREATE TABLE IF NOT EXISTS mintchat_trade_intents (
  id UUID PRIMARY KEY,
  session_id CHAR(64) NOT NULL,
  action VARCHAR(24) NOT NULL,
  network VARCHAR(32) NOT NULL,
  input_json JSONB NOT NULL,
  risk_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(32) NOT NULL,
  idempotency_key VARCHAR(160) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mintchat_intents_session_time ON mintchat_trade_intents (session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mintchat_positions (
  id UUID PRIMARY KEY,
  session_id CHAR(64) NOT NULL,
  wallet_address VARCHAR(64) NOT NULL,
  token_mint VARCHAR(64) NOT NULL,
  network VARCHAR(32) NOT NULL,
  quantity NUMERIC(40, 18) NOT NULL DEFAULT 0,
  entry_value_usd NUMERIC(30, 8),
  realized_pnl_usd NUMERIC(30, 8) NOT NULL DEFAULT 0,
  status VARCHAR(24) NOT NULL DEFAULT 'open',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS mintchat_open_position_unique ON mintchat_positions (session_id, wallet_address, token_mint, network) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS mintchat_exit_rules (
  id UUID PRIMARY KEY,
  position_id UUID NOT NULL,
  session_id CHAR(64) NOT NULL,
  rule_type VARCHAR(24) NOT NULL,
  config_json JSONB NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  last_evaluated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mintchat_exit_rules_due_idx ON mintchat_exit_rules (status, last_evaluated_at);

CREATE TABLE IF NOT EXISTS mintchat_worker_jobs (
  id BIGSERIAL PRIMARY KEY,
  job_type VARCHAR(48) NOT NULL,
  job_key VARCHAR(160) NOT NULL UNIQUE,
  payload_json JSONB NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mintchat_jobs_claim_idx ON mintchat_worker_jobs (status, available_at);

CREATE TABLE IF NOT EXISTS mintchat_audit_events (
  id BIGSERIAL PRIMARY KEY,
  session_id CHAR(64) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  entity_id VARCHAR(160),
  detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mintchat_audit_events_session_time ON mintchat_audit_events (session_id, created_at DESC);

INSERT INTO mintchat_schema_migrations (migration_id, checksum) VALUES ('002_trading_domain.sql', encode(digest(convert_to('002_trading_domain.sql', 'UTF8'), 'sha256'), 'hex')) ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION mintchat_touch_updated_at() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS mintchat_trade_intents_touch ON mintchat_trade_intents;
CREATE TRIGGER mintchat_trade_intents_touch BEFORE UPDATE ON mintchat_trade_intents FOR EACH ROW EXECUTE FUNCTION mintchat_touch_updated_at();

DROP TRIGGER IF EXISTS mintchat_positions_touch ON mintchat_positions;
CREATE TRIGGER mintchat_positions_touch BEFORE UPDATE ON mintchat_positions FOR EACH ROW EXECUTE FUNCTION mintchat_touch_updated_at();
