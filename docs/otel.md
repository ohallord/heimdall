# OpenTelemetry metrics, logs & traces (Phases 14 / 23 / 29)

Heimdall accepts **OTLP/HTTP JSON**:

| Signal | Path | Storage |
| --- | --- | --- |
| Metrics | `/v1/metrics` | `otel_metric_samples` (+ optional host CPU/mem mirror) |
| Logs | `/v1/logs` | `log_events` (same search / rule pack as agent file-tail) |
| Traces | `/v1/traces` | `otel_spans` (Phase 29); shown on **Services** and the trace waterfall (Phase 30) |

Point an OpenTelemetry Collector at the hub. Metric samples show as raw points on **Network**; named services (`service.name`) aggregate on **Services**. Log lines appear under **Dashboard → Logs** and run the hub log threat rules.

**Not included:** gRPC to the hub (collectors accept gRPC from apps), gzip, binary protobuf, histogram quantiles, service-map topology.

## Mint an ingest token

1. Admin → **Settings → Integrations → OTLP metrics & logs**
2. **Rotate OTEL token** → copy `hdo_…` once
3. Endpoints: `https://<your-hub>/v1/metrics`, `/v1/logs` and `/v1/traces`

Auth header: `Authorization: Bearer <token>` (or `X-Heimdall-Token`). One token covers all three signals.

## Collector configs

Shipped under `deploy/otel/`:

| File | Use |
| --- | --- |
| `collector-baremetal.yaml` | Hostmetrics + journald/filelog on a VM / bare metal |
| `collector-docker-compose.yaml` | Compose sidecar / hostmetrics on Docker host (metrics) |
| `collector-k8s.yaml` | DaemonSet-style hostmetrics on nodes (metrics) |
| Helm chart (`otel.collector.enabled=true`) | DaemonSet (hostmetrics + pod logs) or agent-pod sidecar (hostmetrics only); see below |

Baremetal config sets:

```yaml
exporters:
  otlphttp/heimdall:
    endpoint: ${env:HEIMDALL_OTLP_ENDPOINT}  # e.g. https://hub.example.com
    encoding: json
    headers:
      Authorization: "Bearer ${env:HEIMDALL_OTEL_TOKEN}"
```

With `endpoint` as the hub **origin** (no path suffix), the exporter appends `/v1/metrics` and `/v1/logs` per pipeline.

### Baremetal logs

- **journald** — primary; set `units` allow-list (empty = all units, high volume)
- **filelog** — optional `include` globs for apps that log to files

`scripts/install-otelcol.sh` (and `install-baremetal.sh`) can template `LOG_UNITS` / `LOG_PATHS` into the installed config.

## Resource attribute for agent binding

To update Heimdall agent host metrics from OTEL **and** bind OTEL logs to that agent:

```yaml
processors:
  resource:
    attributes:
      - key: heimdall.agent_id
        value: agt_…
        action: upsert
```

Or set `HEIMDALL_AGENT_ID` / `AGENT_ID=…` when using `install-baremetal.sh` (uncomments the env-based attribute).

Mapped metric names:

| OTEL metric | Heimdall |
| --- | --- |
| `system.cpu.utilization` (0–1 or %) | `cpu_percent` |
| `system.memory.utilization` | `mem_percent` |

Log `source` preference: `_SYSTEMD_UNIT` / `systemd.unit` → `service.name` → `log.file.path` → `otel`.

## Install (one command per target, Phase 28)

