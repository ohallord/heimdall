# Host posture

Scan a server’s root filesystem with Trivy and show OS package CVEs plus misconfigs in Heimdall as findings source **`host_posture`**.

Trivy is **optional** — the default distroless agent image does not include it. Without Trivy, metrics/containers/K8s still work; posture scans soft-skip.

## What you get

| Surface | Where |
| --- | --- |
| Per-host findings | Dashboard → Servers → host → **Security / Posture** |
| Org-wide filter | Dashboard → **Security** → **Host posture** (`?source=host_posture`) |
| One-shot scan | `heimdall-agent scan-host` or `./scripts/scan-host-posture.sh` |
| Scheduled scan | `HEIMDALL_HOST_POSTURE=1` on the agent (default every **24h**) |

Image scans (`scan-image`) stay source **`trivy`** and do **not** appear in the host Posture section.

## Prerequisites

1. Reachable hub + bootstrap/agent token
2. [Trivy](https://trivy.dev/) on the machine that runs the scan (`trivy` on `PATH`, or `HEIMDALL_TRIVY_BIN`)
3. Readable host root:
   - Bare metal / VM: usually `/`
   - Helm agent: host mounted at `/host` (`agent.hostMounts.enabled: true`)
   - Compose posture profile: host `/` → `/host`

Quick Trivy check:

```bash
trivy version
# or
HEIMDALL_TRIVY_BIN=/usr/local/bin/trivy trivy version
```

## Quick start (standalone)

From the repo root, with hub already up (e.g. Compose on `:43123`):

```bash
# Build agent if needed, verify Trivy, run one rootfs scan, ingest to hub
HUB_URL=http://127.0.0.1:43123 \
TOKEN=<enrollment-or-bootstrap-token> \
HOSTNAME_VALUE=lab-host-01 \
  ./scripts/scan-host-posture.sh
```

Then open the hub UI → that host → **Security / Posture**, or  
`/dashboard/security?source=host_posture`.

Equivalent manual commands:

```bash
cd apps/agent && go build -o bin/heimdall-agent ./cmd/agent && cd ../..

export HEIMDALL_HUB_URL=http://127.0.0.1:43123
export HEIMDALL_BOOTSTRAP_TOKEN=<enrollment-or-bootstrap-token>
# optional: export HEIMDALL_HOST_ROOT=/   or /host

./apps/agent/bin/heimdall-agent scan-host --hostname lab-host-01
# or:  scan-host --root /path/to/root
```

## Enable scheduled scans

Add to the agent environment (systemd `/etc/heimdall/agent.env`, Helm values, or Compose):

```bash
HEIMDALL_HOST_POSTURE=1
# optional:
# HEIMDALL_HOST_POSTURE_INTERVAL=24h
# HEIMDALL_HOST_ROOT=/host
# HEIMDALL_TRIVY_BIN=/usr/local/bin/trivy
# HEIMDALL_TRIVY_TIMEOUT=10m
```

On `run`, the agent scans once at start (if Trivy is present), then on the interval. Missing Trivy logs a skip and does not crash the agent.

### systemd (standalone)

After `./scripts/install-agent.sh`, edit `/etc/heimdall/agent.env`:

```bash
HEIMDALL_HOST_POSTURE=1
HEIMDALL_TRIVY_BIN=/usr/local/bin/trivy
```

```bash
sudo systemctl restart heimdall-agent
journalctl -u heimdall-agent -f   # look for "host posture"
```

### Helm

Keep host mounts enabled (default). Set agent env, e.g.:

```bash
helm upgrade --install heimdall ./deploy/helm/heimdall \
  --namespace heimdall --create-namespace \
  --set agent.env.HEIMDALL_HOST_POSTURE=1 \
  --set agent.env.HEIMDALL_HOST_ROOT=/host
```

Install Trivy **in the agent pod** (custom image / sidecar / init) or run `scan-host` from a node that can reach the hub — the chart’s default image is still distroless without Trivy.

### Docker Compose

```bash
cd deploy/docker
# Bind-mount host Trivy (override path if needed)
export TRIVY_HOST_BIN=/usr/local/bin/trivy
docker compose --profile with-trivy up --build
```

This starts `agent-posture` with `HEIMDALL_HOST_POSTURE=1` and `/` → `/host`.  
Default `agent` service is unchanged (no Trivy).

## Environment reference

| Variable | Default | Meaning |
| --- | --- | --- |
| `HEIMDALL_HOST_POSTURE` | off | `1`/`true` → schedule rootfs scans in `run` |
| `HEIMDALL_HOST_POSTURE_INTERVAL` | `24h` | Go duration between scheduled scans |
| `HEIMDALL_HOST_ROOT` | `/host` if dir exists, else `/` | Path passed to `trivy rootfs` |
| `HEIMDALL_TRIVY_BIN` | `trivy` | Trivy binary path |
| `HEIMDALL_TRIVY_TIMEOUT` | `10m` | Scan timeout (rootfs is heavier than image) |

Scan command under the hood:

```text
trivy rootfs --quiet --format json --scanners vuln,misconfig <root>
```

Secrets/license scanners are **not** enabled for posture v1.

## UI walkthrough

1. **One host** — Fleet → click hostname → scroll to **Security / Posture**. Empty state explains Trivy setup when there are no findings.
2. **All hosts** — Security → click **Host posture**. Severity tiles reflect the filtered set.
3. Findings show severity, title (links to Trivy/AVD URL when present), package (for CVEs), and resource/path (for misconfigs).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `trivy not found on PATH` | Install Trivy or set `HEIMDALL_TRIVY_BIN` |
| Empty Posture section | Run `scan-host` once; confirm ingest 202; refresh host page |
| Scan very slow / timeout | Narrow root (`HEIMDALL_HOST_ROOT`), raise `HEIMDALL_TRIVY_TIMEOUT`, avoid scanning huge bind mounts |
| Findings on Security but not host | Ensure ingest used `scanKind=host_posture` (script/`scan-host` do this); image scans are `trivy` only |
| Compose posture agent exits | Confirm `TRIVY_HOST_BIN` exists on the Docker host |

Dry-run helpers:

```bash
# See resolved root without ingesting
DRY_RUN=1 ./scripts/scan-host-posture.sh

# Confirm Trivy JSON locally (no hub)
trivy rootfs --quiet --format json --scanners vuln,misconfig /
```

## Related

- Deploy matrix + short posture table: [`deploy.md`](deploy.md)
- Agent install: [`../scripts/install-agent.sh`](../scripts/install-agent.sh)
- One-shot scan helper: [`../scripts/scan-host-posture.sh`](../scripts/scan-host-posture.sh)
