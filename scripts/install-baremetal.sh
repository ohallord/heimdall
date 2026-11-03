#!/usr/bin/env bash
# Install Heimdall agent + OpenTelemetry Collector on bare metal / VM.
# The collector half is scripts/install-otelcol.sh (downloads + checksum-verifies otelcol-contrib).
#
# Required:
#   HUB_URL      Hub base URL (e.g. https://heimdall.example.com)
#   TOKEN        Agent bootstrap / agent token (hdt_…)
#   OTEL_TOKEN_FILE or OTEL_TOKEN   OTEL ingest token from Settings → Integrations (hdo_…)
#
# Optional:
#   BINARY / INSTALL_DIR / DRY_RUN=1
#   OTELCOL_BIN / OTELCOL_VERSION / OTELCOL_DOWNLOAD_BASE   see install-otelcol.sh
#   AGENT_ID     agt_… for host metric mirror + log binding
#   LOG_UNITS    comma-separated systemd units for journald (e.g. sshd.service,nginx.service)
#   LOG_PATHS    comma-separated file globs for filelog
#   Plus install-agent.sh options: HOSTNAME_VALUE, CLUSTER_ID, ENABLE_K8S, …
set -euo pipefail

HUB_URL="${HUB_URL:-}"
TOKEN="${TOKEN:-}"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
DRY_RUN="${DRY_RUN:-0}"
AGENT_ID="${AGENT_ID:-}"
LOG_UNITS="${LOG_UNITS:-}"
LOG_PATHS="${LOG_PATHS:-}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'USAGE'
Usage: HUB_URL=… TOKEN=… OTEL_TOKEN_FILE=… ./scripts/install-baremetal.sh

Installs heimdall-agent (via install-agent.sh) and otelcol-contrib (via install-otelcol.sh) with
hostmetrics + journald/filelog → Heimdall /v1/metrics and /v1/logs.

Environment:
  HUB_URL TOKEN                    required
  OTEL_TOKEN_FILE | OTEL_TOKEN     required (file preferred)
  OTELCOL_BIN                      local otelcol-contrib; skips download
  AGENT_ID                         optional agt_… resource attribute
  LOG_UNITS                        comma-separated systemd units for journald
  LOG_PATHS                        comma-separated file globs for filelog
  DRY_RUN=1                        print steps only
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ -z "$HUB_URL" || -z "$TOKEN" || ( -z "${OTEL_TOKEN:-}" && -z "${OTEL_TOKEN_FILE:-}" ) ]]; then
  echo "error: HUB_URL, TOKEN, and OTEL_TOKEN_FILE (or OTEL_TOKEN) are required" >&2
  usage >&2
  exit 2
fi

HUB_URL="${HUB_URL%/}"

echo "==> Installing Heimdall agent"
agent_env=(
  "HUB_URL=$HUB_URL"
  "TOKEN=$TOKEN"
  "DRY_RUN=$DRY_RUN"
  "INSTALL_DIR=$INSTALL_DIR"
)
[[ -n "${HOSTNAME_VALUE:-}" ]] && agent_env+=("HOSTNAME_VALUE=$HOSTNAME_VALUE")
[[ -n "${CLUSTER_ID:-}" ]] && agent_env+=("CLUSTER_ID=$CLUSTER_ID")
[[ -n "${ENABLE_K8S:-}" ]] && agent_env+=("ENABLE_K8S=$ENABLE_K8S")
[[ -n "${BINARY:-}" ]] && agent_env+=("BINARY=$BINARY")
env "${agent_env[@]}" "$ROOT/scripts/install-agent.sh"

echo "==> Installing OpenTelemetry Collector (install-otelcol.sh)"
otel_env=(
  "HUB_URL=$HUB_URL" "DRY_RUN=$DRY_RUN" "INSTALL_DIR=$INSTALL_DIR"
  "AGENT_ID=$AGENT_ID" "LOG_UNITS=$LOG_UNITS" "LOG_PATHS=$LOG_PATHS"
)
# Pass through optional overrides only when set, so install-otelcol.sh keeps its defaults.
for v in OTEL_TOKEN OTEL_TOKEN_FILE OTELCOL_BIN OTELCOL_VERSION OTELCOL_DOWNLOAD_BASE DESTDIR \
  OTEL_ENV_FILE OTEL_CONFIG_DST COLLECTOR_SRC OTEL_UNIT_SRC OTEL_UNIT_DST; do
  if [[ -n "${!v:-}" ]]; then otel_env+=("$v=${!v}"); fi
done
env "${otel_env[@]}" "$ROOT/scripts/install-otelcol.sh"

echo "Done baremetal install."
echo "  Hub:        ${HUB_URL}"
echo "  Agent env:  /etc/heimdall/agent.env"
