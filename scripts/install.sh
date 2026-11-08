#!/usr/bin/env bash
# Guided Heimdall *server* installer / configurator.
#
# Scope: server-side install choices and file/env config (Compose / Helm values,
# storage, public URL / TLS cookie flags, optional OTEL collector snippet).
# Admin user, alerts, MFA, remotes, and token minting stay in the web UI.
#
# Default is dry-run. Secrets are written to mode-0600 files and never printed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/heimdall-common.sh
source "$ROOT/scripts/lib/heimdall-common.sh"

CMD="install"
MODE=""
DRY_RUN=1
NONINTERACTIVE=0
PUBLIC_URL="http://127.0.0.1:43123"
PORT="43123"
STORAGE="postgres"
TLS="off"
OTEL_COLLECTOR="off"
CONFIG_DIR=""
FORCE_REGEN_SECRETS=0

usage() {
  cat <<'EOF'
Usage: ./scripts/install.sh [install|configure|doctor] [options]

Server installer for Heimdall. Default is dry-run (no writes).

Commands:
  install     Create/update server config files (default)
  configure   Re-run server-side config (idempotent)
  doctor      Check local prerequisites; no secrets printed

Modes (only claim what the tree supports):
  compose     Docker Compose under deploy/docker (tested path)
  helm        Generate Helm values overlay (you run helm yourself)

Options:
  --mode compose|helm
  --public-url URL
  --port PORT
  --storage postgres|pglite
  --tls on|off
  --otel-collector on|off
  --config-dir DIR          Override output directory
  --non-interactive         Require flags; do not prompt
  --dry-run                 Print planned actions (default)
  --apply                   Write files (disables dry-run)
  --regen-secrets           Rotate generated secret files
  -h, --help

Secrets:
  Written under the mode config dir as *.secret files (0600).
  Never pass secrets as CLI arguments. Never printed to stdout.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    install|configure|doctor) CMD="$1"; shift ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    --public-url) PUBLIC_URL="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --storage) STORAGE="${2:-}"; shift 2 ;;
    --tls) TLS="${2:-}"; shift 2 ;;
    --otel-collector) OTEL_COLLECTOR="${2:-}"; shift 2 ;;
    --config-dir) CONFIG_DIR="${2:-}"; shift 2 ;;
    --non-interactive) NONINTERACTIVE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --apply) DRY_RUN=0; shift ;;
    --regen-secrets) FORCE_REGEN_SECRETS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) heimdall_err "unknown arg: $1"; usage >&2; exit 2 ;;
  esac
done

prompt() {
  local var="$1" msg="$2" default="${3:-}"
  if [[ "$NONINTERACTIVE" -eq 1 ]]; then
    return 0
  fi
  local cur="${!var}"
  if [[ -n "$cur" && "$cur" != "$default" ]]; then
    return 0
  fi
  local reply
  if [[ -n "$default" ]]; then
    read -r -p "$msg [$default]: " reply || true
    printf -v "$var" '%s' "${reply:-$default}"
  else
    read -r -p "$msg: " reply || true
    printf -v "$var" '%s' "$reply"
  fi
}

validate() {
  case "$STORAGE" in postgres|pglite) ;; *)
    heimdall_err "--storage must be postgres|pglite"; return 1 ;;
  esac
  case "$TLS" in on|off) ;; *)
    heimdall_err "--tls must be on|off"; return 1 ;;
  esac
  case "$OTEL_COLLECTOR" in on|off) ;; *)
    heimdall_err "--otel-collector must be on|off"; return 1 ;;
  esac
  if [[ ! "$PORT" =~ ^[0-9]+$ ]] || [[ "$PORT" -lt 1 || "$PORT" -gt 65535 ]]; then
    heimdall_err "--port must be 1-65535"; return 1
  fi
  if [[ -z "$PUBLIC_URL" ]]; then
    heimdall_err "--public-url is required"; return 1
  fi
  case "$PUBLIC_URL" in
    http://*|https://*) ;;
    *) heimdall_err "--public-url must start with http:// or https://"; return 1 ;;
  esac
}

