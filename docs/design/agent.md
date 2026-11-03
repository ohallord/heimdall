# Agent design

`heimdall-agent` is one static Go binary (`CGO_ENABLED=0`, `-trimpath`) for linux/amd64 and linux/arm64. The container image is `gcr.io/distroless/static-debian12:nonroot`: it has no shell and no Trivy.

Source: `apps/agent`

| Package | Role |
| --- | --- |
| `cmd/agent` | CLI, run loop, wiring |
| `internal/config` | Flag and environment resolution |
| `internal/handshake` | Hub HTTP client: register, heartbeat, metrics, logs, vulns |
| `internal/state` | Per-agent secret persistence |
| `internal/collect` | CPU, memory, load, filesystems, mounts (reads `/proc` and `statfs`) |
| `internal/containers` | Docker Engine API over a unix socket (Docker and Podman) |
| `internal/k8s` | client-go readers for nodes, pods, deployments, services, NetworkPolicies |
| `internal/logs` | File tailing by byte offset |
| `internal/vulns` | Trivy invocation and report parsing |

## Design principles

- **Outbound only.** Every exchange is an HTTP request from agent to hub. There is no listening port.
- **Degrade, do not die.** A missing container socket, Kubernetes access, or Trivy each disables that collector with a log line. Host metrics always flow.
- **One binary, many roles.** Collectors switch on based on the environment, not separate builds.
- **No secrets on argv.** Tokens come from environment files. The installer prompts for them or reads them from a file.

## Run loop

```
start
 ├─ load config (flags > env > defaults); token required
 ├─ open state dir; read agent-secret if present        (unreadable → exit 1)
 ├─ register(token, hostname, version, agentSecret?)    (failure → exit 1; systemd restarts)
 ├─ [HEIMDALL_HOST_POSTURE] initial trivy rootfs scan   (missing trivy → skip)
 ├─ collect + POST metrics; tail + POST logs
 └─ every interval (default 10s):
      ├─ collect host (+ containers if socket) (+ k8s if enabled)
      ├─ POST /api/v1/agents/metrics       ── on 401: re-register with stored secret
      ├─ tail LOG_PATHS → POST /api/v1/agents/logs
      └─ when posture interval elapsed → scan → POST /api/v1/agents/vulns
```

Collection is synchronous within a tick. A slow Kubernetes API or Docker daemon delays that tick's sample, but does not overlap ticks.

## Identity and registration

The hub identifies an agent by `(org, hostname)`. Credentials:

| Credential | Lifetime | Purpose |
| --- | --- | --- |
| Enrollment token `hdt_` | TTL + max uses, revocable | Lets an unknown host create its agent row once |
| Bootstrap token (env, or rotated `hdb_`) | Until rotated or disabled | Same as enrollment, hub-wide, no use limit |
| Agent secret `hda_` | Until revoke or re-enroll | Proves "I am this agent" on every call |

Registration on the hub (`registerAgentPersistent`):

1. If the request presents a stored **agent secret** that matches an agent row, that agent is the caller, even if the enrollment token has since expired or been revoked. A revoked agent gets `403 agent_revoked`.
2. Otherwise the **token** must be a valid enrollment or bootstrap token, or `401`.
3. If a row already exists for the hostname **and has a secret** the caller does not hold → `409 hostname_in_use`. This stops anyone with a shared token from taking over an existing host's identity (security finding F12).
4. For a new host, or an old row that has no secret yet, one enrollment use is consumed (atomically, honouring `max_uses`), a fresh `hda_` secret is minted, and only its SHA-256 is stored.

The agent writes the secret atomically (temporary file, then rename, mode 0600) to `$HEIMDALL_STATE_DIR/agent-secret` **before** using it. Losing that file is the main operational hazard. The fix is **Re-enroll** in the UI, which clears the stored secret hash so the next registration with a valid token succeeds.

Agents from releases before per-agent secrets, which ingest with the shared token, still work (marked "legacy token") until `HEIMDALL_LEGACY_TOKENS=off`.

## Collectors

### Host
- CPU % from `/proc/stat` deltas, memory from `/proc/meminfo`, and load averages.
- For each path in `HEIMDALL_WATCH_MOUNTS` (default `/,/boot,/var`): whether it is a mount point, and its usage from `statfs`. A configured path that is not mounted is reported as missing, and the hub turns that into a `mount_missing:<path>` alarm.
- In Kubernetes, the host root is bind-mounted read-only at `/host`, and the agent watches `/host` and `/host/var`, so numbers reflect the node and not the container overlay.

### Containers
- Runtime detection tries `DOCKER_HOST_SOCKET`, `PODMAN_SOCKET`, then rootless Podman. The first existing socket wins. Podman is used through its Docker-compatible API.
- `GET /containers/json?all=1`, inspect each container (state, exit code, OOMKilled, restart count), and one-shot stats for running containers (CPU %, memory against the cgroup limit).
- Reported as `containerRuntime` (`docker`, `podman`, `none`, `error`) plus the list. The hub decides which exits deserve an alarm by comparing with the previous snapshot: only containers that **stop abnormally while monitored** alarm.

### Kubernetes
- Enabled by `HEIMDALL_ENABLE_K8S=true`. In-cluster config first, then `KUBECONFIG` or `HEIMDALL_KUBECONFIG`.
- Summary: API reachability, nodes ready/total, pods pending and crash-looping (with a capped problem list), unhealthy deployments, exposed Services (NodePort, LoadBalancer, ExternalIP), and namespaces with and without NetworkPolicies.
- RBAC is read-only (list/get). A missing permission empties that section without failing the sample.

### Logs
- `HEIMDALL_LOG_PATHS` are polled once per tick. Up to 200 new lines per file per tick are read from the last byte offset.
- If a file shrinks (rotation or truncation), its offset resets to 0.
- Offsets live in memory. After a restart the file is read again from the start, so lines can be ingested twice. The OTel filelog and journald receivers keep durable cursors and suit high-value logs better.

### Vulnerabilities
- `trivy image --format json` for `scan-image`, and `trivy rootfs --scanners vuln,misconfig` for posture. Configurable binary and timeout.
- Reports are posted to `/api/v1/agents/vulns` with `scanKind` so the hub can tell image findings from host findings.

## Failure behaviour

| Failure | Behaviour |
| --- | --- |
| Hub unreachable | Logs the error, retries next tick, no local buffering (samples in the gap are lost) |
| `401` on ingest | Re-register with stored secret, continue |
| `403 agent_revoked` / `409 hostname_in_use` at start | Exit non-zero, and systemd keeps restarting until an admin re-enrolls |
| Docker or Kubernetes errors | Warning logged, that section is omitted or marked `error` |
| Trivy missing or slow | Scan skipped or timed out, metrics unaffected |

## Versioning

`main.version` is set at build time (`-X main.version=…`): the git short SHA from `build-dist.sh` and `deploy-cluster.sh`, `dev` otherwise. It is sent at registration and stored on the agent row. Agents do not update themselves. Re-running the installer upgrades them.

## Possible future work

- Durable log offsets in the state directory.
- A small on-disk buffer for samples while the hub is unreachable.
- Self-update driven by the hub's `SHA256SUMS` manifest.
