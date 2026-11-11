# Configuration reference

Heimdall is configured through environment variables. Settings stored in the database, such as thresholds, retention and integrations, are changed in the console and listed in the [features tour](../user-guide/features.md#settings-dashboardsettings).

## Hub

### Required in production

| Variable | Description |
| --- | --- |
| `HEIMDALL_SESSION_SECRET` | Key for the sealed session cookie, at least 32 characters. When `NODE_ENV=production`, the hub refuses to start without it, or with a value that has appeared in a published file. Sessions last 12 hours and are re-checked against the database on every request; logout revokes them. |
| `HEIMDALL_SECRET_KEY` | 32-byte key (hex or base64) for AES-256-GCM encryption of stored secrets. Required with Postgres or in production. PGlite dev mode creates `$HEIMDALL_DATA_DIR/secret.key` automatically. **Back it up.** |
| `HEIMDALL_BOOTSTRAP_TOKEN` | Hub-wide token that agents can register with. No default is shipped. Can later be rotated to an `hdb_` value or disabled in the UI. |
| `HEIMDALL_PUBLIC_URL` | Canonical public origin, such as `https://heimdall.example.com`. Used for SSO callbacks, CSRF origin checks, the cookie `Secure` flag, the URL baked into `/install.sh`, and alert deep links. |
| `DATABASE_URL` | `postgres://user:pass@host:5432/db?sslmode=…`. If unset, the hub uses embedded PGlite (development only). |

### Identity and cookies

| Variable | Default | Description |
| --- | --- | --- |
| `HEIMDALL_RP_ID` | — | WebAuthn relying party ID (the hostname, such as `heimdall.example.com`) |
| `HEIMDALL_ORIGIN` | — | WebAuthn expected origin (`https://heimdall.example.com`) |
| `HEIMDALL_COOKIE_SECURE` | derived | `true` or `false`. Overrides the `Secure` cookie flag. Otherwise it is on for `https://` public URLs |
| `HEIMDALL_PUBLIC_BASE_URL` | `HEIMDALL_PUBLIC_URL` | Preferred base for links in alert messages |
| `HEIMDALL_ORG_ID` | auto | Pin bootstrap-token registrations and the read-only MCP to this org ID. By default, the org that has admin users is used |

### Read-only MCP

| Variable | Default | Description |
| --- | --- | --- |
| `HEIMDALL_MCP_TOKEN` | unset | Bearer for `POST /mcp`. Unset: only `localhost`, `127.0.0.1`, and `::1`. Generate with `openssl rand -hex 32`. Do not commit it. See [MCP exposure](../runbooks/mcp-exposure.md) |
| `HEIMDALL_MCP_ALLOWED_HOSTS` | unset | Comma-separated Host allowlist used when the token is set. List the LAN host and the public host. Empty allowlist accepts any Host |

### Agents and tokens

| Variable | Default | Description |
| --- | --- | --- |
| `HEIMDALL_LEGACY_TOKENS` | on | Set to `off` to reject agents that still authenticate with shared (non-per-agent) tokens |
| `HEIMDALL_ALLOW_INSECURE` | off | Agent and installers: accept a plain-http hub URL on a public host. Plain http on loopback, in-cluster names and private networks is accepted by the agent with a warning; the root installer always needs this opt-in for non-loopback http |
| `HEIMDALL_DEV` | unset | `1` accepts the well-known development token (see the README quick start) when no bootstrap token is set. Ignored when `NODE_ENV=production` |

### Alerts

| Variable | Default | Description |
| --- | --- | --- |
| `HEIMDALL_ALERTS_PAUSED` | `false` | `true` or `1` starts the hub with all outbound notifications paused |

### Request protection

Rate limits are per hub process and held in memory. Format: `max/windowSeconds`.

| Variable | Default | Applies to (key) |
| --- | --- | --- |
| `HEIMDALL_TRUST_PROXY` | unset | Honour `X-Forwarded-For`: `true` = 1 hop, or a number of hops. Only behind a proxy you control |
| `HEIMDALL_RATE_LOGIN` | `10/900` | Failed logins (IP + email) |
| `HEIMDALL_RATE_MFA` | `5/300` | Failed MFA verifications (user) |
| `HEIMDALL_RATE_INGEST` | `600/60` | Agent ingest and OTLP (token hash, else IP) |
| `HEIMDALL_RATE_REGISTER` | `30/60` | Agent registration |
| `HEIMDALL_RATE_WEBHOOK` | `120/60` | UniFi and runtime webhooks |
| `HEIMDALL_MAX_BODY_INGEST` | per route | Bytes. Route defaults: metrics 1 MB, logs 2 MB, vulns 10 MB, OTLP 4 MB, heartbeat 64 KB. Setting it overrides **all** ingest routes |
| `HEIMDALL_MAX_BODY_REGISTER` | 64 KB | Bytes |
| `HEIMDALL_MAX_BODY_WEBHOOK` | 1 MB | Bytes |

### Outbound requests

| Variable | Default | Description |
| --- | --- | --- |
| `HEIMDALL_ALLOW_PRIVATE_HOSTS` | unset | Comma-separated hostnames, IPs and CIDRs the hub may contact even though they resolve to private addresses (LAN IdP, GitLab, webhook relay) |

### Runtime and storage

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` / `HOSTNAME` | `43123` / `0.0.0.0` (image) | Listen address |
| `HEIMDALL_DB_DRIVER` | auto | `pglite` forces the embedded database |
| `HEIMDALL_DATA_DIR` | `./data` | PGlite data and the auto-generated dev secret key |
| `HEIMDALL_DIST_DIR` | `./dist` (`/app/dist` in the image) | Agent binaries and installers served at `/downloads` and `/install.sh` |
| `HEIMDALL_DISABLE_PURGE_JOB` | unset | `1` disables the 6-hourly retention purge |

## Agent

Command-line flags override environment variables. See the [agent CLI](agent-cli.md).

| Variable | Flag | Default | Description |
| --- | --- | --- | --- |
| `HEIMDALL_HUB_URL` | `--hub` | `http://127.0.0.1:43123` | Hub origin |
| `HEIMDALL_BOOTSTRAP_TOKEN` | `--token` | — (required) | Enrollment (`hdt_`) or bootstrap token, used to register |
| `HEIMDALL_HOSTNAME` | `--hostname` | OS hostname | Name shown in the console. Unique per org |
| `HEIMDALL_INTERVAL` | `--interval` | `10s` | Sample interval (Go duration, or a number of seconds) |
| `HEIMDALL_WATCH_MOUNTS` | `--watch-mounts` | `/,/boot,/var` | Mounts to report disk usage for. A missing one raises an alarm |
| `HEIMDALL_LOG_PATHS` | `--log-paths` | — | Files to tail and ship |
| `HEIMDALL_CLUSTER_ID` | `--cluster-id` | `default` | Cluster this agent belongs to |
| `HEIMDALL_ENABLE_K8S` | `--enable-k8s` | `false` | Collect Kubernetes health |
| `KUBECONFIG` / `HEIMDALL_KUBECONFIG` | — | in-cluster | Kubeconfig for K8s collection outside a pod |
| `HEIMDALL_STATE_DIR` | — | `/var/lib/heimdall`, else `~/.heimdall` | Holds `agent-secret` (mode 0600). **Must persist** |
| `DOCKER_HOST_SOCKET` | — | `/var/run/docker.sock` | Docker Engine API socket |
| `PODMAN_SOCKET` | — | `/run/podman/podman.sock` | Podman socket (also tried: `$XDG_RUNTIME_DIR/podman/podman.sock`) |
| `HEIMDALL_HOST_POSTURE` | — | off | `1` runs scheduled Trivy rootfs scans |
| `HEIMDALL_HOST_POSTURE_INTERVAL` | — | `24h` | Time between posture scans |
| `HEIMDALL_HOST_ROOT` | `--root` | `/host` if it exists, else `/` | Filesystem root to scan |
| `HEIMDALL_TRIVY_BIN` | — | `trivy` | Trivy binary |
| `HEIMDALL_TRIVY_TIMEOUT` | — | `10m` | Scan timeout |

Installed agents read these from `/etc/heimdall/agent.env`. Restart with `systemctl restart heimdall-agent` after editing.

## Installer (`/install.sh`, `install-agent.sh`, `install-otelcol.sh`)

| Variable | Description |
| --- | --- |
| `HUB_URL` | Hub origin (baked into `/install.sh`) |
| `TOKEN_FILE` / `TOKEN` | Agent enrollment token. Prompted for if unset |
| `OTEL=1`, `OTEL_TOKEN_FILE` / `OTEL_TOKEN` | Also install the OTel collector with this `hdo_` token |
| `HOSTNAME_VALUE`, `CLUSTER_ID`, `ENABLE_K8S`, `LOG_PATHS` | Written to `agent.env` |
| `LOG_UNITS` | journald units for the collector (`sshd.service,nginx.service`) |
| `AGENT_ID` | Bind OTel data to this agent (`heimdall.agent_id`) |
| `OTELCOL_BIN`, `OTELCOL_VERSION`, `OTELCOL_DOWNLOAD_BASE` | Use a local collector binary, pin its version (default `0.111.0`), or download from a mirror |
| `DOCKER=0` | Do not add the agent user to the `docker` group |
| `DRY_RUN=1` | Print what would happen, change nothing |
| `--uninstall`, `PURGE=1` | Remove, and also delete state |

## Helm values

Main keys of `deploy/helm/heimdall/values.yaml`:

| Key | Default | Description |
| --- | --- | --- |
| `image.hub`, `image.agent` | `heimdall/hub:0.0.1`, `heimdall/agent:0.0.1` | Full image references |
| `image.pullPolicy` | `IfNotPresent` | |
| `hub.replicaCount` | `1` | More than one replica splits rate-limit counters and the WebAuthn challenge store |
| `hub.env.*` | see file | Hub environment (`HEIMDALL_PUBLIC_URL`, `HEIMDALL_SESSION_SECRET`, …) |
| `hub.extraEnv` | `{}` | Any other hub variables |
| `hub.existingSecret.name` / `.key` | `""` / `bootstrap-token` | Bootstrap token from a Secret (preferred) |
| `hub.secretKey.existingSecret` / `.key` | `""` / `key` | Bring your own `HEIMDALL_SECRET_KEY`. Otherwise the chart creates and keeps `<release>-hub-secret-key` |
| `hub.service.type` / `.port` | `ClusterIP` / `43123` | |
| `agent.enabled` | `true` | In-cluster agent |
| `agent.hostname`, `agent.clusterId` | `helm-agent-01`, `default` | |
| `agent.enableK8s` | `"true"` | |
| `agent.rbac.create` | `true` | ClusterRole for nodes, pods, deployments, services, namespaces, NetworkPolicies |
| `agent.state.persistence.*` | enabled, `16Mi` | PVC for the agent secret |
| `agent.hostMounts.enabled` | `false` | Mount host `/` read-only at `/host` (`values-host-mounts.yaml` turns it on) |
| `agent.hostMounts.watchMounts` | `[/host, /host/var]` | YAML list |
| `postgres.enabled` | `true` | Bundled Postgres 16 |
| `postgres.persistence.*` | enabled, `2Gi` | PVC (kept on uninstall) |
| `postgres.auth.*` | `heimdall`/`heimdall`/`heimdall` | Change the password for anything shared |
| `postgres.appArmorProfile` | `""` | `Unconfined` on hosts where AppArmor blocks Postgres signals |
| `otel.collector.enabled` | `false` | Deploy an OTel collector |
| `otel.collector.mode` | `daemonset` | `daemonset` (metrics, pod logs, traces) or `sidecar` (metrics only) |
| `otel.collector.endpoint` | in-cluster hub | External hub origin |
| `otel.collector.existingSecret.name` / `.token` | | `hdo_` token source |
| `otel.collector.logs`, `.traces` | `true`, `true` | DaemonSet pipelines |
| `otel.beyla.enabled` | `false` | eBPF auto-instrumentation (privileged, kernel 5.8+ with BTF) |
| `otel.beyla.namespaces` / `excludeNamespaces` | `["*"]` / `[]` | What to instrument |
