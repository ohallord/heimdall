-- Heimdall Phase 1 schema

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  setup_completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
  mfa_enrolled BOOLEAN NOT NULL DEFAULT FALSE,
  totp_secret TEXT,
  oidc_sub TEXT,
  oidc_provider_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, email)
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  transports TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alert_channels (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('smtp', 'slack', 'discord', 'sms')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_tokens (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_hint TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

-- Multi-cluster registry (activated in Phase 8 UX).
CREATE TABLE IF NOT EXISTS clusters (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  cluster_id TEXT NOT NULL,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, cluster_id)
);

CREATE TABLE IF NOT EXISTS org_settings (
  org_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  active_cluster_id TEXT NOT NULL DEFAULT 'default',
  settings_json TEXT NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oidc_providers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT 'openid profile email',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token_id TEXT REFERENCES agent_tokens(id) ON DELETE SET NULL,
  hostname TEXT NOT NULL,
  version TEXT NOT NULL,
  cluster_id TEXT NOT NULL DEFAULT 'default',
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, hostname)
);

-- Phase 24: per-agent credentials.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS secret_hash TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS legacy_warned_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS agents_secret_hash_idx ON agents (secret_hash) WHERE secret_hash IS NOT NULL;
ALTER TABLE agent_tokens ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE agent_tokens ADD COLUMN IF NOT EXISTS max_uses INTEGER;
ALTER TABLE agent_tokens ADD COLUMN IF NOT EXISTS use_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  metric TEXT NOT NULL,
  operator TEXT NOT NULL CHECK (operator IN ('gt', 'gte', 'lt', 'lte', 'eq')),
  threshold DOUBLE PRECISION NOT NULL,
  warn_threshold DOUBLE PRECISION,
  alarm_threshold DOUBLE PRECISION,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Additive for DBs created before Phase 10 dual thresholds
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS warn_threshold DOUBLE PRECISION;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS alarm_threshold DOUBLE PRECISION;

CREATE TABLE IF NOT EXISTS alert_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rule_id TEXT REFERENCES alert_rules(id) ON DELETE SET NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  message TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Phase 16 alarm ops
  status TEXT NOT NULL DEFAULT 'open',
  fingerprint TEXT,
  muted_until TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  dismissed_by TEXT
);

