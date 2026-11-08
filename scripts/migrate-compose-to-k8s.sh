#!/usr/bin/env bash
# Heimdall: migrate Docker Compose stack → Kubernetes (Helm)
#
# Still messy / complete-ish — homelab cutover learnings baked in; polish later.
#
# From repo root (see docs/migrate-compose-to-k8s.md):
#   ./scripts/migrate-compose-to-k8s.sh preflight
#   ./scripts/migrate-compose-to-k8s.sh images   # build + import into k3s/containerd
#   ./scripts/migrate-compose-to-k8s.sh all
#
# Env overrides (export before running):
#   HEIMDALL_ROOT          default: repo root (parent of scripts/)
#   COMPOSE_DIR            default: $HEIMDALL_ROOT/deploy/docker
#   HELM_CHART             default: $HEIMDALL_ROOT/deploy/helm/heimdall
#   K8S_NAMESPACE          default: heimdall
#   RELEASE_NAME           default: heimdall
#   CLUSTER_ID             default: homelab
#   BACKUP_DIR             default: a fresh private dir (umask 077, mktemp -d) under
#                          ${TMPDIR:-/var/tmp}; printed by export. Reuse it for restore.
#   PUBLIC_URL             browser URL you will open — NOT cluster DNS.
#                          Example (homelab LAN): http://203.0.113.10:43123
#                          Must match exposure (hostPort / NodePort / Ingress), not
#                          http://heimdall-hub:43123 (that is Service DNS only).
#   SESSION_SECRET         optional; empty = chart-generated Secret (never the old dev default)
#   POSTGRES_PASSWORD      optional; empty = chart-generated (cluster Postgres starts fresh)
#   BOOTSTRAP_TOKEN        REQUIRED for helm install (no default; openssl rand -hex 32)
#   PG_USER / PG_DB        default: heimdall / heimdall
#   HUB_NODEPORT           default: 43123 — keep in sync with PUBLIC_URL port when
#                          using NodePort on a single-node lab (or set hostPort).
#                          Empty string skips NodePort patch notes.
#   IMAGE_HUB              default: heimdall-hub:latest  (compose build tag)
#   IMAGE_AGENT            default: heimdall-agent:latest
#   SKIP_IMAGE_IMPORT=1    skip build/import (images already in node store)
#   SKIP_IMAGE_BUILD=1     alias for SKIP_IMAGE_IMPORT (same skip)
#   HELM_RESET=1           helm uninstall before install (stuck/partial release)
#                          also: ./scripts/migrate-compose-to-k8s.sh install --reset
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEIMDALL_ROOT="${HEIMDALL_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
COMPOSE_DIR="${COMPOSE_DIR:-${HEIMDALL_ROOT}/deploy/docker}"
HELM_CHART="${HELM_CHART:-${HEIMDALL_ROOT}/deploy/helm/heimdall}"
K8S_NAMESPACE="${K8S_NAMESPACE:-heimdall}"
RELEASE_NAME="${RELEASE_NAME:-heimdall}"
CLUSTER_ID="${CLUSTER_ID:-homelab}"
BACKUP_DIR="${BACKUP_DIR:-}"
BOOTSTRAP_TOKEN="${BOOTSTRAP_TOKEN:-}"
PG_USER="${PG_USER:-heimdall}"
PG_DB="${PG_DB:-heimdall}"
# Lab default: same port as Compose (:43123) so PUBLIC_URL stays familiar.
# On multi-tenant clusters use a high NodePort (e.g. 30431) and match PUBLIC_URL.
HUB_NODEPORT="${HUB_NODEPORT:-43123}"
PUBLIC_URL="${PUBLIC_URL:-}"
SESSION_SECRET="${SESSION_SECRET:-}"
IMAGE_HUB="${IMAGE_HUB:-heimdall-hub:latest}"
IMAGE_AGENT="${IMAGE_AGENT:-heimdall-agent:latest}"
SKIP_IMAGE_IMPORT="${SKIP_IMAGE_IMPORT:-0}"
# Alias: callers often set SKIP_IMAGE_BUILD=1 expecting no `docker compose build`.
SKIP_IMAGE_BUILD="${SKIP_IMAGE_BUILD:-0}"
if [[ "${SKIP_IMAGE_BUILD}" == "1" ]]; then
  SKIP_IMAGE_IMPORT=1