doctor() {
  heimdall_log "Heimdall server doctor"
  heimdall_log "repo: $ROOT"
  for c in docker helm openssl; do
    if command -v "$c" >/dev/null 2>&1; then
      heimdall_log "ok: $c ($(command -v "$c"))"
    else
      heimdall_log "missing: $c (needed for some modes)"
    fi
  done
  if [[ -f "$ROOT/deploy/docker/compose.yaml" ]]; then
    heimdall_log "ok: compose path present"
  else
    heimdall_err "compose.yaml missing"; return 1
  fi
  if [[ -f "$ROOT/deploy/helm/heimdall/Chart.yaml" ]]; then
    heimdall_log "ok: helm chart present"
  else
    heimdall_err "helm chart missing"; return 1
  fi
  heimdall_log "unsupported by this installer: bare-metal hub binary/systemd (use Compose or Helm for the hub)"
  heimdall_log "agent bare-metal: use ./scripts/enroll-agent.sh / install-baremetal.sh"
}

ensure_secrets_compose() {
  local dir="$1"
  local boot="$dir/bootstrap.secret"
  local sess="$dir/session.secret"
  local db="$dir/db.secret"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    heimdall_log "+ ensure secret files under $dir (0600, values not shown)"
    return 0
  fi
  mkdir -p "$dir"
  if [[ "$FORCE_REGEN_SECRETS" -eq 1 || ! -f "$boot" ]]; then
    heimdall_write_secret_file "$boot" 24
  fi
  if [[ "$FORCE_REGEN_SECRETS" -eq 1 || ! -f "$sess" ]]; then
    heimdall_write_secret_file "$sess" 32
  fi
  # compose.yaml always requires POSTGRES_PASSWORD (its postgres service is unconditional).
  if [[ "$FORCE_REGEN_SECRETS" -eq 1 || ! -f "$db" ]]; then
    heimdall_write_secret_file "$db" 24
  fi
  # Encryption key for secrets at rest: never regenerated (that would orphan every stored secret).
  if [[ ! -f "$dir/secret-key.secret" ]]; then
    heimdall_write_secret_file "$dir/secret-key.secret" 32
  fi
}

write_compose_env() {
  local dir="${CONFIG_DIR:-$ROOT/deploy/docker}"
  local secrets="$dir/.heimdall-secrets"
  local envfile="$dir/.env.heimdall"
  local cookie_secure="false"
  [[ "$TLS" == "on" ]] && cookie_secure="true"

  ensure_secrets_compose "$secrets"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    heimdall_log "+ write $envfile (secrets redacted)"
    heimdall_log "  HEIMDALL_PUBLIC_URL=$PUBLIC_URL"
    heimdall_log "  PORT=$PORT"
    heimdall_log "  HEIMDALL_COOKIE_SECURE=$cookie_secure"
    heimdall_log "  STORAGE=$STORAGE"
    heimdall_log "  HEIMDALL_BOOTSTRAP_TOKEN=[REDACTED]"
    heimdall_log "  HEIMDALL_SESSION_SECRET=[REDACTED]"
    heimdall_log "  HEIMDALL_SECRET_KEY=[REDACTED]"
    heimdall_log "  POSTGRES_PASSWORD=[REDACTED]"
    if [[ "$OTEL_COLLECTOR" == "on" ]]; then
      heimdall_log "+ note: enable collector via deploy/otel/collector-docker-compose.yaml (token from UI)"
    fi
    return 0
  fi

  local boot sess dbpass key
  boot="$(heimdall_read_secret_file "$secrets/bootstrap.secret")"
  sess="$(heimdall_read_secret_file "$secrets/session.secret")"
  dbpass="$(heimdall_read_secret_file "$secrets/db.secret")"
  key="$(heimdall_read_secret_file "$secrets/secret-key.secret")"

  umask 077
  {
    echo "# Generated by scripts/install.sh — do not commit"
    echo "HEIMDALL_PUBLIC_URL=${PUBLIC_URL}"
    echo "HEIMDALL_ORIGIN=${PUBLIC_URL}"
    echo "HEIMDALL_RP_ID=$(printf '%s' "$PUBLIC_URL" | sed -E 's#https?://([^/:]+).*#\1#')"
    echo "HEIMDALL_COOKIE_SECURE=${cookie_secure}"
    echo "HEIMDALL_BOOTSTRAP_TOKEN=${boot}"
    echo "HEIMDALL_SESSION_SECRET=${sess}"
    echo "# BACK THIS UP: encrypts stored TOTP/OIDC/alert/SCM secrets."
    echo "HEIMDALL_SECRET_KEY=${key}"
    echo "POSTGRES_PASSWORD=${dbpass}"
    if [[ "$STORAGE" == "postgres" ]]; then
      echo "DATABASE_URL=postgres://heimdall:${dbpass}@postgres:5432/heimdall?sslmode=disable"
    else
      echo "HEIMDALL_DB_DRIVER=pglite"
      echo "# DATABASE_URL unset → PGlite"
    fi
  } >"$envfile"
  chmod 0600 "$envfile"
  heimdall_log "wrote $envfile (mode 0600)"
  heimdall_log "next: cd deploy/docker && docker compose --env-file .env.heimdall up --build"
  heimdall_log "then open ${PUBLIC_URL} and finish the first-run wizard in the UI"
  if [[ "$OTEL_COLLECTOR" == "on" ]]; then
    heimdall_log "OTEL: mint token in Settings → Integrations, then wire deploy/otel/collector-docker-compose.yaml"
  fi
}

