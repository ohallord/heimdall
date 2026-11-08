#!/usr/bin/env bash
# Guided agent enrollment wrapper.
# Tokens must come from a mode-0600 file (--token-file) or TOKEN_FILE env.
# Never accept secrets as CLI arguments. Default is dry-run.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/heimdall-common.sh
source "$ROOT/scripts/lib/heimdall-common.sh"

HUB_URL=""
TOKEN_FILE="${TOKEN_FILE:-}"
DRY_RUN=1
NONINTERACTIVE=0
HOSTNAME_VALUE="${HOSTNAME_VALUE:-}"
CLUSTER_ID="${CLUSTER_ID:-default}"
ENABLE_K8S="${ENABLE_K8S:-false}"
WITH_OTEL=0
OTEL_TOKEN_FILE="${OTEL_TOKEN_FILE:-}"

usage() {
  cat <<'EOF'
Usage: ./scripts/enroll-agent.sh [options]

Enroll a Heimdall agent with an existing hub. Mint the agent token in the
web UI (wizard or Settings). This script only installs/configures the agent
process on the host.

Options:
  --hub-url URL              Hub base URL (required)
  --token-file PATH          File containing agent/bootstrap token (required)
  --hostname NAME            HEIMDALL_HOSTNAME
  --cluster-id ID            HEIMDALL_CLUSTER_ID (default: default)
  --enable-k8s true|false    Kubernetes scrape (default: false)
  --with-otel                Also configure baremetal OTEL collector
  --otel-token-file PATH     OTEL token file (required with --with-otel)
  --non-interactive
  --dry-run                  Default; print redacted plan
  --apply                    Perform install
  -h, --help

Environment alternatives: TOKEN_FILE, OTEL_TOKEN_FILE, HUB_URL
A non-https hub URL is refused (except loopback / in-cluster names) unless
HEIMDALL_ALLOW_INSECURE=1 (enforced by install-agent.sh and the agent).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub-url) HUB_URL="${2:-}"; shift 2 ;;
    --token-file) TOKEN_FILE="${2:-}"; shift 2 ;;
    --hostname) HOSTNAME_VALUE="${2:-}"; shift 2 ;;
    --cluster-id) CLUSTER_ID="${2:-}"; shift 2 ;;
    --enable-k8s) ENABLE_K8S="${2:-}"; shift 2 ;;
    --with-otel) WITH_OTEL=1; shift ;;
    --otel-token-file) OTEL_TOKEN_FILE="${2:-}"; shift 2 ;;
    --non-interactive) NONINTERACTIVE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --apply) DRY_RUN=0; shift ;;
    -h|--help) usage; exit 0 ;;
    --token|--otel-token)
      heimdall_err "refusing secret CLI args; use --token-file / --otel-token-file"
      exit 2
      ;;
    *) heimdall_err "unknown arg: $1"; usage >&2; exit 2 ;;
  esac
done

HUB_URL="${HUB_URL:-${HUB_URL_ENV:-}}"
# Allow HUB_URL from environment without putting token on argv
if [[ -z "$HUB_URL" && -n "${HEIMDALL_HUB_URL:-}" ]]; then
  HUB_URL="$HEIMDALL_HUB_URL"
fi

if [[ "$NONINTERACTIVE" -eq 0 ]]; then
  if [[ -z "$HUB_URL" ]]; then
    read -r -p "Hub URL: " HUB_URL || true
  fi
  if [[ -z "$TOKEN_FILE" ]]; then
    read -r -p "Path to token file: " TOKEN_FILE || true
  fi
  if [[ -z "$HOSTNAME_VALUE" ]]; then
    read -r -p "Agent hostname [$(hostname 2>/dev/null || echo heimdall-agent)]: " HOSTNAME_VALUE || true
    HOSTNAME_VALUE="${HOSTNAME_VALUE:-$(hostname 2>/dev/null || echo heimdall-agent)}"
  fi
fi

if [[ -z "$HUB_URL" || -z "$TOKEN_FILE" ]]; then
  heimdall_err "--hub-url and --token-file are required"
  usage >&2
  exit 2
fi

if [[ ! -f "$TOKEN_FILE" ]]; then
  heimdall_err "token file not found: $TOKEN_FILE"
  exit 2
fi

if [[ "$WITH_OTEL" -eq 1 && -z "$OTEL_TOKEN_FILE" ]]; then
  heimdall_err "--otel-token-file required with --with-otel"
  exit 2
fi

HOSTNAME_VALUE="${HOSTNAME_VALUE:-$(hostname 2>/dev/null || echo heimdall-agent)}"

heimdall_log "plan: hub=$HUB_URL hostname=$HOSTNAME_VALUE cluster=$CLUSTER_ID k8s=$ENABLE_K8S otel=$WITH_OTEL dry_run=$DRY_RUN"
heimdall_log "token-file=$TOKEN_FILE (contents not shown)"

# Export for install-agent.sh without putting token on argv
TOKEN="$(heimdall_read_secret_file "$TOKEN_FILE")"
export HUB_URL TOKEN HOSTNAME_VALUE CLUSTER_ID ENABLE_K8S
# Pass through DESTDIR/BINARY for sandbox tests without installing on the host.
[[ -n "${DESTDIR:-}" ]] && export DESTDIR
[[ -n "${BINARY:-}" ]] && export BINARY
[[ -n "${DOCKER:-}" ]] && export DOCKER
if [[ "$DRY_RUN" -eq 1 ]]; then
  export DRY_RUN=1
else
  export DRY_RUN=0
fi

if [[ "$WITH_OTEL" -eq 1 ]]; then
  OTEL_TOKEN="$(heimdall_read_secret_file "$OTEL_TOKEN_FILE")"
  export OTEL_TOKEN
  if [[ "$DRY_RUN" -eq 1 ]]; then
    heimdall_log "+ would run install-baremetal.sh (secrets redacted)"
  fi
  "$ROOT/scripts/install-baremetal.sh"
else
  if [[ "$DRY_RUN" -eq 1 ]]; then
    heimdall_log "+ would run install-agent.sh (secrets redacted)"
  fi
  "$ROOT/scripts/install-agent.sh"
fi

unset TOKEN OTEL_TOKEN 2>/dev/null || true
heimdall_log "done (agent enrollment)"
