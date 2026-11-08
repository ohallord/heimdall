#!/usr/bin/env bash
# One-shot Phase 13 host posture scan → hub ingest.
#
# Required:
#   HUB_URL   Hub base URL (e.g. http://127.0.0.1:43123)
#   TOKEN     Bootstrap/agent token
#
# Optional:
#   HOSTNAME_VALUE   Agent hostname (default: $(hostname)-posture)
#   ROOT             Host root for trivy rootfs (default: HEIMDALL_HOST_ROOT or auto)
#   BINARY           Path to heimdall-agent (default: build apps/agent/bin/heimdall-agent)
#   HEIMDALL_TRIVY_BIN / HEIMDALL_TRIVY_TIMEOUT / HEIMDALL_HOST_ROOT
#   DRY_RUN=1        Print resolved settings + check Trivy; do not scan/ingest
#   SKIP_BUILD=1     Do not go build if binary missing
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HUB_URL="${HUB_URL:-${HEIMDALL_HUB_URL:-}}"
TOKEN="${TOKEN:-${HEIMDALL_BOOTSTRAP_TOKEN:-}}"
HOSTNAME_VALUE="${HOSTNAME_VALUE:-${HEIMDALL_HOSTNAME:-$(hostname 2>/dev/null || echo heimdall)-posture}}"
SCAN_ROOT="${ROOT:-${HEIMDALL_HOST_ROOT:-}}"
DRY_RUN="${DRY_RUN:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
BINARY="${BINARY:-}"

usage() {
  cat <<'EOF'
Usage: HUB_URL=… TOKEN=… ./scripts/scan-host-posture.sh

Runs heimdall-agent scan-host (Trivy rootfs vuln+misconfig) and ingests
findings as source host_posture.

Environment:
  HUB_URL / HEIMDALL_HUB_URL              required (unless DRY_RUN=1)
  TOKEN / HEIMDALL_BOOTSTRAP_TOKEN        required (unless DRY_RUN=1)
  HOSTNAME_VALUE / HEIMDALL_HOSTNAME      agent hostname for register
  ROOT / HEIMDALL_HOST_ROOT               filesystem root to scan
  HEIMDALL_TRIVY_BIN                     trivy binary (default: trivy on PATH)
  HEIMDALL_TRIVY_TIMEOUT                 scan timeout (default: agent 10m)
  BINARY                                 path to heimdall-agent
  DRY_RUN=1                              check Trivy + print plan only
  SKIP_BUILD=1                           fail if BINARY missing (no go build)

See docs/host-posture.md for UI and schedule setup.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

resolve_trivy() {
  local bin="${HEIMDALL_TRIVY_BIN:-trivy}"
  if [[ "$bin" == */* ]]; then
    if [[ -x "$bin" ]]; then
      echo "$bin"
      return 0
    fi
    return 1
  fi
  command -v "$bin" 2>/dev/null
}

resolve_root() {
  if [[ -n "$SCAN_ROOT" ]]; then
    echo "$SCAN_ROOT"
    return 0
  fi
  if [[ -d /host ]]; then
    echo /host
    return 0
  fi
  echo /
}

resolve_binary() {
  if [[ -n "$BINARY" && -x "$BINARY" ]]; then
    echo "$BINARY"
    return 0
  fi
  local candidates=(
    "$ROOT_DIR/apps/agent/bin/heimdall-agent"
    "$ROOT_DIR/apps/agent/heimdall-agent"
  )
  local c
  for c in "${candidates[@]}"; do
    if [[ -x "$c" ]]; then
      echo "$c"
      return 0
    fi
  done
  if command -v heimdall-agent >/dev/null 2>&1; then
    command -v heimdall-agent
    return 0
  fi
  return 1
}

ensure_binary() {
  if bin="$(resolve_binary)"; then
    echo "$bin"
    return 0
  fi
  if [[ "$SKIP_BUILD" == "1" ]]; then
    echo "error: heimdall-agent binary not found (SKIP_BUILD=1)" >&2
    return 1
  fi
  echo "==> building heimdall-agent" >&2
  mkdir -p "$ROOT_DIR/apps/agent/bin"
  (cd "$ROOT_DIR/apps/agent" && go build -o bin/heimdall-agent ./cmd/agent)
  echo "$ROOT_DIR/apps/agent/bin/heimdall-agent"
}

TRIVY_BIN="$(resolve_trivy || true)"
EFFECTIVE_ROOT="$(resolve_root)"

echo "==> host posture plan"
echo "    hub:      ${HUB_URL:-"(unset)"}"
echo "    hostname: ${HOSTNAME_VALUE}"
echo "    root:     ${EFFECTIVE_ROOT}"
echo "    trivy:    ${TRIVY_BIN:-"(missing)"}"

if [[ "$DRY_RUN" == "1" ]]; then
  if [[ -z "${TRIVY_BIN}" ]]; then
    echo "warn: Trivy not found — install it or set HEIMDALL_TRIVY_BIN before a real scan"
  elif ! "$TRIVY_BIN" version >/dev/null 2>&1; then
    echo "warn: could not run: $TRIVY_BIN version"
  fi
  echo "==> DRY_RUN=1 — skipping scan/ingest"
  exit 0
fi

if [[ -z "$HUB_URL" || -z "$TOKEN" ]]; then
  echo "error: HUB_URL and TOKEN are required" >&2
  usage >&2
  exit 2
fi

if [[ -z "${TRIVY_BIN}" ]]; then
  echo "error: Trivy not found. Install it or set HEIMDALL_TRIVY_BIN." >&2
  echo "       https://trivy.dev/ — see docs/host-posture.md" >&2
  exit 1
fi

if ! "$TRIVY_BIN" version >/dev/null 2>&1; then
  echo "error: could not run: $TRIVY_BIN version" >&2
  exit 1
fi

HUB_URL="${HUB_URL%/}"
AGENT_BIN="$(ensure_binary)"

echo "==> scanning + ingesting (scanKind=host_posture)"
export HEIMDALL_TRIVY_BIN="${HEIMDALL_TRIVY_BIN:-$TRIVY_BIN}"
if [[ -n "${HEIMDALL_HOST_ROOT:-}" || -n "${ROOT:-}" ]]; then
  export HEIMDALL_HOST_ROOT="$EFFECTIVE_ROOT"
fi

# Token via env (HEIMDALL_BOOTSTRAP_TOKEN), never argv: argv is world-readable in /proc and ps.
# No `set -x` here either — xtrace would echo the token.
echo "+ $AGENT_BIN scan-host --hub $HUB_URL --hostname $HOSTNAME_VALUE --root $EFFECTIVE_ROOT"
HEIMDALL_BOOTSTRAP_TOKEN="$TOKEN" "$AGENT_BIN" scan-host \
  --hub "$HUB_URL" \
  --hostname "$HOSTNAME_VALUE" \
  --root "$EFFECTIVE_ROOT"

echo "==> done — open hub Security → Host posture, or the host Security / Posture section"
echo "    ${HUB_URL}/dashboard/security?source=host_posture"