**Simplest (Phase 31):** `curl -fsSL https://<hub>/install.sh | sudo OTEL=1 bash` installs agent + collector, downloading both installers from the hub (see [deploy.md](deploy.md#one-command-host-install-phase-31)). The per-target scripts below remain for collector-only, Docker and Kubernetes installs.

Save the `hdo_…` token to a file (keeps it out of shell history); every script also accepts `OTEL_TOKEN`.
Pass variables with `sudo env VAR=… script`. sudo resets the environment, and sudo-rs (newer Ubuntu) has no environment-preserving `-E` flag.

```bash
umask 077; printf '%s\n' 'hdo_…' > ~/hdo.txt
```

### Linux systemd host (collector only)

```bash
sudo env HUB_URL=https://hub.example.com OTEL_TOKEN_FILE=$HOME/hdo.txt \
  LOG_UNITS=sshd.service,nginx.service AGENT_ID=agt_… \
  ./scripts/install-otelcol.sh
```

- Downloads `otelcol-contrib` `OTELCOL_VERSION` (default `0.111.0`, same as Helm) for amd64/arm64 from GitHub releases and checks its sha256 against the release checksums file. A mismatch installs nothing.
- Offline: `OTELCOL_BIN=/path/to/otelcol-contrib` skips the download. Mirror: `OTELCOL_DOWNLOAD_BASE`.
- Writes `/etc/heimdall/otel-collector.yaml` (0644), `/etc/heimdall/otel.env` (0600), and `heimdall-otelcol.service`, then enables and restarts it. Re-running replaces everything.
- `DRY_RUN=1` previews (token masked). `--uninstall` removes unit, binary, config, and env.

### Agent + collector together

```bash
HUB_URL=https://hub.example.com TOKEN=hdt_… OTEL_TOKEN_FILE=~/hdo.txt ./scripts/install-baremetal.sh
```

`install-baremetal.sh` runs `install-agent.sh` and then `install-otelcol.sh`, so it takes the same options (`LOG_UNITS`, `LOG_PATHS`, `AGENT_ID`, `OTELCOL_BIN`, `DRY_RUN=1`).

### Docker host

```bash
sudo env HUB_URL=https://hub.example.com OTEL_TOKEN_FILE=$HOME/hdo.txt ./scripts/install-otelcol-docker.sh
```

Runs `otel/opentelemetry-collector-contrib:0.111.0` as `heimdall-otelcol` (`--restart unless-stopped`) with `collector-docker-compose.yaml` mounted read-only, host `/` at `/hostfs:ro`, and the Docker socket for `docker_stats`. `HUB_URL` must be reachable from inside the container. Supports `DRY_RUN=1` and `--uninstall`.

### Kubernetes (existing Helm release)

```bash
OTEL_TOKEN_FILE=~/hdo.txt ./scripts/install-otel-k8s.sh            # DaemonSet, pod logs on
OTEL_TOKEN_FILE=~/hdo.txt MODE=sidecar ./scripts/install-otel-k8s.sh
OTEL_TOKEN_FILE=~/hdo.txt LOGS=false ENDPOINT=https://hub.example.com ./scripts/install-otel-k8s.sh
```

Creates or updates Secret `heimdall-otel` (key `otel-token`) through `kubectl apply -f -`, so the token never appears in helm or kubectl arguments. It then runs `helm upgrade --reset-then-reuse-values` (on older Helm, it passes prior values with `-f`) and waits for the rollout. With `deploy-cluster.sh`, add `OTEL_COLLECTOR=1` to do this after the `helm` step.

Tests: `scripts/test-install-otelcol.sh`, `scripts/test-install-otel-k8s.sh` (CI).

Manual collector only:

```bash
export HEIMDALL_OTLP_ENDPOINT=https://hub.example.com
export HEIMDALL_OTEL_TOKEN=hdo_…

otelcol-contrib --config deploy/otel/collector-baremetal.yaml
```

systemd unit: [`deploy/systemd/heimdall-otelcol.service`](../deploy/systemd/heimdall-otelcol.service).

## Verify

1. Agent + collector running without export errors
2. **Dashboard → Network → Recent OTEL points** shows metric names
3. **Dashboard → Logs** shows journal/file lines from the host
4. With `service.name` set, **Dashboard → Services** lists the service (metrics)
- Traces: `curl` a sample export (see `docs/phases/phase-29-apm-traces/README.md`) and expect `{"accepted":N}`; rows land in `otel_spans`
- Then **Dashboard → Services** lists the service with a `traces` tag (Rate / Errors / p50 / p95); open it for operations and filtered traces, and click a trace for the span waterfall (Phase 30)
5. With `heimdall.agent_id`, host detail CPU/memory updates and log rows bind to that agent

## Traces (Phase 29)

Every collector config (baremetal, Docker, Helm daemonset) runs an `otlp` receiver and a `traces` pipeline that forwards spans to `/v1/traces`. Point app SDKs at the local collector, not the hub:

| Target | App env |
| --- | --- |
| systemd host / Docker host | `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` (grpc: `:4317`) |
| Kubernetes (Helm daemonset) | `OTEL_EXPORTER_OTLP_ENDPOINT=http://heimdall-otelcol.<ns>:4318` (Service uses `internalTrafficPolicy: Local`, so each pod hits its own node) |

Also set `OTEL_SERVICE_NAME`; spans without `service.name` are stored as `unknown_service`. The traces pipeline skips the `resource` processor so app service names are kept. Disable on Helm with `otel.collector.traces=false`; sidecar mode never receives traces.

Storage: one row per span in `otel_spans`, unique on `(org, trace_id, span_id)`, so collector retries do not duplicate. Hex or base64 ids are accepted and stored as lowercase hex.

## Limits

- Max **500** metric points or log records per request
- Max **1000** spans per request; extras are dropped and reported as `partialSuccess.rejectedSpans`
- Traces retention: **Settings → Metric history retention → Trace days** (default 7d, clamp 1–60d)
- Metrics retention follows org metrics retention (default 60d since Phase 25; clamp 30–365d)
- Protobuf Content-Type → **415**; use `encoding: json`
- Agent file-tail (`HEIMDALL_LOG_PATHS` → `/api/v1/agents/logs`) remains available alongside OTEL logs

## Kubernetes via Helm (Phase 27)

One command: `scripts/install-otel-k8s.sh` (see Install above). By hand:

```bash
kubectl -n heimdall create secret generic heimdall-otel --from-literal=otel-token=hdo_…
helm upgrade --install heimdall deploy/helm/heimdall \
  --set otel.collector.enabled=true \
  --set otel.collector.existingSecret.name=heimdall-otel
```

- `mode: daemonset` (default): one collector per node, hostmetrics from `/hostfs` and, with `otel.collector.logs=true`, container logs from `/var/log/pods` (read-only hostPath).
- `mode: sidecar`: collector container in the agent pod; hostmetrics only, no log tailing. Still mounts host `/` read-only.
- Endpoint defaults to the in-cluster hub Service; set `otel.collector.endpoint` for an external hub. Config changes need `kubectl rollout restart ds/heimdall-otelcol`.
- Verified by `scripts/test-helm-otel.sh` (runs in CI).

## eBPF auto-instrumentation for pods with no SDK (Phase 33)

Plex, Jellyfin, Emby, Syncthing and similar third-party images can't emit OTLP themselves. Grafana Beyla attaches eBPF probes from the node and emits HTTP/gRPC server and client spans for them, with `service.name` and `k8s.*` attributes taken from the pod.

```bash
helm upgrade heimdall deploy/helm/heimdall --reset-then-reuse-values \
  --set otel.beyla.enabled=true
```

- Requires `otel.collector.enabled=true` with `traces=true` in daemonset mode (the chart fails otherwise). Beyla sends OTLP/protobuf to the node-local collector Service, which forwards JSON to the hub.
- Needs kernel 5.8+ with BTF (`ls /sys/kernel/btf/vmlinux`). The DaemonSet is `privileged` with `hostPID`, so it must be allowed by your pod-security policy.
- `otel.beyla.namespaces` (default `["*"]`) and `excludeNamespaces` select what is traced. The hub and k8s system namespaces are always skipped.
- You get request-level spans (route, status, latency, outbound calls), not in-process function spans. Syncthing's sync protocol is not HTTP, so only its web/API traffic appears.
- Verify: **Dashboard → Services** lists the pods' deployments with a `traces` tag. `kubectl logs ds/heimdall-beyla` shows which processes were instrumented.
- Span volume from busy media servers is high. Lower `tracesRetentionDays` or narrow `namespaces` if the table grows too fast.
