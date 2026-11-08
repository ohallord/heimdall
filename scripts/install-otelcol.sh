#!/usr/bin/env bash
# Install the OpenTelemetry Collector (otelcol-contrib) on a Linux systemd host, shipping
# hostmetrics + journald/filelog to Heimdall /v1/metrics and /v1/logs, plus app OTLP traces (127.0.0.1:4317/4318) to /v1/traces.
#
#   sudo env HUB_URL=https://hub.example.com OTEL_TOKEN_FILE=$HOME/hdo.txt ./scripts/install-otelcol.sh
#   sudo ./scripts/install-otelcol.sh --uninstall
#
# Env:
#   HUB_URL                        hub origin (required to install)
#   OTEL_TOKEN_FILE / OTEL_TOKEN   hdo_… ingest token (file preferred)
#   OTELCOL_VERSION                default 0.111.0 (same as the Helm chart)
#   OTELCOL_BIN                    use this binary; skips download (offline / air-gapped)
#   OTELCOL_DOWNLOAD_BASE          release URL base (mirror); default GitHub releases
#   AGENT_ID                       agt_… to bind metrics/logs to a Heimdall agent
#   LOG_UNITS                      comma-separated systemd units for journald
#   LOG_PATHS                      comma-separated file globs for filelog
#   INSTALL_DIR                    default /usr/local/bin
#   DRY_RUN=1                      print steps only
#   DESTDIR                        root prefix (tests)
# Re-running replaces binary, config, env and unit, then restarts the service.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/otel-token.sh
source "${ROOT}/scripts/lib/otel-token.sh"

OTELCOL_VERSION="${OTELCOL_VERSION:-0.111.0}"
OTELCOL_DOWNLOAD_BASE="${OTELCOL_DOWNLOAD_BASE:-https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download}"
HUB_URL="${HUB_URL:-}"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
DRY_RUN="${DRY_RUN:-0}"
DESTDIR="${DESTDIR:-}"
AGENT_ID="${AGENT_ID:-}"
LOG_UNITS="${LOG_UNITS:-}"
LOG_PATHS="${LOG_PATHS:-}"
OTEL_ENV_FILE="${OTEL_ENV_FILE:-/etc/heimdall/otel.env}"
OTEL_CONFIG_DST="${OTEL_CONFIG_DST:-/etc/heimdall/otel-collector.yaml}"
COLLECTOR_SRC="${COLLECTOR_SRC:-$ROOT/deploy/otel/collector-baremetal.yaml}"
OTEL_UNIT_SRC="${OTEL_UNIT_SRC:-$ROOT/deploy/systemd/heimdall-otelcol.service}"
OTEL_UNIT_DST="${OTEL_UNIT_DST:-/etc/systemd/system/heimdall-otelcol.service}"
UNIT=heimdall-otelcol.service

BIN_DST="${INSTALL_DIR}/otelcol-contrib"

die() { echo "error: $*" >&2; exit 1; }
say() { echo "==> $*"; }
dry() { [[ "$DRY_RUN" == "1" ]]; }
run() { if dry; then echo "+ $*"; else "$@"; fi; }
have_systemctl() { command -v systemctl >/dev/null 2>&1; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'
}

otel_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo amd64 ;;
    aarch64|arm64) echo arm64 ;;
    *) return 1 ;;
  esac
}

yaml_list_from_csv() {
  local out="" item
  local -a items
  IFS=',' read -r -a items <<<"$1"
  for item in "${items[@]}"; do
    item="$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' <<<"$item")"
    [[ -z "$item" ]] && continue
    out+="${out:+, }\"${item}\""
  done
  echo "[${out}]"
}

render_config() {
  local content
  content="$(cat "$COLLECTOR_SRC")"
  if [[ -n "$LOG_UNITS" ]]; then
    content="$(sed "s|units: \[\]|units: $(yaml_list_from_csv "$LOG_UNITS")|" <<<"$content")"
  fi
  if [[ -n "$LOG_PATHS" ]]; then
    content="$(sed \
      -e "s|include: \[\]|include: $(yaml_list_from_csv "$LOG_PATHS")|" \
      -e 's|receivers: \[journald\]|receivers: [journald, filelog]|' <<<"$content")"
  fi
  if [[ -n "$AGENT_ID" ]]; then
    content="$(sed \
      -e 's/# - key: heimdall.agent_id/- key: heimdall.agent_id/' \
      -e 's/#   value: \${env:HEIMDALL_AGENT_ID}/  value: ${env:HEIMDALL_AGENT_ID}/' \
      -e 's/#   action: upsert/  action: upsert/' <<<"$content")"
  fi
  printf '%s\n' "$content"
}

