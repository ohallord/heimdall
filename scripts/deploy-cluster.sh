#!/usr/bin/env bash
# Heimdall: build + deploy on an existing Kubernetes release (single-node k3s).
#
# One-shot after git pull on the cluster node:
#   ./scripts/deploy-cluster.sh
#
# Or step by step:
#   ./scripts/deploy-cluster.sh pull
#   ./scripts/deploy-cluster.sh images
#   ./scripts/deploy-cluster.sh helm
#   ./scripts/deploy-cluster.sh restart
#   ./scripts/deploy-cluster.sh verify
#
# Env overrides:
#   HEIMDALL_ROOT / COMPOSE_DIR / HELM_CHART / K8S_NAMESPACE / RELEASE_NAME
#   IMAGE_HUB / IMAGE_AGENT  default heimdall-hub:<gitsha> / heimdall-agent:<gitsha>
#                            (set explicitly to pin; :latest is avoided so k3s
#                            IfNotPresent cannot keep a stale hub)
#   SKIP_GIT_PULL=1          skip `git pull` in `all` / `pull`
#   SKIP_IMAGE_BUILD=1       skip compose build + import (chart-only upgrade)
#   FORCE_NO_CACHE=1         compose build --no-cache (full rebuild)
#   SKIP_HOST_MOUNTS=1       do not pass values-host-mounts.yaml
#   EXTRA_HELM_ARGS          extra args appended to helm upgrade
#   GIT_REMOTE / GIT_BRANCH  default origin / main
#   OTEL_COLLECTOR=1         after `helm`, run install-otel-k8s.sh (needs OTEL_TOKEN_FILE or
#                            OTEL_TOKEN; MODE/LOGS/ENDPOINT pass through)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEIMDALL_ROOT="${HEIMDALL_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
COMPOSE_DIR="${COMPOSE_DIR:-${HEIMDALL_ROOT}/deploy/docker}"
HELM_CHART="${HELM_CHART:-${HEIMDALL_ROOT}/deploy/helm/heimdall}"
HOST_MOUNTS_VALUES="${HOST_MOUNTS_VALUES:-${HELM_CHART}/values-host-mounts.yaml}"
K8S_NAMESPACE="${K8S_NAMESPACE:-heimdall}"
RELEASE_NAME="${RELEASE_NAME:-heimdall}"
SKIP_GIT_PULL="${SKIP_GIT_PULL:-0}"
SKIP_IMAGE_BUILD="${SKIP_IMAGE_BUILD:-0}"
FORCE_NO_CACHE="${FORCE_NO_CACHE:-0}"
SKIP_HOST_MOUNTS="${SKIP_HOST_MOUNTS:-0}"
EXTRA_HELM_ARGS="${EXTRA_HELM_ARGS:-}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
GIT_BRANCH="${GIT_BRANCH:-main}"
OTEL_COLLECTOR="${OTEL_COLLECTOR:-0}"

# shellcheck source=scripts/lib/helm-reuse.sh
source "${SCRIPT_DIR}/lib/helm-reuse.sh"

log()  { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }

compose() {
  # Images only: compose.yaml requires runtime secrets (`${VAR:?}`), which a build never uses.
  # Placeholders keep `docker compose build` interpolating; real values live in the Helm release.
  (cd "${COMPOSE_DIR}" &&
    HEIMDALL_BOOTSTRAP_TOKEN="${HEIMDALL_BOOTSTRAP_TOKEN:-build-only-placeholder}" \
    HEIMDALL_SECRET_KEY="${HEIMDALL_SECRET_KEY:-build-only-placeholder}" \
    docker compose "$@")
}

git_short_sha() {
  git -C "${HEIMDALL_ROOT}" rev-parse --short=12 HEAD 2>/dev/null || date +%Y%m%d%H%M%S
}