fi
HELM_RESET="${HELM_RESET:-0}"

log()  { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }

# compose.yaml requires runtime secrets (`${VAR:?}`). export/exec/cp never use them, so a var that
# is neither in the environment nor in the Compose .env gets a placeholder just to interpolate.
compose() {
  local -a extra=(PATH="${PATH}")
  local v
  for v in HEIMDALL_BOOTSTRAP_TOKEN HEIMDALL_SECRET_KEY HEIMDALL_SESSION_SECRET POSTGRES_PASSWORD; do
    if [[ -z "${!v:-}" ]] && ! grep -qs "^${v}=." "${COMPOSE_DIR}/.env"; then
      extra+=("${v}=interpolation-placeholder")
    fi
  done
  (cd "${COMPOSE_DIR}" && env "${extra[@]}" docker compose "$@")
}

# Private backup dir: the dump holds every secret in the DB. Never a predictable /var/tmp path.
ensure_backup_dir() {
  if [[ -z "${BACKUP_DIR}" ]]; then
    BACKUP_DIR="$(umask 077; mktemp -d "${TMPDIR:-/var/tmp}/heimdall-migrate.XXXXXX")"
  else
    (umask 077; mkdir -p "${BACKUP_DIR}")
    chmod 700 "${BACKUP_DIR}"
  fi
}

usage() {
  cat <<'EOF'
Heimdall Compose → Kubernetes migration

Usage:
  ./scripts/migrate-compose-to-k8s.sh <command> [args]

Commands:
  preflight   Check tools, cluster, compose, chart
  export      Dump Postgres (+ optional hub backup JSON if logged-in cookie file set)
  images      docker compose build hub/agent + import into k3s/containerd
  install     Helm upgrade --install (runs images first unless SKIP_IMAGE_IMPORT=1)
              install --reset  → helm uninstall first (or HELM_RESET=1)
  restore     Restore pg_dump into cluster Postgres
  cutover     Health checks + stop Compose hub/postgres guidance (+ port clash)
  host-agent  Notes / snippet to keep Docker monitoring against new hub
  status      kubectl get pods,svc,pvc,events (debug --wait hangs)
  all         preflight → export → images → install → restore → cutover
  help        This text

Required for install/all:
  # Browser URL with LAN IP + exposed port (MFA / cookies / ORIGIN). NOT Service DNS.
  export PUBLIC_URL='http://203.0.113.10:43123'
  export SESSION_SECRET=$(openssl rand -hex 32)   # optional; empty = chart-generated

Optional:
  export COOKIE_FILE=$HOME/.heimdall-cookies.txt  # browser cookies for Admin backup API (chmod 600)
  export BOOTSTRAP_TOKEN=$(openssl rand -hex 32)   # required
  export CLUSTER_ID=homelab
  export IMAGE_HUB=heimdall-hub:latest
  export IMAGE_AGENT=heimdall-agent:latest
  export SKIP_IMAGE_IMPORT=1     # already imported (skips compose build + import)
  export SKIP_IMAGE_BUILD=1      # alias for SKIP_IMAGE_IMPORT
  export HELM_RESET=1            # uninstall stuck release before install
  export HUB_NODEPORT=43123      # match PUBLIC_URL port on single-node labs
EOF
}

# --- port clash: Compose hub often still binds :43123 ---
warn_port_clash() {
  local port="${1:-43123}"
  log "Port clash check (:${port})"
  local listeners=""
  if command -v ss >/dev/null 2>&1; then
    listeners="$(ss -ltnp "sport = :${port}" 2>/dev/null || true)"
  elif command -v lsof >/dev/null 2>&1; then
    listeners="$(lsof -nP -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true)"
  fi
  if [[ -n "${listeners}" ]]; then
    warn "Something is listening on :${port} — Compose hub often holds this."
    printf '%s\n' "${listeners}"
    warn "Before K8s hub can bind hostPort/NodePort ${port}, run:"
    warn "  cd ${COMPOSE_DIR} && docker compose stop hub"
    warn "(After restore/cutover also: docker compose stop postgres)"
  else
    log "No listener detected on :${port} (good, or tools missing)"
  fi
}

