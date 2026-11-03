#!/usr/bin/env bash
# Install Heimdall agent as a systemd service (standalone / bare metal).
#
# Required:
#   HUB_URL   Hub base URL (e.g. https://heimdall.example.com)
#   TOKEN     Bootstrap or agent token
#
# Optional:
#   BINARY           Path to heimdall-agent binary (default: look beside script / PATH)
#   INSTALL_DIR      Where to install binary (default: /usr/local/bin)
#   ENV_FILE         Environment file path (default: /etc/heimdall/agent.env)
#   UNIT_SRC         Unit file path (default: deploy/systemd/heimdall-agent.service relative to repo)
#   STATE_DIR        Agent state dir (default: /var/lib/heimdall)
#   HOSTNAME_VALUE   HEIMDALL_HOSTNAME (default: $(hostname))
#   CLUSTER_ID       HEIMDALL_CLUSTER_ID (default: default)
#   ENABLE_K8S       HEIMDALL_ENABLE_K8S (default: false)
#   DOCKER=0         Do not add user heimdall to the docker group (default: add it when the group exists)
#   DRY_RUN=1        Print actions without writing
#   DESTDIR          Root prefix for every written path (tests)
#   --uninstall      Stop + disable the unit; remove binary, unit, env file (PURGE=1 also state dir)
set -euo pipefail

HUB_URL="${HUB_URL:-}"
TOKEN="${TOKEN:-}"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
ENV_FILE="${ENV_FILE:-/etc/heimdall/agent.env}"
STATE_DIR="${STATE_DIR:-/var/lib/heimdall}"
HOSTNAME_VALUE="${HOSTNAME_VALUE:-$(hostname 2>/dev/null || echo heimdall-agent)}"
CLUSTER_ID="${CLUSTER_ID:-default}"
ENABLE_K8S="${ENABLE_K8S:-false}"
DOCKER="${DOCKER:-auto}"
DRY_RUN="${DRY_RUN:-0}"
DESTDIR="${DESTDIR:-}"
PURGE="${PURGE:-0}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC="${UNIT_SRC:-$ROOT/deploy/systemd/heimdall-agent.service}"
UNIT_DST="${UNIT_DST:-/etc/systemd/system/heimdall-agent.service}"

usage() {
  cat <<'EOF'
Usage: HUB_URL=… TOKEN=… ./scripts/install-agent.sh

Installs/copies the heimdall-agent binary, ensures system user heimdall and
/var/lib/heimdall, writes /etc/heimdall/agent.env, installs
deploy/systemd/heimdall-agent.service, and enables the unit.

Environment:
  HUB_URL TOKEN          required
  BINARY                 path to built binary (or place heimdall-agent on PATH)
  DRY_RUN=1              print steps only
  --uninstall            remove binary, unit and env (PURGE=1 also /var/lib/heimdall)
  ENABLE_K8S=true        for kubeconfig / in-cluster hosts that should scrape K8s

For agent + OpenTelemetry Collector (metrics + logs), prefer:
  ./scripts/install-baremetal.sh
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "+ $*"
  else
    "$@"
  fi
}

if [[ "${1:-}" == "--uninstall" ]]; then
  if command -v systemctl >/dev/null 2>&1; then
    run systemctl disable --now heimdall-agent.service || true
  fi
  run rm -f "${DESTDIR}${INSTALL_DIR}/heimdall-agent" "${DESTDIR}${UNIT_DST}" "${DESTDIR}${ENV_FILE}"
  if [[ "$PURGE" == "1" ]]; then
    run rm -rf "${DESTDIR}${STATE_DIR}"
  fi
  if command -v systemctl >/dev/null 2>&1; then
    run systemctl daemon-reload || true
  fi
  echo "Removed heimdall-agent$([[ "$PURGE" == "1" ]] && echo " and ${STATE_DIR}" || echo " (kept ${STATE_DIR}; PURGE=1 removes it)")"
  exit 0
fi

if [[ -z "$HUB_URL" || -z "$TOKEN" ]]; then
  echo "error: HUB_URL and TOKEN are required" >&2
  usage >&2
  exit 2
fi

HUB_URL="${HUB_URL%/}"

resolve_binary() {
  if [[ -n "${BINARY:-}" && -x "$BINARY" ]]; then
    echo "$BINARY"
    return
  fi
  if [[ -x "$ROOT/apps/agent/bin/heimdall-agent" ]]; then
    echo "$ROOT/apps/agent/bin/heimdall-agent"
    return
  fi
  if command -v heimdall-agent >/dev/null 2>&1; then
    command -v heimdall-agent
    return
  fi
  return 1
}