# Unique tags per commit: :latest + IfNotPresent can leave a node on a stale hub.
resolve_image_tags() {
  local sha
  sha="$(git_short_sha)"
  IMAGE_HUB="${IMAGE_HUB:-heimdall-hub:${sha}}"
  IMAGE_AGENT="${IMAGE_AGENT:-heimdall-agent:${sha}}"
}

usage() {
  cat <<'EOF'
Heimdall cluster deploy (existing Helm release)

Usage:
  ./scripts/deploy-cluster.sh [command]

Commands:
  all       pull → images → helm → restart → verify  (default)
  pull      git fetch + fast-forward to GIT_BRANCH
  images    docker compose build hub/agent + import into k3s/containerd
  helm      helm upgrade --reset-then-reuse-values (+ host mounts values by default)
  restart   rollout restart hub + agent; wait for ready
  verify    print WATCH_MOUNTS + pod status + MFA copy sanity
  status    kubectl get pods,svc,pvc,events
  help      this text

Examples (on the cluster node, from the repo root):
  ./scripts/deploy-cluster.sh

  # Chart-only (no image rebuild):
  SKIP_IMAGE_BUILD=1 ./scripts/deploy-cluster.sh

  # Full rebuild ignoring Docker layer cache:
  FORCE_NO_CACHE=1 ./scripts/deploy-cluster.sh

  # Already on the commit you want:
  SKIP_GIT_PULL=1 ./scripts/deploy-cluster.sh images helm restart verify
EOF
}

detect_image_runtime() {
  # k3s kubelet reads containerd, never the docker store: if k3s is installed, a failed
  # `sudo k3s ctr` (e.g. no cached sudo credentials) is an error, not a reason to use docker.
  if command -v k3s >/dev/null 2>&1; then
    if sudo k3s ctr version >/dev/null 2>&1; then
      echo "k3s"
    else
      echo "k3s-no-sudo"
    fi
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
    k3s) docker save "${img}" | sudo k3s ctr images import - ;;
    k3s-no-sudo)
      die "k3s is installed but 'sudo k3s ctr version' failed; run 'sudo -v' and retry (images are not in k3s containerd)" ;;
    ctr) docker save "${img}" | sudo ctr -n k8s.io images import - ;;
    docker)
      warn "No k3s/ctr — assuming kubelet shares the docker image store."
      docker image inspect "${img}" >/dev/null \
        || die "docker missing image ${img}"
      ;;
    *) die "cannot detect image import path (need k3s ctr, ctr -n k8s.io, or docker)" ;;
  esac
}

# Unique strings from the current login page (avoid substring false positives like matching
# "Enter Authenticator Code" inside "Enter your authenticator code.").
MFA_NEW_BLURB='Open your authenticator app and enter the 6-digit code'
MFA_OLD_LABEL='children:"TOTP"'

assert_hub_mfa_source() {
  local login="${HEIMDALL_ROOT}/apps/hub/src/app/login/page.tsx"
  log "Verify MFA copy in build context source"
  [[ -f "${login}" ]] || die "missing ${login}"
  if ! grep -Fq "${MFA_NEW_BLURB}" "${login}"; then
    die "${login} missing current MFA copy — run: git fetch && git reset --hard origin/main"
  fi
  if grep -Fq "Enter your authenticator code." "${login}"; then
    die "${login} still has old MFA blurb — working tree is stale"
  fi
  if grep -E '^[[:space:]]*TOTP[[:space:]]*$' "${login}"; then
    die "${login} still has TOTP label — working tree is stale"
  fi
  log "OK — ${login} has current MFA copy"
  git -C "${HEIMDALL_ROOT}" --no-pager log -1 --oneline -- apps/hub/src/app/login/page.tsx || true
}

