CREATE TABLE IF NOT EXISTS mintchat_sessions (
  session_id CHAR(64) PRIMARY KEY,
  state_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mintchat_tool_audit (
  id BIGSERIAL PRIMARY KEY,
  session_id CHAR(64) NOT NULL,
  plugin_name VARCHAR(80) NOT NULL,
  tool_name VARCHAR(128) NOT NULL,
  outcome VARCHAR(32) NOT NULL,
  detail_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mintchat_audit_session_time ON mintchat_tool_audit (session_id, created_at);
