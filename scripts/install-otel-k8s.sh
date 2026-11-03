#!/usr/bin/env bash
# Enable the Heimdall OTel collector on an existing Helm release.
#
#   OTEL_TOKEN_FILE=~/hdo.txt ./scripts/install-otel-k8s.sh
#
# Creates/updates Secret heimdall-otel (key otel-token) via `kubectl apply -f -` so the token never
# appears in helm or kubectl argv, then upgrades the release keeping its values plus new chart
# defaults, and waits for the rollout.
#
# Env:
#   OTEL_TOKEN_FILE / OTEL_TOKEN   hdo_… ingest token (file preferred)
#   MODE       daemonset (default) | sidecar
#   LOGS       true (default) | false   tail /var/log/pods (daemonset only)
#   ENDPOINT   hub origin; default = in-cluster hub Service
#   K8S_NAMESPACE / RELEASE_NAME / HELM_CHART   default heimdall / heimdall / deploy/helm/heimdall
#   SECRET_NAME   default heimdall-otel
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/helm-reuse.sh
source "${SCRIPT_DIR}/lib/helm-reuse.sh"
# shellcheck source=scripts/lib/otel-token.sh
source "${SCRIPT_DIR}/lib/otel-token.sh"

K8S_NAMESPACE="${K8S_NAMESPACE:-heimdall}"
RELEASE_NAME="${RELEASE_NAME:-heimdall}"
HELM_CHART="${HELM_CHART:-${SCRIPT_DIR}/../deploy/helm/heimdall}"
SECRET_NAME="${SECRET_NAME:-heimdall-otel}"
MODE="${MODE:-daemonset}"
LOGS="${LOGS:-true}"
ENDPOINT="${ENDPOINT:-}"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '\n==> %s\n' "$*"; }

case "${1:-}" in -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;; esac
case "${MODE}" in daemonset|sidecar) ;; *) die "MODE must be daemonset or sidecar (got ${MODE})" ;; esac
case "${LOGS}" in true|false) ;; *) die "LOGS must be true or false (got ${LOGS})" ;; esac
read_otel_token || exit 2
command -v helm >/dev/null || die "missing command: helm"
command -v kubectl >/dev/null || die "missing command: kubectl"
helm status "${RELEASE_NAME}" -n "${K8S_NAMESPACE}" >/dev/null 2>&1 \
  || die "release ${RELEASE_NAME} not found in ${K8S_NAMESPACE}"

log "Secret ${K8S_NAMESPACE}/${SECRET_NAME}"
kubectl -n "${K8S_NAMESPACE}" apply -f - <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: ${SECRET_NAME}
  labels:
    app.kubernetes.io/part-of: heimdall
type: Opaque
data:
  otel-token: $(printf '%s' "${OTEL_TOKEN}" | base64 | tr -d '\n')
EOF

helm_reuse_args "${RELEASE_NAME}" "${K8S_NAMESPACE}"
args=(
  upgrade "${HELM_REUSE_ARGS[@]}" "${RELEASE_NAME}" "${HELM_CHART}" -n "${K8S_NAMESPACE}"
  --set otel.collector.enabled=true
  --set-string "otel.collector.existingSecret.name=${SECRET_NAME}"
  --set-string otel.collector.existingSecret.key=otel-token
  --set-string "otel.collector.mode=${MODE}"
  --set "otel.collector.logs=${LOGS}"
)
[[ -n "${ENDPOINT}" ]] && args+=(--set-string "otel.collector.endpoint=${ENDPOINT}")

log "Helm upgrade ${RELEASE_NAME} (collector mode=${MODE} logs=${LOGS})"
helm "${args[@]}"

if [[ "${MODE}" == daemonset ]]; then
  target=ds/heimdall-otelcol
else
  target=deploy/heimdall-agent
fi
log "Rollout ${target}"
kubectl -n "${K8S_NAMESPACE}" rollout status "${target}" --timeout=180s
log "Done. Check Dashboard → Network → Recent OTEL points."