# Fail closed if the built hub still has outdated MFA copy.
assert_hub_mfa_copy() {
  local img="$1"
  log "Verify MFA copy inside ${img}"
  docker image inspect "${img}" >/dev/null \
    || die "missing image ${img}"
  # Use sh -c so the pattern is one argv (docker --entrypoint grep breaks on spaces).
  if ! docker run --rm --entrypoint sh "${img}" -c \
    "grep -RFq '${MFA_NEW_BLURB}' /app"; then
    die "hub image ${img} missing current MFA blurb — Docker built stale/wrong context"
  fi
  if docker run --rm --entrypoint sh "${img}" -c \
    "grep -RFq '${MFA_OLD_LABEL}' /app || grep -RFq 'children:\\\"TOTP\\\"' /app"; then
    die "hub image ${img} still contains TOTP label — refusing to deploy"
  fi
  log "OK — image has current MFA copy"
}

cmd_pull() {
  if [[ "${SKIP_GIT_PULL}" == "1" ]]; then
    log "SKIP_GIT_PULL=1 — skipping git pull"
    return 0
  fi
  need git
  cd "${HEIMDALL_ROOT}"
  log "Git pull ${GIT_REMOTE}/${GIT_BRANCH}"
  git fetch "${GIT_REMOTE}" "${GIT_BRANCH}"
  local branch
  branch="$(git rev-parse --abbrev-ref HEAD)"
  if [[ "${branch}" != "${GIT_BRANCH}" ]]; then
    warn "on branch ${branch}; checking out ${GIT_BRANCH}"
    git checkout "${GIT_BRANCH}"
  fi
  git merge --ff-only "${GIT_REMOTE}/${GIT_BRANCH}"
  git --no-pager log -1 --oneline
}

cmd_images() {
  if [[ "${SKIP_IMAGE_BUILD}" == "1" || "${SKIP_IMAGE_IMPORT:-0}" == "1" ]]; then
    warn "SKIP_IMAGE_BUILD/SKIP_IMAGE_IMPORT=1 — skipping compose build + import"
    warn "Hub/agent code changes will NOT land until you rebuild. Unset and re-run:"
    warn "  unset SKIP_IMAGE_BUILD SKIP_IMAGE_IMPORT"
    warn "  ./scripts/deploy-cluster.sh images restart"
    return 0
  fi
  need docker
  [[ -d "${COMPOSE_DIR}" ]] || die "missing compose dir: ${COMPOSE_DIR}"
  resolve_image_tags
  assert_hub_mfa_source
  local cachebust
  cachebust="$(git -C "${HEIMDALL_ROOT}" rev-parse HEAD 2>/dev/null || date +%s)"
  log "Build compose images (hub + agent)"
  log "CACHEBUST=${cachebust}"
  log "IMAGE_HUB=${IMAGE_HUB} IMAGE_AGENT=${IMAGE_AGENT}"

  local -a build_args=(build --build-arg "CACHEBUST=${cachebust}" --build-arg "AGENT_VERSION=${cachebust:0:12}")
  if [[ "${FORCE_NO_CACHE}" == "1" ]]; then
    build_args+=(--no-cache)
    log "FORCE_NO_CACHE=1 — full rebuild"
  fi
  build_args+=(hub agent)
  compose "${build_args[@]}"

  # IMPORTANT: do NOT use `compose images -q | head -1` — that can return an
  # older image id and `docker tag` then repoints :latest back to the stale hub
  # (same k3s import digest forever). Compose `image:` already named the build.
  docker image inspect "heimdall-hub:latest" >/dev/null \
    || die "compose build did not produce heimdall-hub:latest"
  docker image inspect "heimdall-agent:latest" >/dev/null \
    || die "compose build did not produce heimdall-agent:latest"

  local hub_id agent_id
  hub_id="$(docker image inspect "heimdall-hub:latest" --format '{{.Id}}')"
  agent_id="$(docker image inspect "heimdall-agent:latest" --format '{{.Id}}')"
  log "Built heimdall-hub:latest id=${hub_id}"
  log "Built heimdall-agent:latest id=${agent_id}"

  # Assert against :latest FIRST (the image compose just built), then stamp gitsha.
  assert_hub_mfa_copy "heimdall-hub:latest"

  docker tag "heimdall-hub:latest" "${IMAGE_HUB}"
  docker tag "heimdall-agent:latest" "${IMAGE_AGENT}"
  log "Tagged ${IMAGE_HUB} ${IMAGE_AGENT}"

  import_image "${IMAGE_HUB}"
  import_image "${IMAGE_AGENT}"
  log "Images ready: ${IMAGE_HUB} ${IMAGE_AGENT}"
}