cmd_preflight() {
  log "Preflight"
  need docker
  need kubectl
  need helm
  need curl
  [[ -d "${COMPOSE_DIR}" ]] || die "Compose dir missing: ${COMPOSE_DIR}"
  [[ -d "${HELM_CHART}" ]] || die "Helm chart missing: ${HELM_CHART} (git pull main?)"
  kubectl cluster-info >/dev/null || die "kubectl cannot reach a cluster"
  kubectl get nodes
  log "Compose status"
  compose ps || true
  curl -sf -m 5 http://127.0.0.1:43123/api/v1/health \
    || die "Compose hub not healthy on http://127.0.0.1:43123 — start it first"
  log "Helm chart values keys (inspect agent/hub flags)"
  if [[ -f "${HELM_CHART}/values.yaml" ]]; then
    grep -nE '^(hub|agent|postgres|image)|enabled|hubUrl|clusterId|enableK8s|BOOTSTRAP|PUBLIC|SESSION|pullPolicy' \
      "${HELM_CHART}/values.yaml" | head -80 || true
  fi
  warn_port_clash 43123
  log "Preflight OK — remember PUBLIC_URL is the browser URL (e.g. http://203.0.113.10:43123), not heimdall-hub DNS"
}

cmd_export() {
  ensure_backup_dir
  log "Export → ${BACKUP_DIR} (for restore: export BACKUP_DIR=${BACKUP_DIR})"
  compose ps | tee "${BACKUP_DIR}/compose-ps.txt"

  # Capture compose env (redact-ish: still treat as secret)
  if [[ -f "${COMPOSE_DIR}/.env" ]]; then
    (umask 077; cp "${COMPOSE_DIR}/.env" "${BACKUP_DIR}/compose.env")
  fi
  compose config > "${BACKUP_DIR}/compose.config.yaml" 2>/dev/null || true

  log "pg_dump from Compose postgres"
  compose exec -T postgres \
    sh -c 'd=$(mktemp -d) && pg_dump -U "$1" -d "$2" --format=custom --file="$d/heimdall.dump" && echo "$d"' sh "${PG_USER}" "${PG_DB}" \
    >"${BACKUP_DIR}/.remote-dir"
  local rdir
  rdir="$(tr -d '\r\n' <"${BACKUP_DIR}/.remote-dir")"; rm -f "${BACKUP_DIR}/.remote-dir"
  [[ "${rdir}" == /tmp/* ]] || die "unexpected dump dir in postgres container: ${rdir}"
  (umask 077; compose cp "postgres:${rdir}/heimdall.dump" "${BACKUP_DIR}/heimdall.dump")
  compose exec -T postgres rm -rf "${rdir}" || true
  # Also plain SQL for easier debugging
  compose exec -T postgres \
    pg_dump -U "${PG_USER}" -d "${PG_DB}" --format=plain \
    > "${BACKUP_DIR}/heimdall.sql"

  # Org / agent snapshot for sanity
  compose exec -T postgres psql -U "${PG_USER}" -d "${PG_DB}" -c \
    "SELECT id, name FROM organizations ORDER BY created_at;" \
    | tee "${BACKUP_DIR}/organizations.txt" || true
  compose exec -T postgres psql -U "${PG_USER}" -d "${PG_DB}" -c \
    "SELECT id, hostname, org_id, last_seen_at FROM agents;" \
    | tee "${BACKUP_DIR}/agents.txt" || true

  # Optional: Admin backup API (settings channels/remotes/OIDC). Needs session cookie.
  if [[ -n "${COOKIE_FILE:-}" && -f "${COOKIE_FILE}" ]]; then
    log "HTTP backup with secrets (COOKIE_FILE=${COOKIE_FILE})"
    curl -sf -b "${COOKIE_FILE}" \
      "http://127.0.0.1:43123/api/v1/admin/backup?includeSecrets=1" \
      -o "${BACKUP_DIR}/heimdall-backup.json" \
      || log "WARN: backup API failed — DB dump is still enough for full restore"
  else
    log "Skipping HTTP backup (set COOKIE_FILE to a logged-in admin cookie jar for JSON export)"
  fi

  chmod 600 "${BACKUP_DIR}/heimdall.dump" "${BACKUP_DIR}/heimdall.sql" 2>/dev/null || true
  log "Export complete: ${BACKUP_DIR}"
  ls -la "${BACKUP_DIR}"
}

# Detect how to import images into the node that runs pods.
# k3s: docker daemon ≠ containerd used by kubelet → must `k3s ctr images import`
# plain docker desktop / kind / etc: often same store or `ctr -n k8s.io`
detect_image_runtime() {
  if command -v k3s >/dev/null 2>&1 && sudo k3s ctr version >/dev/null 2>&1; then
    echo "k3s"
  elif command -v ctr >/dev/null 2>&1 && sudo ctr -n k8s.io images ls >/dev/null 2>&1; then
    echo "ctr"
  elif docker info >/dev/null 2>&1; then
    echo "docker"
  else
    echo "unknown"
  fi
}

import_image() {
  local img="$1"
  local runtime
  runtime="$(detect_image_runtime)"
  log "Import ${img} via runtime=${runtime}"
  case "${runtime}" in
    k3s)
      # homelab path: compose builds into docker; k3s has its own containerd.
      docker save "${img}" | sudo k3s ctr images import -
      ;;
    ctr)
      docker save "${img}" | sudo ctr -n k8s.io images import -
      ;;
    docker)
      warn "No k3s/ctr detected — assuming kubelet shares the docker image store (${img} already local)."
      warn "If pods ImagePullBackOff, install k3s ctr path or retag into the cluster store."
      docker image inspect "${img}" >/dev/null \
        || die "docker missing image ${img} — run compose build first"
      ;;
    *)
      die "cannot detect image import path (need k3s ctr, ctr -n k8s.io, or docker)"
      ;;
  esac
}

cmd_images() {
  if [[ "${SKIP_IMAGE_IMPORT}" == "1" || "${SKIP_IMAGE_BUILD}" == "1" ]]; then
    log "SKIP_IMAGE_IMPORT/SKIP_IMAGE_BUILD=1 — skipping docker compose build + import"
    return 0
  fi
  need docker
  log "Build compose images (hub + agent)"
  # Compose project name=heimdall → hub becomes heimdall-hub[:latest]
  # Agent already pins image: heimdall-agent:latest in compose.yaml
  compose build hub agent
  # Retag whatever compose produced → IMAGE_HUB / IMAGE_AGENT (messy but works)
  local hub_id agent_id
  hub_id="$(compose images -q hub 2>/dev/null | head -1 || true)"
  agent_id="$(compose images -q agent 2>/dev/null | head -1 || true)"
  [[ -n "${hub_id}" ]] || die "compose build hub produced no image id"
  [[ -n "${agent_id}" ]] || die "compose build agent produced no image id"
  docker tag "${hub_id}" "${IMAGE_HUB}"
  docker tag "${agent_id}" "${IMAGE_AGENT}"
  docker image inspect "${IMAGE_HUB}" >/dev/null || die "missing ${IMAGE_HUB}"
  docker image inspect "${IMAGE_AGENT}" >/dev/null || die "missing ${IMAGE_AGENT}"

  log "Import into cluster node store"
  import_image "${IMAGE_HUB}"
  import_image "${IMAGE_AGENT}"
  log "Images ready: ${IMAGE_HUB} ${IMAGE_AGENT} (pullPolicy=IfNotPresent)"
}

# Build --set args aligned with deploy/helm/heimdall/values.yaml (+ hub/agent templates).
# Chart uses full image refs: image.hub / image.agent (not separate repository/tag).
# image.pullPolicy default IfNotPresent — required so local imports are used.
# Chart wires hub.env.{BOOTSTRAP,SESSION,PUBLIC_URL,RP_ID,ORIGIN} and agent.{hostname,clusterId,enableK8s}.
# HEIMDALL_COOKIE_SECURE is not a chart value (hub derives Secure from PUBLIC_URL scheme).
helm_sets() {
  [[ -n "${PUBLIC_URL}" ]] || die "PUBLIC_URL is required (export PUBLIC_URL=http://203.0.113.10:43123)"
  case "${SESSION_SECRET}" in
    heimdall-dev-""session-secret*|CHANGE_ME_""SESSION_SECRET*)
      die "SESSION_SECRET is a shipped placeholder; unset it (chart generates one) or use: openssl rand -hex 32" ;;
  esac
  [[ -n "${BOOTSTRAP_TOKEN}" ]] || die "BOOTSTRAP_TOKEN is required (e.g. export BOOTSTRAP_TOKEN=\$(openssl rand -hex 32))"
  case "${PUBLIC_URL}" in
    *heimdall-hub*)
      warn "PUBLIC_URL looks like Service DNS (${PUBLIC_URL})."
      warn "Use the browser URL (LAN IP / hostname + port), e.g. http://203.0.113.10:43123"
      ;;
  esac
  local rp_id
  rp_id="$(printf '%s' "${PUBLIC_URL}" | sed -E 's|^https?://||; s|[:/].*$||')"

  HELM_SET_ARGS=(
    --set "image.hub=${IMAGE_HUB}"
    --set "image.agent=${IMAGE_AGENT}"
    --set "image.pullPolicy=IfNotPresent"
    --set "hub.env.HEIMDALL_BOOTSTRAP_TOKEN=${BOOTSTRAP_TOKEN}"
    --set "hub.env.HEIMDALL_PUBLIC_URL=${PUBLIC_URL}"
    --set "hub.env.HEIMDALL_RP_ID=${rp_id}"
    --set "hub.env.HEIMDALL_ORIGIN=${PUBLIC_URL}"
    --set "agent.clusterId=${CLUSTER_ID}"
    --set-string "agent.enableK8s=true"
    --set "agent.hostname=k8s-${CLUSTER_ID}-01"
  )
  if [[ -n "${SESSION_SECRET}" ]]; then
    HELM_SET_ARGS+=(--set-string "hub.env.HEIMDALL_SESSION_SECRET=${SESSION_SECRET}")
  fi
  # Restore goes into a fresh cluster Postgres, so the chart-generated password is fine.
  if [[ -n "${POSTGRES_PASSWORD:-}" ]]; then
    HELM_SET_ARGS+=(--set-string "postgres.auth.password=${POSTGRES_PASSWORD}")
  fi
  # Chart values.yaml only has hub.service.{type,port} — no nodePort key in template.
  # We set type=NodePort here; specific port patched after install (see cmd_install).
  if [[ -n "${HUB_NODEPORT}" ]]; then
    HELM_SET_ARGS+=(
      --set "hub.service.type=NodePort"
    )
  fi
}

cmd_install() {
  # install --reset → HELM_RESET=1
  for arg in "$@"; do
    case "${arg}" in
      --reset) HELM_RESET=1 ;;
    esac
  done

  log "Ensure local images in cluster (before helm)"
  cmd_images

  warn_port_clash 43123
  if [[ -n "${HUB_NODEPORT}" && "${HUB_NODEPORT}" != "43123" ]]; then
    warn_port_clash "${HUB_NODEPORT}"
  fi

  log "Helm install ${RELEASE_NAME} into ${K8S_NAMESPACE}"
  helm_sets
  kubectl get ns "${K8S_NAMESPACE}" >/dev/null 2>&1 || kubectl create namespace "${K8S_NAMESPACE}"

  if [[ "${HELM_RESET}" == "1" ]]; then
    log "HELM_RESET=1 — uninstalling release ${RELEASE_NAME} (if present)"
    helm uninstall "${RELEASE_NAME}" -n "${K8S_NAMESPACE}" 2>/dev/null \
      || log "no existing release (ok)"
    # give finalizers a moment; leftover pods can confuse --wait
    sleep 3
    kubectl -n "${K8S_NAMESPACE}" get pods,svc,pvc 2>/dev/null || true
  fi

  # Dry-run first (output can hold secrets: private temp file, removed after)
  local dry
  dry="$(umask 077; mktemp "${TMPDIR:-/tmp}/heimdall-helm-dry-run.XXXXXX")"
  helm upgrade --install "${RELEASE_NAME}" "${HELM_CHART}" \
    -n "${K8S_NAMESPACE}" \
    --dry-run \
    "${HELM_SET_ARGS[@]}" \
    >"${dry}" \
    || { rm -f "${dry}"; die "helm dry-run failed — open values.yaml and adjust HELM_SET_ARGS in this script"; }
  rm -f "${dry}"

  # If --wait hangs: another terminal → ./scripts/migrate-compose-to-k8s.sh status
  helm upgrade --install "${RELEASE_NAME}" "${HELM_CHART}" \
    -n "${K8S_NAMESPACE}" \
    --wait --timeout 10m \
    "${HELM_SET_ARGS[@]}" \
    || {
      warn "helm --wait failed/timeout — dumping status"
      cmd_status
      die "helm upgrade failed — fix ImagePullBackOff (run images) or port clash (stop compose hub)"
    }

  # Pin NodePort so PUBLIC_URL port matches (chart template has no nodePort field).
  if [[ -n "${HUB_NODEPORT}" ]]; then
    log "Patch hub Service NodePort → ${HUB_NODEPORT} (must match PUBLIC_URL port)"
    # Compose holding :43123 will not block NodePort allocation, but hostPort would;
    # still stop compose hub so browsers hitting LAN:43123 hit K8s, not Compose.
    kubectl -n "${K8S_NAMESPACE}" patch svc "${RELEASE_NAME}-hub" --type merge -p \
      "{\"spec\":{\"type\":\"NodePort\",\"ports\":[{\"name\":\"http\",\"port\":43123,\"targetPort\":\"http\",\"nodePort\":${HUB_NODEPORT}}]}}" \
      || warn "NodePort patch failed — check if ${HUB_NODEPORT} is in 30000-32767 (K8s default range) or extend service-node-port-range"
    # Note: nodePort 43123 is OUTSIDE the default 30000-32767 range on stock k8s.
    # k3s often allows it; if patch fails, either:
    #   - use HUB_NODEPORT=30431 and PUBLIC_URL=http://203.0.113.10:30431
    #   - or hostPort on the pod / external LB
  fi

  log "Workloads"
  cmd_status
  log "PUBLIC_URL should match how you open the UI: ${PUBLIC_URL}"
  cat <<EOF
  kubectl -n ${K8S_NAMESPACE} get svc ${RELEASE_NAME}-hub -o wide
  # Fallback: kubectl -n ${K8S_NAMESPACE} port-forward svc/${RELEASE_NAME}-hub 43123:43123
  # Compose still on :43123? → docker compose stop hub
EOF
}

cmd_restore() {
  [[ -n "${BACKUP_DIR}" ]] || die "set BACKUP_DIR to the directory printed by export"
  local dump="${BACKUP_DIR}/heimdall.dump"
  [[ -f "${dump}" ]] || die "missing ${dump} — run export first (same BACKUP_DIR)"
  log "Restore into cluster Postgres"

  local pg_pod
  pg_pod="$(kubectl -n "${K8S_NAMESPACE}" get pods -l 'app.kubernetes.io/component=postgres' -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [[ -z "${pg_pod}" ]]; then
    pg_pod="$(kubectl -n "${K8S_NAMESPACE}" get pods -o name | grep -i postgres | head -1 | sed 's|^pod/||')"
  fi
  [[ -n "${pg_pod}" ]] || die "could not find postgres pod in ${K8S_NAMESPACE}"

  log "Using postgres pod: ${pg_pod}"
  # Stop hub briefly so it does not race migrations (best-effort)
  kubectl -n "${K8S_NAMESPACE}" scale deploy -l 'app.kubernetes.io/component=hub' --replicas=0 2>/dev/null || true
  sleep 3

  local rdir
  rdir="$(kubectl -n "${K8S_NAMESPACE}" exec "${pg_pod}" -- mktemp -d | tr -d '\r\n')"
  [[ "${rdir}" == /tmp/* ]] || die "unexpected temp dir in postgres pod: ${rdir}"
  kubectl -n "${K8S_NAMESPACE}" cp "${dump}" "${pg_pod}:${rdir}/heimdall.dump"
  # Drop/recreate or pg_restore --clean. Prefer restore into empty DB after helm first boot.
  kubectl -n "${K8S_NAMESPACE}" exec -i "${pg_pod}" -- \
    bash -c "pg_restore -U ${PG_USER} -d ${PG_DB} --clean --if-exists --no-owner ${rdir}/heimdall.dump" \
    || kubectl -n "${K8S_NAMESPACE}" exec -i "${pg_pod}" -- \
      bash -c "psql -U ${PG_USER} -d ${PG_DB} -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' && pg_restore -U ${PG_USER} -d ${PG_DB} --no-owner ${rdir}/heimdall.dump"
  kubectl -n "${K8S_NAMESPACE}" exec "${pg_pod}" -- rm -rf "${rdir}" || true

  kubectl -n "${K8S_NAMESPACE}" scale deploy -l 'app.kubernetes.io/component=hub' --replicas=1 2>/dev/null || true
  kubectl -n "${K8S_NAMESPACE}" rollout status deploy -l 'app.kubernetes.io/component=hub' --timeout=180s 2>/dev/null || true

  log "Restore done. Login with the same admin email/password as Compose."
  warn "After restore, stop Compose postgres so only cluster DB is live:"
  warn "  cd ${COMPOSE_DIR} && docker compose stop postgres"
}

cmd_cutover() {
  log "Cutover checks"
  warn_port_clash 43123
  cat <<EOF

1) Open PUBLIC_URL (${PUBLIC_URL:-<set PUBLIC_URL>}) in a browser → login (same admin as Compose).
   Use LAN IP + port, e.g. http://203.0.113.10:43123 — NOT http://heimdall-hub:43123.
2) Dashboard → Clusters → activate cluster id: ${CLUSTER_ID}
3) Fleet should show the in-cluster agent (k8s enabled) with API up / nodes > 0.
4) Confirm agents/org data survived (Security remotes, alert channels).

5) Stop Compose hub + postgres so only cluster DB is live
   (and so Compose does not hold :43123 away from K8s hostPort/NodePort):

   cd ${COMPOSE_DIR}
   docker compose stop hub postgres
   # optional later: docker compose stop agent

6) Rollback if needed (Compose volume was not deleted):
   docker compose up -d
   # use old http://127.0.0.1:43123

EOF
  if [[ -n "${PUBLIC_URL}" ]]; then
    curl -sf -m 10 "${PUBLIC_URL}/api/v1/health" && echo || log "WARN: health not reachable at PUBLIC_URL yet"
  fi
}

cmd_host_agent() {
  cat <<EOF

Optional: keep Docker container monitoring after hub moves to K8s.

Compose agent must point at the NEW hub URL (not http://hub:43123 on the old network).

In ${COMPOSE_DIR}/compose.yaml under agent.environment:

  HEIMDALL_HUB_URL: ${PUBLIC_URL:-http://203.0.113.10:${HUB_NODEPORT:-43123}}
  HEIMDALL_ENABLE_K8S: "false"
  HEIMDALL_BOOTSTRAP_TOKEN: ${BOOTSTRAP_TOKEN}
  HEIMDALL_HOSTNAME: homelab-compose-01

Then:

  cd ${COMPOSE_DIR}
  docker compose up -d agent
  # leave hub/postgres stopped if cutover completed

If the agent lands on the wrong org again (Bootstrap vs wizard), re-run the org UPDATE
from Project notes, or fix wizard adopt-org on a later PR.

EOF
}

cmd_status() {
  log "Status ${K8S_NAMESPACE} (pods/svc/pvc/events) — useful when helm --wait hangs"
  kubectl -n "${K8S_NAMESPACE}" get pods,svc,pvc -o wide 2>/dev/null || \
    kubectl get ns "${K8S_NAMESPACE}" 2>/dev/null || warn "namespace ${K8S_NAMESPACE} missing?"
  echo
  kubectl -n "${K8S_NAMESPACE}" get events --sort-by='.lastTimestamp' 2>/dev/null | tail -40 || true
  echo
  # Common failure modes from homelab
  kubectl -n "${K8S_NAMESPACE}" get pods -o wide 2>/dev/null | grep -E 'ImagePull|ErrImage|CrashLoop|Pending' \
    && warn "Bad pods above — often: forgot images import, or Compose still bound :43123" || true
}

cmd_all() {
  cmd_preflight
  cmd_export
  cmd_images
  cmd_install
  cmd_restore
  cmd_cutover
  cmd_host_agent
}

main() {
  local cmd="${1:-help}"
  shift || true
  case "${cmd}" in
    preflight) cmd_preflight ;;
    export)    cmd_export ;;
    images)    cmd_images ;;
    install)   cmd_install "$@" ;;
    restore)   cmd_restore ;;
    cutover)   cmd_cutover ;;
    host-agent) cmd_host_agent ;;
    status)    cmd_status ;;
    all)       cmd_all ;;
    help|-h|--help) usage ;;
    *) usage; die "unknown command: ${cmd}" ;;
  esac
}

# Sourcing (tests) defines functions only; executing runs the command.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
