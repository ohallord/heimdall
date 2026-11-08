# HTTP API reference

All endpoints take and return JSON, except `/install.sh` and `/downloads/*`. Base path: `https://<hub>`.

## Authentication

| Kind | How | Used by |
| --- | --- | --- |
| **Session** | `heimdall_session` cookie from `/api/v1/auth/login` (plus MFA) or OIDC | The console, scripts acting as a user |
| **Agent** | `Authorization: Bearer <hda_ secret>` (or `X-Heimdall-Token`) | Agents after registration |
| **Registration** | `token` field in the request body (`hdt_` enrollment, bootstrap or `hdb_`) | `POST /api/v1/agents/register` |
| **Integration** | `Authorization: Bearer <hdo_/hdu_/hdr_>` (or `X-Heimdall-Token`) | OTLP, UniFi, Falco |
| **Public** | none | Health, setup status, installer, downloads, OIDC redirects |

Session requests that change state (`POST`, `PUT`, `PATCH`, `DELETE`) must come from the hub's own origin. The `Origin` or `Sec-Fetch-Site` header is checked against `HEIMDALL_PUBLIC_URL`. A cross-origin request gets `403 csrf`.

**Permissions** (see [roles](../user-guide/overview.md#core-concepts)): `viewer` has `org:read`, `agents:read`, `alerts:read`. `operator` adds `agents:write`, `alerts:write`. `admin` adds `org:write`, `users:invite`, `settings:write`, `setup:run`.

**Errors** are `{"error": "<code or message>"}` with a matching status: `400` validation, `401` unauthenticated, `403` forbidden, CSRF or revoked, `404`, `409` conflict (such as `hostname_in_use`), `413` body too large, `415` unsupported content type, `429` rate limited (with `Retry-After`).

## Public

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/v1/health` | `{"status":"ok","service":"heimdall-hub","time":…}` |
| GET | `/api/v1/setup/status` | Wizard progress |
| GET | `/install.sh` | Host installer with the hub URL baked in |
| GET | `/downloads/<name>` | Agent binaries, installers, `SHA256SUMS` (only names listed in the manifest are served) |

## Auth

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/api/v1/auth/login` | — | `{email, password}`. May answer that MFA is required |
| POST | `/api/v1/auth/mfa/verify` | partial session | TOTP or recovery code |
| POST | `/api/v1/auth/mfa/totp/enroll` | session (verified MFA if a factor already exists) | `{"action":"start"}` then confirm with a code |
| POST | `/api/v1/auth/mfa/webauthn/register/options` | session | Passkey registration options |
| POST | `/api/v1/auth/mfa/webauthn/register/verify` | session | Finish passkey registration |
| POST | `/api/v1/auth/logout` | session | |
| GET | `/api/v1/auth/me` | session | Current user, role, org |
| GET | `/api/v1/auth/oidc/start` | — | Redirect to the IdP (PKCE) |
| GET | `/api/v1/auth/oidc/callback` | — | IdP redirect target |
| GET / POST | `/api/v1/auth/oidc/providers` | GET public (admins see full config) · POST `settings:write` | Login-page provider list; manage SSO providers |

## Setup wizard

| Method | Path | Permission |
| --- | --- | --- |
| POST | `/api/v1/setup/org-admin` | bootstrap token in `setupToken` (first run only, one admin) |
| POST | `/api/v1/setup/channels` | `setup:run`. Upserts SMTP, Slack, Discord and SMS channels; works after setup too |
| POST | `/api/v1/setup/agent-token` | `setup:run` |
| POST | `/api/v1/setup/remotes` | `setup:run` |
| POST | `/api/v1/setup/complete` | `setup:run` |

## Agent ingest (agent auth)

| Method | Path | Body cap | Notes |
| --- | --- | --- | --- |
| POST | `/api/v1/agents/register` | 64 KB | `{token, hostname, version, agentSecret?}` → `201 {agentId, hostname, version, registeredAt, protocol:"heimdall.handshake.v0", agentSecret?}`. `agentSecret` is returned only when a new one is minted |
| POST | `/api/v1/agents/heartbeat` | 64 KB | |
| POST | `/api/v1/agents/metrics` | 1 MB | Host sample + `containers` + `k8s` |
| POST | `/api/v1/agents/logs` | 2 MB | `{lines:[{source,line,observedAt}]}` → `{lines, matches, alertsFired}` |
| POST | `/api/v1/agents/vulns` | 10 MB | Trivy report with `scanKind` (`trivy` or `host_posture`) |

## Agents and tokens (session)

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/agents` | `agents:read` |
| DELETE | `/api/v1/agents/{agentId}` | `agents:write` |
| POST | `/api/v1/agents/{agentId}/revoke` | `agents:write` |
| POST | `/api/v1/agents/{agentId}/reenroll` | `agents:write` |
| GET | `/api/v1/agents/{agentId}/metrics/history` | `agents:read` |
| GET / POST | `/api/v1/agents/tokens` | `agents:read` / `agents:write`. POST `{name, ttlHours?, maxUses?}` returns the plaintext once |
| POST | `/api/v1/agents/tokens/{tokenId}/replace` | `agents:write` |
| DELETE | `/api/v1/agents/tokens/{tokenId}` | `agents:write` (revoke) |
| GET / POST | `/api/v1/admin/bootstrap-token` | `agents:read` / `settings:write` (rotate, disable, use env) |

## Alerts

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| GET | `/api/v1/alerts/rules` | `agents:read` | |
| PATCH | `/api/v1/alerts/rules/{ruleId}` | `alerts:write` | `{warnThreshold?, alarmThreshold?, enabled?}` |
| GET | `/api/v1/alerts/history` | `alerts:read` | |
| POST | `/api/v1/alerts/{id}/mute` | `alerts:write` | `{minutes: 15|30|60|240}` |
| POST | `/api/v1/alerts/{id}/unmute` | `alerts:write` | |
| POST | `/api/v1/alerts/{id}/dismiss` | `alerts:write` | |
| POST | `/api/v1/alerts/dismiss-bulk` | `alerts:write` | |
| GET / POST | `/api/v1/alerts/pause` | `alerts:read` / `alerts:write` | Global notification pause |
| POST | `/api/v1/alerts/test` | `alerts:write` | Sends a test through every channel |
| GET / PUT | `/api/v1/notifications/prefs` | `alerts:read` | Your own channel flags, SMS number, quiet hours, timezone |

## Org, clusters, logs

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| GET / PATCH | `/api/v1/org/settings` | `agents:read` / `alerts:write` | `metricsRetentionDays`, `logsRetentionDays`, `tracesRetentionDays`, `criticalFindingsToAlarms` |
| GET / POST / PATCH | `/api/v1/clusters` | `agents:read` / `settings:write` | |
| POST | `/api/v1/clusters/active` | `settings:write` | |
| GET | `/api/v1/logs/search` | `agents:read` | `q`, `rule`, `agentId`, `matchesOnly=1`, `limit` (default 50) |

## Security

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| GET | `/api/v1/security/findings` | `agents:read` | Filter by `source` |
| GET / PATCH | `/api/v1/security/findings/{id}` | `agents:read` / `alerts:write` | Change status |
| POST | `/api/v1/security/scan` | `alerts:write` | `{trivyReport?, osvReport?, syncRemotes?}` |
| GET / POST | `/api/v1/security/connections` | `agents:read` / `settings:write` | GitHub orgs and GitLab projects |

## Integrations

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET / POST | `/api/v1/integrations/otel` | `agents:read` / `settings:write` | Token hint / rotate `hdo_` |
| GET / POST | `/api/v1/integrations/unifi` | `agents:read` / `settings:write` | Token hint / rotate `hdu_` |
| GET / POST | `/api/v1/integrations/runtime` | `agents:read` / `settings:write` | Token hint / rotate `hdr_` |
| POST | `/api/v1/integrations/unifi/webhook` | `hdu_` | UniFi Network or Protect alarm JSON. 1 MB cap |
| POST | `/api/v1/integrations/runtime/webhook` | `hdr_` | Falco event, array, or `{events:[…]}` |
| POST | `/v1/metrics` | `hdo_` | OTLP/HTTP JSON, ≤ 500 points |
| POST | `/v1/logs` | `hdo_` | OTLP/HTTP JSON, ≤ 500 records |
| POST | `/v1/traces` | `hdo_` | OTLP/HTTP JSON, ≤ 1,000 spans (extras reported in `partialSuccess`) |

The OTLP endpoints reject protobuf with `415`. Configure collectors with `encoding: json`.

## Read-only MCP

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/mcp` | `Authorization: Bearer` `HEIMDALL_MCP_TOKEN` | Stateless streamable HTTP. Tools only report state (`heimdall_status`, `heimdall_agents`, `heimdall_agent`, `heimdall_alerts`, `heimdall_findings`). No writes. Session cookies do not authorize this path. Missing or wrong bearer, or a non-local Host when the token is unset, is `401` with `WWW-Authenticate: Bearer realm="heimdall"`. See [MCP exposure](../runbooks/mcp-exposure.md) |

## Backup

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| GET | `/api/v1/admin/backup` | `settings:write` | `?includeSecrets=1` to include plaintext secrets |
| POST | `/api/v1/admin/backup` | `settings:write` | `{"backup": {…}}`, upserts into the session's org |