cmd_helm() {
  need helm
  need kubectl
  resolve_image_tags
  [[ -d "${HELM_CHART}" ]] || die "missing chart: ${HELM_CHART}"
  kubectl get ns "${K8S_NAMESPACE}" >/dev/null 2>&1 \
    || die "namespace ${K8S_NAMESPACE} missing — run migrate install first"
  helm status "${RELEASE_NAME}" -n "${K8S_NAMESPACE}" >/dev/null 2>&1 \
    || die "release ${RELEASE_NAME} not found in ${K8S_NAMESPACE}"

  # Plain --reuse-values ignores new chart defaults (e.g. nil .Values.otel).
  helm_reuse_args "${RELEASE_NAME}" "${K8S_NAMESPACE}"

  local -a args=(
    upgrade "${HELM_REUSE_ARGS[@]}" "${RELEASE_NAME}" "${HELM_CHART}"
    -n "${K8S_NAMESPACE}"
    --set-string "image.hub=${IMAGE_HUB}"
    --set-string "image.agent=${IMAGE_AGENT}"
    --set-string "image.pullPolicy=IfNotPresent"
  )

  if [[ "${SKIP_HOST_MOUNTS}" != "1" && -f "${HOST_MOUNTS_VALUES}" ]]; then
    log "Applying host mounts values: ${HOST_MOUNTS_VALUES}"
    args+=(-f "${HOST_MOUNTS_VALUES}")
  else
    warn "Skipping host mounts values file"
  fi

  # shellcheck disable=SC2206
  if [[ -n "${EXTRA_HELM_ARGS}" ]]; then
    # intentional word-split for caller-provided helm flags
    args+=(${EXTRA_HELM_ARGS})
  fi

  log "Helm upgrade ${RELEASE_NAME} (hub=${IMAGE_HUB} agent=${IMAGE_AGENT})"
  helm "${args[@]}"

  if [[ "${OTEL_COLLECTOR}" == "1" ]]; then
    log "OTEL_COLLECTOR=1 — enabling OTel collector"
    K8S_NAMESPACE="${K8S_NAMESPACE}" RELEASE_NAME="${RELEASE_NAME}" HELM_CHART="${HELM_CHART}" \
      "${SCRIPT_DIR}/install-otel-k8s.sh"
  fi
}

cmd_restart() {
  need kubectl
  log "Rollout restart hub + agent"
  kubectl -n "${K8S_NAMESPACE}" rollout restart \
    "deploy/${RELEASE_NAME}-hub" "deploy/${RELEASE_NAME}-agent"
  kubectl -n "${K8S_NAMESPACE}" rollout status "deploy/${RELEASE_NAME}-hub"
  kubectl -n "${K8S_NAMESPACE}" rollout status "deploy/${RELEASE_NAME}-agent"
}