ensure_heimdall_user() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "+ ensure group/user heimdall"
    echo "+ install -d -m 0755 ${STATE_DIR} (chown heimdall:heimdall)"
    return
  fi
  if ! getent group heimdall >/dev/null 2>&1; then
    if command -v groupadd >/dev/null 2>&1; then
      groupadd --system heimdall
    else
      echo "warning: groupadd not found; create group heimdall manually" >&2
    fi
  fi
  if ! getent passwd heimdall >/dev/null 2>&1; then
    if command -v useradd >/dev/null 2>&1; then
      useradd --system --gid heimdall --home-dir "$STATE_DIR" \
        --shell /usr/sbin/nologin --comment "Heimdall agent" heimdall 2>/dev/null \
        || useradd --system --gid heimdall --home-dir "$STATE_DIR" \
          --shell /bin/false --comment "Heimdall agent" heimdall
    else
      echo "warning: useradd not found; create user heimdall manually" >&2
    fi
  fi
  install -d -m 0755 "${DESTDIR}$STATE_DIR"
  if [[ -z "$DESTDIR" ]] && getent passwd heimdall >/dev/null 2>&1; then
    chown heimdall:heimdall "$STATE_DIR" || true
  fi
}

# Container metrics need the Docker socket, which the docker group can read. Membership is
# root-equivalent on that host, so say so; DOCKER=0 opts out.
grant_docker() {
  [[ "$DOCKER" == "0" ]] && return 0
  getent group docker >/dev/null 2>&1 || return 0
  echo "Adding user heimdall to the docker group for container metrics (root-equivalent access to Docker; DOCKER=0 to skip)"
  if command -v usermod >/dev/null 2>&1; then
    run usermod -aG docker heimdall
  else
    echo "warning: usermod not found; add heimdall to the docker group manually" >&2
  fi
}

write_env() {
  local content
  content=$(cat <<EOF
HEIMDALL_HUB_URL=${HUB_URL}
HEIMDALL_BOOTSTRAP_TOKEN=${TOKEN}
HEIMDALL_HOSTNAME=${HOSTNAME_VALUE}
HEIMDALL_INTERVAL=10s
HEIMDALL_CLUSTER_ID=${CLUSTER_ID}
HEIMDALL_ENABLE_K8S=${ENABLE_K8S}
EOF
)
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "+ write ${ENV_FILE}"
    echo "$content" | sed -e "s/^\(HEIMDALL_BOOTSTRAP_TOKEN=\).*/\1***/" -e "s/^/  /"
    return
  fi
  install -d -m 0755 "${DESTDIR}$(dirname "$ENV_FILE")"
  (umask 077; printf "%s\n" "$content" >"${DESTDIR}$ENV_FILE")
  chmod 0600 "${DESTDIR}$ENV_FILE"
}

if ! BIN="$(resolve_binary)"; then
  echo "error: heimdall-agent binary not found." >&2
  echo "Build first:  cd apps/agent && go build -o bin/heimdall-agent ./cmd/agent" >&2
  echo "Or set BINARY=/path/to/heimdall-agent" >&2
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "(continuing dry-run without binary copy)" >&2
    BIN="heimdall-agent"
  else
    exit 1
  fi
fi

if [[ ! -f "$UNIT_SRC" ]]; then
  echo "error: unit file missing: $UNIT_SRC" >&2
  exit 1
fi

echo "Installing Heimdall agent → ${INSTALL_DIR}/heimdall-agent"
ensure_heimdall_user
grant_docker
run install -d -m 0755 "${DESTDIR}$INSTALL_DIR"
if [[ "$BIN" != "${INSTALL_DIR}/heimdall-agent" ]]; then
  run install -m 0755 "$BIN" "${DESTDIR}${INSTALL_DIR}/heimdall-agent"
fi

write_env
run install -d -m 0755 "${DESTDIR}$(dirname "$UNIT_DST")"
run install -m 0644 "$UNIT_SRC" "${DESTDIR}$UNIT_DST"

if command -v systemctl >/dev/null 2>&1; then
  run systemctl daemon-reload
  run systemctl enable heimdall-agent.service
  # restart (not enable --now) so a reinstall picks up the new binary, env and group membership
  run systemctl restart heimdall-agent.service
  echo "Enabled and (re)started heimdall-agent.service"
else
  echo "systemctl not found — unit installed at $UNIT_DST; enable manually."
fi

echo "Done. Hub: ${HUB_URL}  hostname: ${HOSTNAME_VALUE}  k8s: ${ENABLE_K8S}"