# The unit runs as this unprivileged user (deploy/systemd/heimdall-otelcol.service). journald needs
# systemd-journal (set in the unit); /var/log files are usually root:adm 0640, so join adm when the
# group exists (a SupplementaryGroups= entry for a missing group would stop the unit starting).
OTEL_USER=heimdall-otel
ensure_otel_user() {
  if dry; then
    echo "+ ensure system user ${OTEL_USER} (no login shell); add to group adm when present"
    return 0
  fi
  if ! getent group "$OTEL_USER" >/dev/null 2>&1; then
    if command -v groupadd >/dev/null 2>&1; then groupadd --system "$OTEL_USER"
    else echo "warning: groupadd not found; create group ${OTEL_USER} manually" >&2; fi
  fi
  if ! getent passwd "$OTEL_USER" >/dev/null 2>&1; then
    if command -v useradd >/dev/null 2>&1; then
      useradd --system --gid "$OTEL_USER" --no-create-home --home-dir /nonexistent \
        --shell /usr/sbin/nologin --comment "Heimdall OpenTelemetry Collector" "$OTEL_USER"
    else
      echo "warning: useradd not found; create user ${OTEL_USER} manually" >&2
    fi
  fi
  if getent group adm >/dev/null 2>&1 && command -v usermod >/dev/null 2>&1; then
    usermod -aG adm "$OTEL_USER"
  fi
}

render_env() {
  echo "HEIMDALL_OTLP_ENDPOINT=${HUB_URL}"
  echo "HEIMDALL_OTEL_TOKEN=${OTEL_TOKEN}"
  [[ -n "$AGENT_ID" ]] && echo "HEIMDALL_AGENT_ID=${AGENT_ID}"
  return 0
}

# Downloads the pinned release for this arch into $1 and verifies it against the release checksums.
fetch_otelcol() {
  local dir="$1" arch="$2"
  local tarball="otelcol-contrib_${OTELCOL_VERSION}_linux_${arch}.tar.gz"
  local sums="opentelemetry-collector-releases_otelcol-contrib_checksums.txt"
  local base="${OTELCOL_DOWNLOAD_BASE%/}/v${OTELCOL_VERSION}"
  command -v curl >/dev/null 2>&1 || die "curl is required to download otelcol-contrib (or set OTELCOL_BIN)"
  say "Download ${base}/${tarball}"
  curl -fsSL -o "$dir/$tarball" "$base/$tarball" || die "download failed: $base/$tarball"
  curl -fsSL -o "$dir/$sums" "$base/$sums" || die "download failed: $base/$sums"
  local want got
  want="$(awk -v f="$tarball" '$2 == f || $2 == "*"f {print $1}' "$dir/$sums")"
  [[ -n "$want" ]] || die "no checksum for $tarball in $sums"
  got="$(sha256_of "$dir/$tarball")"
  [[ "$got" == "$want" ]] || die "checksum mismatch for $tarball (want $want, got $got); nothing installed"
  say "Checksum OK ($got)"
  tar -xzf "$dir/$tarball" -C "$dir" otelcol-contrib || die "tarball has no otelcol-contrib"
}

do_uninstall() {
  say "Uninstalling ${UNIT}"
  if have_systemctl; then
    run systemctl disable --now "$UNIT" || true
  fi
  run rm -f "${DESTDIR}${OTEL_UNIT_DST}" "${DESTDIR}${BIN_DST}" "${DESTDIR}${OTEL_CONFIG_DST}" "${DESTDIR}${OTEL_ENV_FILE}"
  if have_systemctl; then
    run systemctl daemon-reload || true
  fi
  say "Removed binary, unit, config and env"
}