cmd_verify() {
  need kubectl
  resolve_image_tags
  log "Pods"
  kubectl -n "${K8S_NAMESPACE}" get pods -l "app.kubernetes.io/instance=${RELEASE_NAME}" -o wide 2>/dev/null \
    || kubectl -n "${K8S_NAMESPACE}" get pods

  log "Hub image (expect ${IMAGE_HUB})"
  kubectl -n "${K8S_NAMESPACE}" get "deploy/${RELEASE_NAME}-hub" \
    -o jsonpath='spec={.spec.template.spec.containers[0].image}{"\n"}' 2>/dev/null || true
  kubectl -n "${K8S_NAMESPACE}" get pods -l "app.kubernetes.io/component=hub" \
    -o jsonpath='{range .items[*]}pod={.metadata.name} imageID={.status.containerStatuses[0].imageID}{"\n"}{end}' \
    2>/dev/null || true

  # Distroless agent has no printenv/sh — read the Deployment spec instead.
  log "HEIMDALL_WATCH_MOUNTS (expect /host,/host/var — no /boot)"
  local watch mount_path host_path
  watch="$(
    kubectl -n "${K8S_NAMESPACE}" get "deploy/${RELEASE_NAME}-agent" \
      -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="HEIMDALL_WATCH_MOUNTS")].value}' \
      2>/dev/null || true
  )"
  mount_path="$(
    kubectl -n "${K8S_NAMESPACE}" get "deploy/${RELEASE_NAME}-agent" \
      -o jsonpath='{.spec.template.spec.containers[0].volumeMounts[?(@.name=="host-root")].mountPath}' \
      2>/dev/null || true
  )"
  host_path="$(
    kubectl -n "${K8S_NAMESPACE}" get "deploy/${RELEASE_NAME}-agent" \
      -o jsonpath='{.spec.template.spec.volumes[?(@.name=="host-root")].hostPath.path}' \
      2>/dev/null || true
  )"
  printf 'WATCH_MOUNTS: %s\n' "${watch:-<unset>}"
  printf 'hostPath:     %s → %s\n' "${host_path:-<none>}" "${mount_path:-<none>}"

  if [[ -z "${watch}" ]]; then
    warn "WATCH_MOUNTS unset — re-run helm with values-host-mounts.yaml"
  elif [[ "${watch}" == *"/boot"* ]]; then
    warn "WATCH_MOUNTS still includes /boot — upgrade chart values"
  elif [[ "${watch}" != *"/host"* ]]; then
    warn "WATCH_MOUNTS looks unexpected: ${watch}"
  else
    log "Watch list looks good"
  fi

  log "Done — hard-refresh the browser (current MFA = Enter Authenticator Code, not TOTP)"
}

cmd_status() {
  need kubectl
  kubectl -n "${K8S_NAMESPACE}" get pods,svc,pvc
  # Events: sort by creationTimestamp (events.k8s.io objects have no .lastTimestamp).
  kubectl -n "${K8S_NAMESPACE}" get events --sort-by=.metadata.creationTimestamp | tail -30
}

cmd_all() {
  local before after
  before="$(git -C "${HEIMDALL_ROOT}" rev-parse HEAD:scripts/deploy-cluster.sh 2>/dev/null || true)"
  cmd_pull
  after="$(git -C "${HEIMDALL_ROOT}" rev-parse HEAD:scripts/deploy-cluster.sh 2>/dev/null || true)"
  # Pull may update this script; bash already has old functions in memory.
  if [[ -n "${before}" && -n "${after}" && "${before}" != "${after}" ]]; then
    log "deploy-cluster.sh changed by pull — re-execing with new script"
    exec env SKIP_GIT_PULL=1 FORCE_NO_CACHE="${FORCE_NO_CACHE}" \
      "${HEIMDALL_ROOT}/scripts/deploy-cluster.sh" images helm restart verify
  fi
  cmd_images
  cmd_helm
  cmd_restart
  cmd_verify
}

run_cmd() {
  case "$1" in
    all)     cmd_all ;;
    pull)    cmd_pull ;;
    images)  cmd_images ;;
    helm)    cmd_helm ;;
    restart) cmd_restart ;;
    verify)  cmd_verify ;;
    status)  cmd_status ;;
    help|-h|--help) usage; exit 0 ;;
    *) usage; die "unknown command: $1" ;;
  esac
}

main() {
  if [[ $# -eq 0 ]]; then
    run_cmd all
    return
  fi
  # Allow chaining: ./scripts/deploy-cluster.sh images helm restart verify
  while [[ $# -gt 0 ]]; do
    run_cmd "$1"
    shift
  done
}

# Sourcing (tests) defines functions only; executing runs the commands.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
