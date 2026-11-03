# Data model

Schema source of truth: [`apps/hub/db/schema.sql`](../../apps/hub/db/schema.sql). The hub applies it on every start. Statements are idempotent, and changes are added as `ALTER TABLE … ADD COLUMN IF NOT EXISTS` so older databases upgrade in place.

IDs are prefixed random strings (`lib/ids.ts`). Most tables carry `org_id` and cascade on organization delete. JSON blobs are stored as `TEXT` (`*_json`) for PGlite and Postgres compatibility.

## Entity overview

```
organizations ─┬─ users ─┬─ recovery_codes
               │         ├─ webauthn_credentials
               │         └─ user_notification_prefs
               ├─ org_settings (active cluster, retention, flags)
               ├─ oidc_providers
               ├─ clusters
               ├─ alert_channels
               ├─ alert_rules ──< alert_events
               ├─ agent_tokens ──< agents ─┬─ agent_metric_samples   (history)
               │                           ├─ agent_metric_latest    (1 row/agent)
               │                           ├─ agent_containers_latest
               │                           └─ agent_k8s_latest
               ├─ security_connections
               ├─ vuln_findings (→ agents, optional)
               ├─ log_events     (→ agents, optional)
               ├─ integration_tokens (1 per kind)
               ├─ otel_metric_samples
               └─ otel_spans
hub-wide:  setup_state (singleton) · hub_bootstrap (singleton)
```

## Tables

### Identity and access

| Table | Key columns | Notes |
| --- | --- | --- |
| `organizations` | `id`, `name`, `setup_completed_at` | |
| `users` | `org_id`, `email` (unique per org), `password_hash`, `role` (`admin`, `operator`, `viewer`), `mfa_enrolled`, `totp_secret`*, `totp_pending`*, `oidc_sub`, `oidc_provider_id` | * sealed with `enc:v1:` |
| `recovery_codes` | `user_id`, `code_hash`, `used_at` | Single use |
| `webauthn_credentials` | `user_id`, `credential_id` (unique), `public_key`, `counter` | |
| `oidc_providers` | `org_id`, `name`, `issuer`, `client_id`, `client_secret`*, `scopes`, `enabled` | |
| `user_notification_prefs` | `user_id`, notify flags per channel, `sms_phone`, quiet hours, `timezone` | |

### Configuration

| Table | Notes |
| --- | --- |
| `org_settings` | `active_cluster_id`, `settings_json` (`metricsRetentionDays`, `logsRetentionDays`, `tracesRetentionDays`, `criticalFindingsToAlarms`) |
| `clusters` | `(org_id, cluster_id)` unique, `is_active` |
| `alert_channels` | `kind` ∈ `smtp`, `slack`, `discord`, `sms`; `config_json` with sealed secrets |
| `alert_rules` | `metric`, `operator`, `threshold`, `warn_threshold`, `alarm_threshold`, `enabled` |
| `security_connections` | GitHub orgs and GitLab projects, with sealed API tokens |
| `integration_tokens` | `kind` ∈ `otel_ingest`, `unifi_webhook`, `runtime_webhook`; `token_hash` unique; one per kind per org |
| `setup_state` | Wizard progress (singleton) |
| `hub_bootstrap` | Bootstrap mode `env`, `rotated` or `disabled`, plus the rotated token hash (singleton, hub-wide) |

### Agents and telemetry

| Table | Shape | Notes |
| --- | --- | --- |
| `agent_tokens` | `token_hash`, `token_hint`, `expires_at`, `max_uses`, `use_count`, `revoked_at` | Enrollment tokens |
| `agents` | `(org_id, hostname)` unique, `version`, `cluster_id`, `secret_hash` (unique), `revoked_at`, `last_seen_at`, `token_id` | Online means `last_seen_at` within about 45 s |
| `agent_metric_samples` | one row per ingest | History for charts. Indexed `(agent_id, collected_at)` |
| `agent_metric_latest` | one row per agent | CPU, memory, load, `disks_json`, `mounts_json` |
| `agent_containers_latest` | one row per agent | `runtime`, `containers_json` (with hub-computed `exitAlert`) |
| `agent_k8s_latest` | one row per agent | `cluster_id`, `summary_json` |
| `otel_metric_samples` | one row per point | Indexed by org/time, metric, service |
| `otel_spans` | one row per span, unique `(org_id, trace_id, span_id)` | Collector retries are idempotent |
| `log_events` | one row per line | `source`, redacted `line`, rule match, optional `agent_id` |

### Alarms and findings

| Table | Notes |
| --- | --- |
| `alert_events` | `rule_id` (nullable for non-rule sources), `severity`, `message`, `payload_json`, `status` (`open`, `resolved`, `dismissed`), `fingerprint`, `muted_until`, `dismissed_at/by`, `resolved_at`. Indexed `(org, status, created_at)` and `(org, fingerprint, created_at)` |
| `vuln_findings` | `source` ∈ `trivy`, `osv`, `github`, `gitlab`, `host_posture`, `runtime`; unique `(org_id, source, external_id, resource, agent_key)`, where `agent_key` is `COALESCE(agent_id, '')` so findings without an agent dedupe correctly; `status`, `resolved_at` |

## Retention

| Data | Window | Job |
| --- | --- | --- |
| `agent_metric_samples`, `otel_metric_samples` | `metricsRetentionDays` (default 60, 30–365) | Every 6 h, plus a throttled purge on ingest |
| `log_events`, closed `alert_events` | `logsRetentionDays` (default 60, 30–365) | Every 6 h |
| `otel_spans` | `tracesRetentionDays` (default 7, 1–60) | Every 6 h |
| `*_latest`, findings, config | Kept | — |
| Open `alert_events` | Never purged | — |

Set `HEIMDALL_DISABLE_PURGE_JOB=1` to turn off the background job (for example during an investigation).

## Sizing guide

These are rough estimates. Measure your own database before relying on them.

| Source | Volume |
| --- | --- |
| One agent at 10 s | 8,640 sample rows a day, about 518k per 60 days |
| OTel hostmetrics | Depends on scrapers. Usually the biggest metrics table |
| Traces (Beyla on busy media servers) | Can reach millions of spans a day. Keep retention short or narrow namespaces |

## Backup scope

| Mechanism | Includes | Excludes |
| --- | --- | --- |
| Admin backup JSON (v1) | clusters, alert channels, rules, remotes, OIDC providers, user inventory | password hashes, telemetry, findings, events |
| `pg_dump` | Everything | `HEIMDALL_SECRET_KEY`. Back it up separately |
