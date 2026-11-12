# System design

**Status:** current as of November 2026.

## Goals

1. **One pane of glass for a small fleet.** Hosts, containers, Kubernetes, security findings, logs, APM and network events, in one console with one alerting pipeline.
2. **Simple to run.** A single hub process plus Postgres, installable with Compose or Helm. Agents install with one command.
3. **Outbound-only agents.** The hub never connects to monitored hosts. Agents work behind NAT and firewalls.
4. **Trustworthy signals.** Fewer, correct alarms are preferred over many noisy ones (dual bands, cooldowns, auto-recovery).
5. **Secure by default.** No shipped default credentials, per-agent identities, secrets encrypted at rest, SSRF-guarded outbound calls.

### Non-goals

A query language or Grafana-style dashboards; acting as a UniFi controller; cloud security posture management; a hard dependency on privileged eBPF (Falco and Beyla are optional); multi-tenant SaaS (the hub is single-tenant self-hosted; see [security model](security-model.md#known-limitations)).

## Components

```
┌────────────────────── monitored estate ───────────────────────┐
│                                                               │
│  heimdall-agent (Go)            otelcol-contrib (optional)    │
│   ├ host collector               ├ hostmetrics                │
│   ├ container collector ─ docker/podman socket                │
│   ├ k8s collector ─ API server   ├ journald / filelog / pods  │
│   ├ log tailer                   └ OTLP receiver ◄─ app SDKs, │
│   └ trivy runner (optional)                        Beyla eBPF │
└──────┬─────────────────────────────────┬──────────────────────┘
       │ JSON over HTTPS                 │ OTLP/HTTP JSON
       │ /api/v1/agents/*                │ /v1/{metrics,logs,traces}
       ▼                                 ▼
┌──────────────────────── Heimdall hub (Next.js, Node 26) ──────┐
│  http-guard: rate limit · body caps · CSRF · token auth       │
│  ingest ─► store ─► alert engine ─► async dispatch ──► SMTP   │
│                         │                          Slack      │
│  UI (React server comps)│ log rule engine          Discord    │
│  REST API               │ security sync ──► GitHub SMS        │
│  /install.sh /downloads │ OIDC client  ──► IdP     GitLab     │
│  background: retention purge (6 h)    outbound via safeFetch  │
└──────────────────────────────┬────────────────────────────────┘
                               ▼
                    PostgreSQL 16 (PGlite in dev)
```

| Component | Tech | Code |
| --- | --- | --- |
| Hub | Next.js 16 App Router, React 19, TypeScript, Zod, iron-session, jose, SimpleWebAuthn, nodemailer, uPlot | `apps/hub` |
| Database | PostgreSQL 16 via `pg`; PGlite for dev and tests | `apps/hub/db/schema.sql`, `src/lib/db` |
| Agent | Go 1.22, static binary, distroless image; Docker Engine API; client-go | `apps/agent` |
| Collector | OpenTelemetry Collector Contrib 0.111.0 | `deploy/otel`, Helm `otel.*` |
| Packaging | Compose, Helm chart, systemd units, shell installers | `deploy/`, `scripts/` |

## Hub internals

The hub is one Node.js process. Its modules live under `apps/hub/src/lib`:

| Module | Responsibility |
| --- | --- |
| `http-guard/` | Rate limiting, body size caps, same-origin CSRF check (`mutating()`), constant-time compare, `safeFetch` SSRF guard, AES-GCM `crypto-box` |
| `auth/`, `mfa/`, `oidc/`, `rbac/` | Sessions, passwords (bcrypt), TOTP, WebAuthn, OIDC with PKCE and JWKS verification, role → permission matrix |
| `agents/` | Registration, enrollment and bootstrap tokens, ingest authentication |
| `metrics/` | Ingest, threshold samples, history queries, retention, display shaping for containers and pods |
| `alerts/` | Rule evaluation, bands, fingerprints, cooldown, mute, quiet hours, pause, recovery, formatting, channels |
| `logs/` | Log ingest, secret redaction, built-in threat rules |
| `security/` | Parsers (Trivy, OSV, GitHub, GitLab), findings store, remote sync, critical findings → alarms |
| `otel/` | OTLP JSON decoding for metrics, logs and spans; service aggregation; trace UI shaping |
| `integrations/` | UniFi and runtime (Falco) webhook normalization; integration tokens |
| `backup/` | Configuration export and restore (re-encrypts secrets on restore) |
| `host-dist/` | Serves `/install.sh` and allow-listed `/downloads/*` from the `SHA256SUMS` manifest |

The schema is applied on every start from `db/schema.sql`. All statements are idempotent, and later changes are `ALTER … IF NOT EXISTS`. On start, the hub also re-encrypts any legacy plaintext secrets and schedules the retention purge (first after 60 seconds, then every 6 hours).

## Key flows

### 1. Agent enrollment

```
Admin ──"+ Add a server"──► hub mints hdt_ (hash stored, TTL, max uses)
Host  ──curl /install.sh──► installer downloads agent, verifies SHA256SUMS, installs unit
Agent ──POST /agents/register {token, hostname, version}──► hub
        hub: token valid? hostname free (or our own secret)? → mint hda_ secret
Agent ◄─ 201 {agentId, agentSecret} ── stores secret in /var/lib/heimdall/agent-secret (0600)
Agent ──Bearer hda_… on every later call──►
```

Details and edge cases (rebind refusal, legacy tokens, re-enroll) are in [agent design](agent.md#identity-and-registration).

### 2. Metrics ingest and alerting

Every interval (10 s by default), the agent posts one `metrics` payload: host sample, container list, and Kubernetes summary. The hub then:

1. authenticates the agent and checks rate limit and body size;
2. writes `agent_metric_samples` (history) and upserts the `*_latest` tables;
3. derives **threshold samples**, such as `cpu_percent`, `disk_percent:/var`, `mount_missing:/boot`, `container_exited:web`, `k8s_pod_crashloop`;
4. resolves open alarms whose identity is now healthy, and queues "Recovered" notices;
5. evaluates every enabled rule. For each breach it applies cooldown and mute, records an `alert_events` row, and (for the red band only) queues an asynchronous notification.

Notifications never block ingest. See [alerting design](alerting.md).

### 3. Logs

Agent file tail (`/api/v1/agents/logs`) and OTLP logs (`/v1/logs`) both end in `log_events`. Each line is redacted (Heimdall `hd?_` tokens only; other secrets in logs are stored as-is), matched against the built-in rule pack, and stored with its match. Matching rules that alert open an alarm through the same channel pipeline.

### 4. Security findings

Scanners and sources produce findings, normalized to `(source, external_id, resource, agent)` and upserted into `vuln_findings`. Remote sources (GitHub, GitLab) are pulled by the hub through `safeFetch`. Agent-side sources (Trivy image and rootfs) and the Falco webhook push. New critical findings can open alarms.

### 5. OpenTelemetry

Collectors send OTLP/HTTP **JSON** with an `hdo_` token. Metrics go to `otel_metric_samples`. `system.cpu.utilization` and `system.memory.utilization` are mirrored onto the host when the resource carries `heimdall.agent_id`. Logs go to `log_events`. Spans go to `otel_spans`, deduplicated on `(org, trace_id, span_id)`. The Services page computes rate, errors and latency percentiles from spans at query time.

### 6. Browser session

Login (bcrypt) → MFA (TOTP, passkey or recovery code) → sealed `heimdall_session` cookie (`httpOnly`, `SameSite=lax`, `Secure` derived from the public URL). OIDC login uses discovery, PKCE S256, and signature checks on ID tokens against the IdP's JWKS. Every API route calls `requireSession({permission})`. Mutating routes also pass the same-origin check.

## Deployment topologies

| Topology | Hub | DB | Agents |
| --- | --- | --- | --- |
| Lab, single box | Compose `hub` | Compose `postgres` | Compose sample agent + `install.sh` on other hosts |
| Single-node k3s | Helm Deployment | Helm Postgres + PVC | In-cluster agent (K8s + host disks via `/host`), `install.sh` on other hosts, OTel DaemonSet |
| Multi-cluster | One hub anywhere reachable | Any Postgres | One in-cluster agent per cluster with a unique `clusterId` |
| Bare-metal fleet | Any of the above | | `install.sh` (± `OTEL=1`) on every host |

## Scaling characteristics and limits

- **One replica is the supported shape.** Several pieces of state are per-process: rate-limit counters, alert cooldown map, WebAuthn challenges, and the runtime notification-pause flag. Extra replicas work, but each keeps its own copy.
- Alert notifications are fire-and-forget in-process. A hub crash mid-send loses that notification, and there is no retry queue.
- Every agent writes one sample row per interval. At 10 s with 60-day retention, that is about 518k rows per agent in `agent_metric_samples`, purged by the retention job.
- Traces are the highest-volume table. Their retention is separate and short (default 7 days).
- OTLP batch limits: 500 points or records, 1,000 spans per request.

## Related documents

[Agent design](agent.md) · [Alerting](alerting.md) · [Security model](security-model.md) · [Data model](data-model.md) · [Decisions](decisions.md) · [UI design system](../../DESIGN.md)
