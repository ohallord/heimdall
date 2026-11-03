# shellcheck shell=bash
# Shared by deploy-cluster.sh and install-otel-k8s.sh.
#
# helm_reuse_args RELEASE NAMESPACE
#   Sets HELM_REUSE_ARGS to flags that keep the release's values *and* apply new chart defaults.
#   Plain --reuse-values skips new defaults (e.g. nil .Values.otel). Helm >= 3.14 has
#   --reset-then-reuse-values; older Helm gets the prior values through -f (temp file, 0600,
#   removed on exit).
# shellcheck disable=SC2034  # HELM_REUSE_ARGS / HELM_PRIOR_VALUES are read by the caller
helm_reuse_args() {
  local release="$1" ns="$2"
  if helm upgrade --help 2>/dev/null | grep -q -- '--reset-then-reuse-values'; then
    HELM_REUSE_ARGS=(--reset-then-reuse-values)
    return
  fi
  HELM_PRIOR_VALUES="$(mktemp)"
  trap 'rm -f "${HELM_PRIOR_VALUES:-}"' EXIT
  chmod 600 "${HELM_PRIOR_VALUES}"
  helm get values "${release}" -n "${ns}" -o yaml >"${HELM_PRIOR_VALUES}"
  HELM_REUSE_ARGS=(-f "${HELM_PRIOR_VALUES}")
}
