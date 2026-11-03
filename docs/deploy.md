# Deploying Heimdall (self-hosters)

Heimdall ships three first-class install paths: **Helm** (Kubernetes), **Docker Compose** (dev / small fleets), and **standalone** (binary + systemd). For a guided walkthrough, start with the [installation guide](user-guide/installation.md); this page is the detailed reference.

## Install matrix

| Path | When to use | Hub | Agent |
| --- | --- | --- | --- |
| **Helm** | Production / lab clusters (k3s, etc.) | Chart `deploy/helm/heimdall` | In-cluster Deployment + RBAC (`HEIMDALL_ENABLE_K8S=true`) |
| **Docker Compose** | Local / single-host smoke | `deploy/docker` | Compose service; K8s scrape off by default |
| **Standalone** | Bare metal / VM without Compose | Any reachable hub | Agent: `scripts/install-agent.sh` · Agent + OTEL metrics/logs: `scripts/install-baremetal.sh` + `heimdall-agent` / `heimdall-otelcol` units |

### Agent roles (same binary)

One `heimdall-agent` binary covers:

- **Host metrics** — always (CPU / mem / watch mounts)
- **Containers** — when Docker or Podman socket is available (`DOCKER_HOST_SOCKET` / defaults)
- **Kubernetes** — when `HEIMDALL_ENABLE_K8S=true` and the process can reach the API (in-cluster SA or kubeconfig)

Bare-metal hosts with no socket should leave K8s disabled; the hub hides empty container chrome on host detail and shows containers on **Dashboard → Containers**.

### Host posture (optional Trivy)

Heimdall can surface **host** OS CVEs and misconfigs via Trivy `rootfs` (findings source `host_posture`). Trivy is **not** bundled in the default distroless agent image.