write_helm_values() {
  local dir="${CONFIG_DIR:-$ROOT/deploy/helm/heimdall}"
  local secrets="$dir/.heimdall-secrets"
  local values="$dir/values-heimdall-generated.yaml"
  local cookie_secure="false"
  [[ "$TLS" == "on" ]] && cookie_secure="true"

  ensure_secrets_compose "$secrets"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    heimdall_log "+ write $values (secrets as secretKeyRef filenames, values not shown)"
    heimdall_log "  publicURL=$PUBLIC_URL storage=$STORAGE tls=$TLS"
    return 0
  fi

  local boot sess
  boot="$(heimdall_read_secret_file "$secrets/bootstrap.secret")"
  sess="$(heimdall_read_secret_file "$secrets/session.secret")"

  umask 077
  cat >"$values" <<EOF
# Generated by scripts/install.sh — review before helm upgrade
hub:
  service:
    port: ${PORT}
  env:
    HEIMDALL_PUBLIC_URL: "${PUBLIC_URL}"
    HEIMDALL_ORIGIN: "${PUBLIC_URL}"
    HEIMDALL_RP_ID: "$(printf '%s' "$PUBLIC_URL" | sed -E 's#https?://([^/:]+).*#\1#')"
    HEIMDALL_COOKIE_SECURE: "${cookie_secure}"
    HEIMDALL_BOOTSTRAP_TOKEN: "${boot}"
    HEIMDALL_SESSION_SECRET: "${sess}"
postgres:
  enabled: $([[ "$STORAGE" == "postgres" ]] && echo true || echo false)
EOF
  chmod 0600 "$values"
  heimdall_log "wrote $values (mode 0600 — contains secrets; do not commit)"
  heimdall_log "next: helm upgrade --install heimdall deploy/helm/heimdall -f $values"
  heimdall_log "finish admin setup in the hub UI after the service is reachable"
}

run_install() {
  if [[ -z "$MODE" ]]; then
    if [[ "$NONINTERACTIVE" -eq 1 ]]; then
      heimdall_err "--mode is required with --non-interactive"
      return 2
    fi
    heimdall_log "Select install mode:"
    heimdall_log "  1) Docker Compose (recommended for single-host)"
    heimdall_log "  2) Helm values overlay (you run helm)"
    local choice
    read -r -p "Choice [1]: " choice || true
    case "${choice:-1}" in
      1) MODE=compose ;;
      2) MODE=helm ;;
      *) heimdall_err "invalid choice"; return 2 ;;
    esac
  fi
  case "$MODE" in compose|helm) ;; *)
    heimdall_err "--mode must be compose|helm"; return 2 ;;
  esac

  prompt PUBLIC_URL "Public hub URL" "$PUBLIC_URL"
  prompt PORT "Hub port" "$PORT"
  prompt STORAGE "Storage (postgres|pglite)" "$STORAGE"
  prompt TLS "Terminate TLS at proxy and set secure cookies (on|off)" "$TLS"
  prompt OTEL_COLLECTOR "Prepare OTEL collector hints (on|off)" "$OTEL_COLLECTOR"
  validate

  heimdall_log "plan: mode=$MODE public_url=$PUBLIC_URL port=$PORT storage=$STORAGE tls=$TLS otel=$OTEL_COLLECTOR dry_run=$DRY_RUN"
  case "$MODE" in
    compose) write_compose_env ;;
    helm) write_helm_values ;;
  esac
}

case "$CMD" in
  doctor) doctor ;;
  install|configure) run_install ;;
  *) heimdall_err "unknown command: $CMD"; usage >&2; exit 2 ;;
esac