do_install() {
  require_hub_url "$(basename "$0")"
  HUB_URL="${HUB_URL%/}"
  read_otel_token || exit 2
  [[ -f "$COLLECTOR_SRC" ]] || die "collector config missing: $COLLECTOR_SRC"
  [[ -f "$OTEL_UNIT_SRC" ]] || die "unit file missing: $OTEL_UNIT_SRC"

  local src_bin
  if [[ -n "${OTELCOL_BIN:-}" ]]; then
    [[ -x "$OTELCOL_BIN" ]] || die "OTELCOL_BIN not executable: $OTELCOL_BIN"
    src_bin="$OTELCOL_BIN"
    say "Using OTELCOL_BIN=${OTELCOL_BIN} (no download)"
  else
    local arch
    arch="$(otel_arch)" || die "unsupported architecture: $(uname -m) (need x86_64 or aarch64)"
    if dry; then
      echo "+ download ${OTELCOL_DOWNLOAD_BASE%/}/v${OTELCOL_VERSION}/otelcol-contrib_${OTELCOL_VERSION}_linux_${arch}.tar.gz"
      echo "+ verify sha256 against opentelemetry-collector-releases_otelcol-contrib_checksums.txt"
      src_bin="otelcol-contrib"
    else
      WORK="$(mktemp -d)"
      trap 'rm -rf "${WORK:-}"' EXIT
      fetch_otelcol "$WORK" "$arch"
      src_bin="$WORK/otelcol-contrib"
    fi
  fi

  # Everything below writes; nothing above has touched the target root.
  ensure_otel_user
  say "Install ${BIN_DST}"
  run install -d -m 0755 "${DESTDIR}${INSTALL_DIR}"
  run install -m 0755 "$src_bin" "${DESTDIR}${BIN_DST}"

  say "Write ${OTEL_CONFIG_DST}"
  if dry; then
    render_config | sed 's/^/  /' | head -n 40
  else
    install -d -m 0755 "${DESTDIR}$(dirname "$OTEL_CONFIG_DST")"
    render_config >"${DESTDIR}${OTEL_CONFIG_DST}"
    chmod 0644 "${DESTDIR}${OTEL_CONFIG_DST}"
  fi

  say "Write ${OTEL_ENV_FILE} (0600)"
  if dry; then
    render_env | sed -e 's/^\(HEIMDALL_OTEL_TOKEN=\).*/\1***/' -e 's/^/  /'
  else
    install -d -m 0755 "${DESTDIR}$(dirname "$OTEL_ENV_FILE")"
    (umask 077; render_env >"${DESTDIR}${OTEL_ENV_FILE}")
    chmod 0600 "${DESTDIR}${OTEL_ENV_FILE}"
  fi

  say "Install ${OTEL_UNIT_DST}"
  if dry; then
    echo "+ install ${OTEL_UNIT_SRC} -> ${OTEL_UNIT_DST}"
  else
    install -d -m 0755 "${DESTDIR}$(dirname "$OTEL_UNIT_DST")"
    sed -e "s|/usr/local/bin/otelcol-contrib|${BIN_DST}|" \
      -e "s|/etc/heimdall/otel-collector.yaml|${OTEL_CONFIG_DST}|" \
      -e "s|/etc/heimdall/otel.env|${OTEL_ENV_FILE}|" \
      "$OTEL_UNIT_SRC" >"${DESTDIR}${OTEL_UNIT_DST}"
    chmod 0644 "${DESTDIR}${OTEL_UNIT_DST}"
  fi

  if have_systemctl; then
    run systemctl daemon-reload
    run systemctl enable "$UNIT"
    run systemctl restart "$UNIT"
    say "Enabled and (re)started ${UNIT}"
  else
    say "systemctl not found; unit at ${OTEL_UNIT_DST}, enable it manually"
  fi

  echo "  Metrics:    ${HUB_URL}/v1/metrics"
  echo "  Logs:       ${HUB_URL}/v1/logs"
  echo "  Traces:     ${HUB_URL}/v1/traces (apps: OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318)"
  echo "  Config:     ${OTEL_CONFIG_DST}"
  echo "  Env:        ${OTEL_ENV_FILE}"
  echo "  Status:     systemctl status ${UNIT}; journalctl -u ${UNIT} -f"
}

case "${1:-}" in
  -h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//' ;;
  --uninstall) do_uninstall ;;
  "") do_install ;;
  *) die "unknown argument: $1 (use --help)" ;;
esac