| Piece | Notes |
| --- | --- |
| Binary | Install [Trivy](https://trivy.dev/) on the host (or side container) and ensure it is on `PATH`, or set `HEIMDALL_TRIVY_BIN` |
| Root path | `HEIMDALL_HOST_ROOT` if set; else `/host` when that directory exists (Helm hostPath); else `/` |
| One-shot | `heimdall-agent scan-host [--root PATH]` |
| Schedule | `HEIMDALL_HOST_POSTURE=1` in the agent env (default interval **24h**, override with `HEIMDALL_HOST_POSTURE_INTERVAL`); soft-skips if Trivy is missing |
| Timeout | Default 10m; override `HEIMDALL_TRIVY_TIMEOUT` |
| Helm | Keep `agent.hostMounts.enabled: true` so the agent sees host filesystems at `/host` |
| Compose | `docker compose --profile with-trivy up` runs `agent-posture` (host `/` → `/host`, `HEIMDALL_HOST_POSTURE=1`). Bind-mount Trivy via `TRIVY_HOST_BIN` (default `/usr/local/bin/trivy`). Or use standalone agent on the host. |

UI: host detail **Security / Posture**, and **Dashboard → Security** filtered to Host posture.

**How-to + one-shot script:** [`host-posture.md`](host-posture.md) · [`scripts/scan-host-posture.sh`](../scripts/scan-host-posture.sh)

### One-command host install

Get the command from **Settings → Agents → + Add a server**: it mints a single-use, 24 h token and shows the exact `curl` line. Token rotation and the bootstrap token are covered in [runbooks/bootstrap-token.md](runbooks/bootstrap-token.md).

The hub serves the agent for linux/amd64 and linux/arm64 plus the host installers, so a host needs no repo checkout or Go toolchain:

```bash
curl -fsSL https://<hub>/install.sh | sudo bash                  # prompts for the agent token (hdt_…)
curl -fsSL https://<hub>/install.sh | sudo OTEL=1 bash           # + OTel collector (prompts for hdo_…)
curl -fsSL https://<hub>/install.sh | sudo TOKEN=hdt_… bash      # non-interactive (see note below)
curl -fsSL https://<hub>/install.sh | sudo bash -s -- --uninstall   # PURGE=1 also removes /var/lib/heimdall
```

- `/install.sh` has `HUB_URL` baked in from `HEIMDALL_PUBLIC_URL` (else the request origin). Set `HEIMDALL_PUBLIC_URL` when the hub sits behind a proxy.
- Every file comes from `/downloads/<name>` and is checked against the hub's `/downloads/SHA256SUMS` before anything is installed; a mismatch installs nothing. Trust rests on TLS to the hub, so use `https://` outside a lab.
- Prefer the prompt or `TOKEN_FILE`. With `sudo TOKEN=… bash` the token is part of sudo's command line, which systemd-journald records (`_CMDLINE`) and log shippers forward. The hub redacts Heimdall tokens (`hdt_`, `hda_`, `hdb_`, `hdo_`, `hdu_`, `hdr_`) from ingested logs, but the host journal and any other log tool keep the plain value.
- Tokens come from `TOKEN_FILE`, `TOKEN`, or a prompt on the terminal (works under `curl | bash`); `OTEL_TOKEN_FILE` / `OTEL_TOKEN` likewise. Pass-through: `HOSTNAME_VALUE`, `CLUSTER_ID`, `ENABLE_K8S`, `LOG_UNITS`, `LOG_PATHS`, `DRY_RUN=1`.
- When a `docker` group exists the agent user joins it so container metrics work. That is root-equivalent access to Docker on that host; pass `DOCKER=0` to skip (container metrics are then skipped, logged once). Re-running the installer restarts the agent, so it also upgrades it.
- Linux + systemd, x86_64 / aarch64. Under the hood it runs the same `install-agent.sh` / `install-otelcol.sh` documented below.
- The hub image builds the agent at image build time (`scripts/build-dist.sh`; the agent version is the git SHA under `deploy-cluster.sh`). Compose needs v2.17+ for `additional_contexts`. Outside Docker, run `scripts/build-dist.sh` once; `/downloads/*` returns 404 with that hint until you do.

### Standalone (binary + systemd)

**Agent only:**

```bash
# From repo root — build then install:
cd apps/agent && go build -o bin/heimdall-agent ./cmd/agent && cd ../..

HUB_URL=https://heimdall.example.com TOKEN=hdt_… \
  ./scripts/install-agent.sh

# Preview without writing:
HUB_URL=http://127.0.0.1:43123 TOKEN=hdt_dev DRY_RUN=1 ./scripts/install-agent.sh
```

Unit: [`deploy/systemd/heimdall-agent.service`](../deploy/systemd/heimdall-agent.service). Env: `/etc/heimdall/agent.env`. Script creates system user `heimdall` and `/var/lib/heimdall` when missing.

**Agent + OpenTelemetry (metrics + journal/file logs)** — preferred for bare metal that should report service logs:

```bash
# Requires otelcol-contrib on PATH (or OTELCOL_BIN=…).
# OTEL_TOKEN from Settings → Integrations (hdo_…).
HUB_URL=https://heimdall.example.com TOKEN=hdt_… OTEL_TOKEN=hdo_… \
  LOG_UNITS=sshd.service,nginx.service \
  ./scripts/install-baremetal.sh

HUB_URL=… TOKEN=… OTEL_TOKEN=… DRY_RUN=1 ./scripts/install-baremetal.sh
```

Units: agent + [`deploy/systemd/heimdall-otelcol.service`](../deploy/systemd/heimdall-otelcol.service). Collector config: `/etc/heimdall/otel-collector.yaml`. Details: [`otel.md`](otel.md).

## Prerequisites

- Postgres 16+ (Compose includes one; Helm can embed or use an external URL)
- Outbound HTTPS from agents to the hub (agents dial out; hub does not need to reach hosts)
- For OIDC: a public hub URL and IdP redirect allow-list entry for  
  `{HEIMDALL_PUBLIC_URL}/api/v1/auth/oidc/callback`

## Required secrets / env

| Variable | Where | Notes |
| --- | --- | --- |
| `HEIMDALL_SESSION_SECRET` | Hub | ≥32 chars; iron-session cookie key. **Required in production** (hub fails closed without it) |
| `HEIMDALL_SECRET_KEY` | Hub | 32-byte AES-256-GCM key (hex or base64) that encrypts TOTP secrets, OIDC client secrets and alert/SCM credentials at rest. **Required with Postgres or `NODE_ENV=production`** (hub refuses to start without it); PGlite dev mode auto-creates `$HEIMDALL_DATA_DIR/secret.key` (0600). Generate: `openssl rand -hex 32`. **Back it up**: losing it means every stored secret must be re-entered (admins can still sign in; MFA falls back to recovery codes). Helm generates and keeps one for you (see below). |
| `HEIMDALL_COOKIE_SECURE` | Hub | Optional `true`/`false` override; otherwise derived from `HEIMDALL_PUBLIC_URL` (`http://` → non-Secure so Compose wizard sessions work) |
| `HEIMDALL_ALERTS_PAUSED` | Hub | `true`/`1` kills all outbound SMTP/Slack/Discord/SMS (lab emergency stop); also `POST /api/v1/alerts/pause` |
| `HEIMDALL_BOOTSTRAP_TOKEN` | Hub + agents | First-agent / bootstrap register **and** legacy ingest (Bearer). **Required everywhere: no shipped default** (Compose and Helm refuse to start/render without it; the dev token needs `HEIMDALL_DEV=1`, never in production). Generate with `openssl rand -hex 32`. In Helm prefer `hub.existingSecret.name` (key `bootstrap-token`) over a plaintext value. |
| `HEIMDALL_ORG_ID` | Hub | Optional pin: bootstrap-token register attaches agents to this org id (otherwise prefers an org that already has admin users) |
| `DATABASE_URL` | Hub | `postgres://…` (omit for PGlite/dev) |
| `HEIMDALL_PUBLIC_URL` | Hub | Canonical public origin (OIDC + WebAuthn); use `https://` in production so session cookies are Secure |
| `HEIMDALL_RP_ID` / `HEIMDALL_ORIGIN` | Hub | Passkey relying party |

### Request protection (rate limits, body caps, CSRF)

Rate limits are in-memory, per hub process (a restart or extra replica resets/splits the counters). Exceeded limits return `429` with `Retry-After`; oversized bodies return `413`.

| Variable | Default | Notes |
|----------|---------|-------|
| `HEIMDALL_TRUST_PROXY` | unset | Honour `X-Forwarded-For` for client IP. `true` = 1 trusted hop, or a number N. **Leave unset when the hub is directly exposed** (the header is spoofable); behind a reverse proxy without it, all clients share one IP bucket. |
| `HEIMDALL_RATE_LOGIN` | `10/900` | `max/windowSeconds`, key `ip + email`, failed attempts only (success clears) |
| `HEIMDALL_RATE_MFA` | `5/300` | MFA verify (TOTP and recovery), key = user, failures only |
| `HEIMDALL_RATE_INGEST` | `600/60` | Agent ingest + OTLP, key = hash of presented token (else IP) |
| `HEIMDALL_RATE_REGISTER` | `30/60` | Agent register |
| `HEIMDALL_RATE_WEBHOOK` | `120/60` | UniFi / runtime webhooks |
| `HEIMDALL_MAX_BODY_INGEST` | route default | Bytes. Defaults: 1 MB agent metrics, 2 MB agent logs, 10 MB agent vulns, 4 MB OTLP, 64 KB heartbeat |
| `HEIMDALL_MAX_BODY_REGISTER` | 64 KB | Bytes |
| `HEIMDALL_MAX_BODY_WEBHOOK` | 1 MB | Bytes |

Setting `HEIMDALL_MAX_BODY_INGEST` replaces the default for **all** ingest routes. Rate vars are `max/windowSeconds`; invalid values fall back to the default.

CSRF: session-cookie `POST/PUT/PATCH/DELETE` routes reject cross-origin browser requests (`Origin` / `Sec-Fetch-Site`) with `403`. Expected origin is `HEIMDALL_PUBLIC_URL` (else the request `Host`), so set it correctly behind a proxy. Exempt (token-auth, no cookies): `agents/{register,heartbeat,metrics,logs,vulns}`, both integration webhooks, OTLP `/v1/metrics` and `/v1/logs`.


Never commit production secrets. Default Compose values are for local smoke only.

## Docker Compose

```bash
cd deploy/docker
docker compose up --build
```

- Hub: http://127.0.0.1:43123  
- Postgres: host port `54329`  
- One sample agent registers as `compose-agent-01`

Complete the first-run wizard (admin → channels → remotes → MFA → agent token). Optional: mount Docker socket on the agent for container metrics.

## Helm

```bash
helm template heimdall deploy/helm/heimdall \
  --set hub.env.HEIMDALL_SESSION_SECRET=change-me-to-32chars-minimum!! \
  --set-string hub.env.HEIMDALL_BOOTSTRAP_TOKEN="$(openssl rand -hex 32)" \
  --set hub.env.HEIMDALL_PUBLIC_URL=https://heimdall.example.com

helm upgrade --install heimdall deploy/helm/heimdall -n heimdall --create-namespace \
  --set hub.env.HEIMDALL_SESSION_SECRET=… \
  --set hub.env.HEIMDALL_BOOTSTRAP_TOKEN=… \
  --set hub.env.HEIMDALL_PUBLIC_URL=https://heimdall.example.com \
  --set agent.clusterId=prod-a
```

Set a distinct `agent.clusterId` per cluster Deployment. Activate the cluster in **Dashboard → Clusters** after agents report in.

### Day-2 deploy on a single-node k3s server

After the first migrate (`scripts/migrate-compose-to-k8s.sh`), use **`scripts/deploy-cluster.sh`** on the server to pull `main`, rebuild hub/agent into the local image store, helm upgrade (with host mounts), and rollout:

```bash
# from your clone of the repository
./scripts/deploy-cluster.sh
```

Useful variants:

```bash
# Chart / values only (no docker build):
SKIP_IMAGE_BUILD=1 ./scripts/deploy-cluster.sh

# Already pulled; just rebuild + apply:
SKIP_GIT_PULL=1 ./scripts/deploy-cluster.sh images helm restart verify

# Status dump:
./scripts/deploy-cluster.sh status
```

Host mounts overlay: [`deploy/helm/heimdall/values-host-mounts.yaml`](../deploy/helm/heimdall/values-host-mounts.yaml) (applied by default; `SKIP_HOST_MOUNTS=1` to omit).

**Notes**
- If `SKIP_IMAGE_BUILD=1` or `SKIP_IMAGE_IMPORT=1` is set in your shell, image rebuild is skipped — unset them for hub/agent code updates.
- Builds pass `--build-arg CACHEBUST=$(git rev-parse HEAD)` and tag images as `heimdall-hub:<gitsha>` / `heimdall-agent:<gitsha>` (not only `:latest`) so k3s `IfNotPresent` cannot keep a stale hub.
- If `deploy-cluster.sh` itself changes during `git pull`, the script re-execs so you are not running stale bash functions against new Dockerfiles. If a deploy log looks stale, run the script once more.
- Tagging uses `docker image inspect heimdall-hub:latest` (not `compose images -q | head -1`, which can repoint `:latest` at an older image and keep the same k3s import digest).
- Full wipe of layer cache: `FORCE_NO_CACHE=1 ./scripts/deploy-cluster.sh`.
- The agent image is **distroless** (no `printenv` / shell). Confirm mounts with:
  `kubectl -n heimdall get deploy heimdall-agent -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="HEIMDALL_WATCH_MOUNTS")].value}{"\n"}'`

### In-cluster agent host disk mounts

By default (`agent.hostMounts.enabled: true`) the agent Deployment bind-mounts the **host** root at `/host` (readOnly) and sets `HEIMDALL_WATCH_MOUNTS=/host,/host/var` so disk samples reflect host filesystems, not the container overlay. `/boot` is intentionally omitted. Nested mounts (e.g. a separate host `/var`) show under `/host/…` via `mountPropagation: HostToContainer`.

Disable on clusters that disallow hostPath:

```bash
helm upgrade --reuse-values heimdall deploy/helm/heimdall -n heimdall \
  --set agent.hostMounts.enabled=false
```

Pick up the default host mounts on an existing release (no full re-migrate).
`watchMounts` is a **YAML list** (joined to `HEIMDALL_WATCH_MOUNTS`). Do **not** pass
`/host,/host/var` to `--set` / `--set-string` — Helm still splits on commas
(`key "/host/var" has no value`).

Prefer the checked-in overlay (or copy it):

```bash
helm upgrade --reuse-values heimdall deploy/helm/heimdall -n heimdall \
  -f deploy/helm/heimdall/values-host-mounts.yaml
```

Or indexed `--set` (defaults already match; only needed to override):

```bash
helm upgrade --reuse-values heimdall deploy/helm/heimdall -n heimdall \
  --set agent.hostMounts.enabled=true \
  --set 'agent.hostMounts.watchMounts[0]=/host' \
  --set 'agent.hostMounts.watchMounts[1]=/host/var'
```

Chart defaults alone are enough if you only need the stock `/host` + `/host/var` list:

```bash
helm upgrade --reuse-values heimdall deploy/helm/heimdall -n heimdall \
  --set agent.hostMounts.enabled=true
```

CI uses `helm template` (no live cluster required). Prefer `helm lint` + template before apply.

### Compose → Kubernetes cutover

If you already run Compose and want the full Helm stack (in-cluster agent + cluster Postgres), use the migration script and guide:

- Script: [`scripts/migrate-compose-to-k8s.sh`](../scripts/migrate-compose-to-k8s.sh)
- Guide: [migrate-compose-to-k8s.md](migrate-compose-to-k8s.md)

## Multi-cluster

1. Deploy one in-cluster agent per Kubernetes cluster with a unique `cluster_id`.
2. Register/activate clusters in the hub UI (`/dashboard/clusters`).
3. Fleet K8s summary follows the **active** cluster; all cluster snapshots remain queryable.

## N Git remotes

Wizard collects the first GitHub org + GitLab project. Add more anytime under **Dashboard → Remotes** (`POST /api/v1/security/connections`). Security sync walks every enabled connection.

## OIDC (BYO IdP)

1. Admin → **Identity & backup** (`/dashboard/admin`): add issuer, client id/secret, scopes.
2. Register redirect URI `{public}/api/v1/auth/oidc/callback` on the IdP.
3. Login page lists enabled providers. New SSO users land as `viewer` (link existing email to reuse an account).
4. Local password + MFA remain available; admins with MFA enrolled still verify TOTP after SSO.

## Backup / restore

- Export: `GET /api/v1/admin/backup` (default redacts tokens/secrets; `?includeSecrets=1` for a sealed offline copy).
- Restore: `POST /api/v1/admin/backup` with `{ "backup": { … } }` — upserts clusters, channels, rules, remotes, OIDC providers. User password hashes are **not** restored from the inventory list.
- UI: Admin → Backup / restore panel.

## Smoke check

```bash
./scripts/handshake-smoke.sh
curl -s http://127.0.0.1:43123/api/v1/health   # {"status":"ok","service":"heimdall-hub",…}
```

## Agent authentication

Agents register with a body `token`, then must send the **same** token on heartbeat / metrics / logs / vulns as:

`Authorization: Bearer <token>` (or `X-Heimdall-Token: <token>`).

Upgrade hub and agent together. Wizard install snippets already set `HEIMDALL_BOOTSTRAP_TOKEN` on the agent process.

`GET /api/v1/agents` requires a logged-in session (`agents:read`) and returns only the caller’s org.

See [`security-review.md`](security-review.md) for the threat model and dispositions.

## Operations checklist

- [ ] Set unique `HEIMDALL_SESSION_SECRET` (≥32 chars) and `HEIMDALL_BOOTSTRAP_TOKEN` (production refuses defaults)
- [ ] Persist Postgres volume / managed DB
- [ ] Set `HEIMDALL_PUBLIC_URL` before enabling OIDC or passkeys
- [ ] Export a redacted backup after wizard + remotes setup
- [ ] Pin hub/agent image digests in production
- [ ] Upgrade agents when hub enables Bearer ingest auth

### Agent state (per-agent secret)

After registering, each agent stores its secret in `HEIMDALL_STATE_DIR` (default `/var/lib/heimdall`, else `~/.heimdall`; file `agent-secret`, mode 0600). **The directory must persist across restarts**: if the secret is lost the hub answers `409 hostname_in_use` until an admin clicks **Re-enroll** on that host. Helm provisions a 16Mi PVC (`agent.state.persistence.*`) and Compose uses named volumes; for systemd/bare-metal installs the default path works as root.

Existing agents upgrade themselves: on their next restart they register, the hub adopts the existing host row and mints a secret. Until then shared tokens keep working (with a `legacy token` badge); set `HEIMDALL_LEGACY_TOKENS=off` on the hub once every agent has a secret.

`helm upgrade --reuse-values` keeps the token already in your release; the chart only requires a token on fresh installs.

### Secrets at rest and `HEIMDALL_SECRET_KEY`

Secrets (TOTP secret and pending enrolment, OIDC client secret, alert-channel and security-connection credentials) are stored as `enc:v1:` ciphertext. On startup the hub re-writes any legacy plaintext rows encrypted (idempotent). A secret that cannot be decrypted (wrong key, tampered) is treated as unset and an error is logged — nothing falls back to plaintext — so re-enter it in the UI.

- **Compose:** put `HEIMDALL_SECRET_KEY=$(openssl rand -hex 32)` in `deploy/docker/.env` (compose refuses to start without it).
- **Helm:** by default the chart generates `<release>-hub-secret-key` on first install and reuses it on every `helm upgrade` (`helm.sh/resource-policy: keep`, so it survives uninstall). Back it up: `kubectl -n heimdall get secret heimdall-hub-secret-key -o jsonpath='{.data.key}' | base64 -d`. Bring your own with `hub.secretKey.existingSecret` (key name `hub.secretKey.key`, default `key`) or `hub.env.HEIMDALL_SECRET_KEY`. GitOps tools that only run `helm template` cannot look the Secret up and would mint a new key each render, so use `existingSecret` there.
- **Backups:** the admin backup export is redacted by default; with secrets included it contains **plaintext** values (treat the file as a secret). Restore re-encrypts under the target hub's key, so you can restore onto a hub with a different key.
- **Rotating the key:** not automatic. Export a backup with secrets, deploy a fresh hub with the new key, restore.

### Outbound requests and `HEIMDALL_ALLOW_PRIVATE_HOSTS`

Every request the hub makes to an admin-configured URL — OIDC discovery/token/userinfo/JWKS, Slack/Discord/Twilio-compatible alert webhooks, GitHub and GitLab APIs — goes through an SSRF guard: only `http`/`https`, 10 s timeout, 2 MiB response cap, at most 3 redirects (each re-validated), and the connection is pinned to the validated IP (no DNS rebinding). Targets that resolve to loopback, link-local (including the `169.254.169.254` cloud-metadata address), RFC1918, ULA or unspecified addresses are refused with `blocked_host`.

The same check runs when you **save** an IdP issuer, webhook URL, SMS API base URL or GitHub/GitLab API base URL: the form shows the error and the hint instead of saving. A hostname that does not resolve yet is accepted at save time and re-checked on every request.

To reach something on your LAN (self-hosted GitLab, Keycloak, a local Slack-compatible relay), allow it on the hub:

| Variable | Example | Notes |
|----------|---------|-------|
| `HEIMDALL_ALLOW_PRIVATE_HOSTS` | `gitlab.lan,10.0.5.0/24,192.168.1.20` | Comma-separated hostnames, IPs and CIDRs. Leave unset unless you need it; allow the narrowest entry that works. |

Helm: `--set-string hub.extraEnv.HEIMDALL_ALLOW_PRIVATE_HOSTS=gitlab.lan` (`hub.extraEnv` passes any extra hub variable through, including `HEIMDALL_TRUST_PROXY`, `HEIMDALL_RATE_*` and `HEIMDALL_LEGACY_TOKENS`). Compose: add it under the hub `environment`.