-- Additive for DBs created before Phase 16 alarm ops
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS fingerprint TEXT;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS muted_until TIMESTAMPTZ;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS dismissed_by TEXT;
-- Phase 26 auto-recovery
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS alert_events_org_status_created_idx
  ON alert_events (org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS alert_events_org_fingerprint_idx
  ON alert_events (org_id, fingerprint, created_at DESC);

-- Phase 5: per-user notification preferences + quiet hours
CREATE TABLE IF NOT EXISTS user_notification_prefs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  notify_smtp BOOLEAN NOT NULL DEFAULT TRUE,
  notify_slack BOOLEAN NOT NULL DEFAULT TRUE,
  notify_discord BOOLEAN NOT NULL DEFAULT TRUE,
  notify_sms BOOLEAN NOT NULL DEFAULT TRUE,
  sms_phone TEXT,
  quiet_hours_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  quiet_start TEXT NOT NULL DEFAULT '22:00',
  quiet_end TEXT NOT NULL DEFAULT '07:00',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS setup_state (
  id TEXT PRIMARY KEY DEFAULT 'singleton',
  current_step TEXT NOT NULL DEFAULT 'org_admin',
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_metric_samples (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  collected_at TIMESTAMPTZ NOT NULL,
  cpu_percent DOUBLE PRECISION NOT NULL,
  mem_percent DOUBLE PRECISION NOT NULL,
  mem_used_bytes BIGINT NOT NULL DEFAULT 0,
  mem_total_bytes BIGINT NOT NULL DEFAULT 0,
  load1 DOUBLE PRECISION NOT NULL DEFAULT 0,
  load5 DOUBLE PRECISION NOT NULL DEFAULT 0,
  load15 DOUBLE PRECISION NOT NULL DEFAULT 0,
  disks_json TEXT NOT NULL DEFAULT '[]',
  mounts_json TEXT NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phase 11: range history queries
CREATE INDEX IF NOT EXISTS agent_metric_samples_agent_collected_idx
  ON agent_metric_samples (agent_id, collected_at DESC);

CREATE TABLE IF NOT EXISTS agent_metric_latest (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  collected_at TIMESTAMPTZ NOT NULL,
  cpu_percent DOUBLE PRECISION NOT NULL,
  mem_percent DOUBLE PRECISION NOT NULL,
  mem_used_bytes BIGINT NOT NULL DEFAULT 0,
  mem_total_bytes BIGINT NOT NULL DEFAULT 0,
  load1 DOUBLE PRECISION NOT NULL DEFAULT 0,
  load5 DOUBLE PRECISION NOT NULL DEFAULT 0,
  load15 DOUBLE PRECISION NOT NULL DEFAULT 0,
  disks_json TEXT NOT NULL DEFAULT '[]',
  mounts_json TEXT NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_containers_latest (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  runtime TEXT NOT NULL DEFAULT 'none',
  containers_json TEXT NOT NULL DEFAULT '[]',
  collected_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_k8s_latest (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  cluster_id TEXT NOT NULL DEFAULT 'default',
  summary_json TEXT NOT NULL DEFAULT '{}',
  collected_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phase 6: remote SCM credentials + unified vulnerability findings
CREATE TABLE IF NOT EXISTS security_connections (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('github', 'gitlab')),
  name TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  token_hint TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, kind, name)
);

CREATE TABLE IF NOT EXISTS vuln_findings (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('trivy', 'osv', 'github', 'gitlab', 'host_posture', 'runtime')),
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'unknown',
  package_name TEXT,
  package_version TEXT,
  fixed_version TEXT,
  resource TEXT,
  cve TEXT,
  url TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  raw_json TEXT NOT NULL DEFAULT '{}',
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  -- Denormalized COALESCE(agent_id,'') so UNIQUE treats NULL agent like remotes/images
  agent_key TEXT NOT NULL DEFAULT '',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (org_id, source, external_id, resource, agent_key)
);

-- Phase 13 additive for DBs created before host posture
ALTER TABLE vuln_findings ADD COLUMN IF NOT EXISTS agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE vuln_findings ADD COLUMN IF NOT EXISTS agent_key TEXT NOT NULL DEFAULT '';
ALTER TABLE vuln_findings DROP CONSTRAINT IF EXISTS vuln_findings_source_check;
ALTER TABLE vuln_findings ADD CONSTRAINT vuln_findings_source_check
  CHECK (source IN ('trivy', 'osv', 'github', 'gitlab', 'host_posture', 'runtime'));
-- Replace pre-Phase-13 unique (4-col) and recreate named 5-col unique
ALTER TABLE vuln_findings DROP CONSTRAINT IF EXISTS vuln_findings_org_id_source_external_id_resource_key;
ALTER TABLE vuln_findings DROP CONSTRAINT IF EXISTS vuln_findings_org_id_source_external_id_resource_agent_key_key;
ALTER TABLE vuln_findings DROP CONSTRAINT IF EXISTS vuln_findings_org_source_ext_res_agent_key;
ALTER TABLE vuln_findings ADD CONSTRAINT vuln_findings_org_source_ext_res_agent_key
  UNIQUE (org_id, source, external_id, resource, agent_key);

-- Phase 18: operator resolve timestamp
ALTER TABLE vuln_findings ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- Phase 7: streamed log lines + rule matches
CREATE TABLE IF NOT EXISTS log_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  source TEXT NOT NULL,
  line TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  matched_rules_json TEXT NOT NULL DEFAULT '[]',
  severity TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS log_events_org_observed_idx
  ON log_events (org_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS log_events_org_source_idx
  ON log_events (org_id, source);

-- Phase 14: UniFi webhook + OTEL ingest shared secrets
-- Phase 20: runtime_webhook (Falco/sidekick optional adapter)
CREATE TABLE IF NOT EXISTS integration_tokens (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('unifi_webhook', 'otel_ingest', 'runtime_webhook')),
  token_hash TEXT NOT NULL,
  token_hint TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, kind),
  UNIQUE (token_hash)
);

ALTER TABLE integration_tokens DROP CONSTRAINT IF EXISTS integration_tokens_kind_check;
ALTER TABLE integration_tokens ADD CONSTRAINT integration_tokens_kind_check
  CHECK (kind IN ('unifi_webhook', 'otel_ingest', 'runtime_webhook'));

-- Phase 14: OTLP HTTP JSON metric points
CREATE TABLE IF NOT EXISTS otel_metric_samples (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  resource_service TEXT,
  resource_host TEXT,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  metric_name TEXT NOT NULL,
  unit TEXT,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  value DOUBLE PRECISION NOT NULL,
  collected_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS otel_metric_samples_org_collected_idx
  ON otel_metric_samples (org_id, collected_at DESC);

CREATE INDEX IF NOT EXISTS otel_metric_samples_org_metric_idx
  ON otel_metric_samples (org_id, metric_name, collected_at DESC);

CREATE INDEX IF NOT EXISTS otel_metric_samples_org_service_idx
  ON otel_metric_samples (org_id, resource_service, collected_at DESC);

INSERT INTO setup_state (id, current_step, completed)
VALUES ('singleton', 'org_admin', FALSE)
ON CONFLICT (id) DO NOTHING;

-- pending TOTP replacement (old secret stays active until confirm)
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending TEXT;

-- Phase 29: OTLP trace spans (APM foundation)
CREATE TABLE IF NOT EXISTS otel_spans (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  service_name TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'unspecified',
  status_code TEXT NOT NULL DEFAULT 'unset',
  status_message TEXT,
  start_at TIMESTAMPTZ NOT NULL,
  duration_ms DOUBLE PRECISION NOT NULL,
  resource_host TEXT,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, trace_id, span_id)
);

CREATE INDEX IF NOT EXISTS otel_spans_org_start_idx
  ON otel_spans (org_id, start_at DESC);

CREATE INDEX IF NOT EXISTS otel_spans_org_trace_idx
  ON otel_spans (org_id, trace_id);

CREATE INDEX IF NOT EXISTS otel_spans_org_service_idx
  ON otel_spans (org_id, service_name, start_at DESC);

-- Phase 32: hub-wide bootstrap token override (rotate / disable from Settings → Agents)
CREATE TABLE IF NOT EXISTS hub_bootstrap (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'env' CHECK (mode IN ('env', 'rotated', 'disabled')),
  token_hash TEXT,
  token_hint TEXT,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Security review: server-side session revocation. Bumped on logout; cookies carry the
-- version they were issued at and stop working once it moves.
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
-- Security review: last accepted TOTP time step (blocks code replay inside the window).
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT;
