#!/usr/bin/env bash
# Run the OpenTelemetry Collector as a Docker container on a Docker host, shipping host metrics
# (from host / at /hostfs) and docker stats to Heimdall /v1/metrics.
#
#   sudo env HUB_URL=https://hub.example.com OTEL_TOKEN_FILE=$HOME/hdo.txt ./scripts/install-otelcol-docker.sh
#   sudo ./scripts/install-otelcol-docker.sh --uninstall
#
# Env:
#   HUB_URL                        hub origin reachable from the container (required to install)
#   OTEL_TOKEN_FILE / OTEL_TOKEN   hdo_… ingest token (file preferred)
#   OTELCOL_VERSION                image tag, default 0.111.0 (same as Helm)
#   CONTAINER_NAME                 default heimdall-otelcol
#   DRY_RUN=1                      print steps only
#   DESTDIR                        root prefix for written files (tests)
# Re-running replaces the env file, config and container.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/otel-token.sh
source "${ROOT}/scripts/lib/otel-token.sh"

OTELCOL_VERSION="${OTELCOL_VERSION:-0.111.0}"
IMAGE="otel/opentelemetry-collector-contrib:${OTELCOL_VERSION}"
CONTAINER_NAME="${CONTAINER_NAME:-heimdall-otelcol}"
HUB_URL="${HUB_URL:-}"
DRY_RUN="${DRY_RUN:-0}"
DESTDIR="${DESTDIR:-}"
OTEL_ENV_FILE="${OTEL_ENV_FILE:-/etc/heimdall/otel.env}"
OTEL_CONFIG_DST="${OTEL_CONFIG_DST:-/etc/heimdall/otel-collector-docker.yaml}"
COLLECTOR_SRC="${COLLECTOR_SRC:-$ROOT/deploy/otel/collector-docker-compose.yaml}"

die() { echo "error: $*" >&2; exit 1; }
say() { echo "==> $*"; }
dry() { [[ "$DRY_RUN" == "1" ]]; }
run() { if dry; then echo "+ $*"; else "$@"; fi; }

# hostmetrics must read the host's /proc and filesystems, mounted at /hostfs.
render_config() {
  awk '{print} /^  hostmetrics:$/ {print "    root_path: /hostfs"}' "$COLLECTOR_SRC"
}

do_uninstall() {
  command -v docker >/dev/null 2>&1 || die "docker not found"
  say "Removing container ${CONTAINER_NAME}"
  if dry; then echo "+ docker rm -f $CONTAINER_NAME"; else docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true; fi
  run rm -f "${DESTDIR}${OTEL_ENV_FILE}" "${DESTDIR}${OTEL_CONFIG_DST}"
  say "Removed container, config and env"
}

do_install() {
  require_hub_url "$(basename "$0")"
  HUB_URL="${HUB_URL%/}"
  read_otel_token || exit 2
  [[ -f "$COLLECTOR_SRC" ]] || die "collector config missing: $COLLECTOR_SRC"
  command -v docker >/dev/null 2>&1 || die "docker not found"

  local env_file="${DESTDIR}${OTEL_ENV_FILE}" cfg="${DESTDIR}${OTEL_CONFIG_DST}"
  say "Write ${OTEL_CONFIG_DST} and ${OTEL_ENV_FILE} (0600)"
  if ! dry; then
    install -d -m 0755 "$(dirname "$cfg")" "$(dirname "$env_file")"
    render_config >"$cfg"
    chmod 0644 "$cfg"
    (umask 077; printf 'HEIMDALL_OTLP_ENDPOINT=%s\nHEIMDALL_OTEL_TOKEN=%s\n' "$HUB_URL" "$OTEL_TOKEN" >"$env_file")
    chmod 0600 "$env_file"
  fi

  say "Run ${IMAGE} as ${CONTAINER_NAME}"
  if dry; then echo "+ docker rm -f $CONTAINER_NAME"; else docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true; fi
  # Root in the container: reading host /proc and docker.sock needs it (same as the systemd unit).
  run docker run -d --name "$CONTAINER_NAME" --restart unless-stopped \
    --user 0:0 \
    --env-file "$env_file" \
    -v "$cfg:/etc/otelcol-contrib/config.yaml:ro" \
    -v /:/hostfs:ro \
    -v /var/run/docker.sock:/var/run/docker.sock:ro \
    -p 127.0.0.1:4317:4317 -p 127.0.0.1:4318:4318 \
    "$IMAGE" --config=/etc/otelcol-contrib/config.yaml

  echo "  Metrics:  ${HUB_URL}/v1/metrics"
  echo "  Traces:   ${HUB_URL}/v1/traces (apps: OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318)"
  echo "  Status:   docker logs -f ${CONTAINER_NAME}"
}

case "${1:-}" in
  -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' ;;
  --uninstall) do_uninstall ;;
  "") do_install ;;
  *) die "unknown argument: $1 (use --help)" ;;
esac
