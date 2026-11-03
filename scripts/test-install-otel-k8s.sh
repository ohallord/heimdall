#!/usr/bin/env bash
# Tests install-otel-k8s.sh with helm/kubectl stubs.
# The token goes to kubectl on stdin only — never into any argv (helm or kubectl).
set -euo pipefail
cd "$(dirname "$0")/.."
fail() { echo "FAIL: $*" >&2; exit 1; }

TOKEN=hdo_k8s_secret_token
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"
printf '%s\n' "$TOKEN" >"$T/token"

cat >"$T/bin/kubectl" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$T/kubectl.argv"
if [[ " \$* " == *" -f - "* ]]; then cat >>"$T/kubectl.stdin"; fi
exit 0
EOF
cat >"$T/bin/helm" <<EOF
#!/usr/bin/env bash
case "\$1" in
  status) exit 0 ;;
  get) echo "hub: {env: {HEIMDALL_BOOTSTRAP_TOKEN: prior}}" ;;
  upgrade)
    if [[ " \$* " == *" --help "* ]]; then
      [[ "\${STUB_RESET_FLAG:-1}" == 1 ]] && echo "      --reset-then-reuse-values   reset, then reuse"
      exit 0
    fi
    { printf '%s\n' "\$@"; echo ---; } >>"$T/helm.argv"
    for ((i = 1; i <= \$#; i++)); do
      [[ "\${!i}" == -f ]] && { j=\$((i + 1)); cat "\${!j}" >>"$T/helm.files"; }
    done
    ;;
esac
exit 0
EOF
chmod +x "$T/bin/"*

reset() { rm -f "$T"/*.argv "$T"/*.stdin "$T"/*.files; }
run() {
  env PATH="$T/bin:$PATH" OTEL_TOKEN_FILE="$T/token" "$@" ./scripts/install-otel-k8s.sh >"$T/out" 2>&1 \
    || { cat "$T/out" >&2; fail "install-otel-k8s.sh exited non-zero ($*)"; }
}
has_arg() { grep -qx -- "$1" "$T/helm.argv" || fail "helm missing arg: $1"; }

# --- default: daemonset, logs on, reset-then-reuse ---
reset; run
grep -q 'apply -f -' "$T/kubectl.argv" || fail "Secret not applied via kubectl stdin"
grep -q 'name: heimdall-otel$' "$T/kubectl.stdin" || fail "Secret name not heimdall-otel"
grep -q 'otel-token:' "$T/kubectl.stdin" || fail "Secret key not otel-token"
grep -q "$(printf %s "$TOKEN" | base64 | tr -d '\n')" "$T/kubectl.stdin" || fail "Secret does not carry token"
grep -q "$TOKEN" "$T/helm.argv" && fail "token in helm argv"
grep -q "$TOKEN" "$T/kubectl.argv" && fail "token in kubectl argv"
grep -q "$TOKEN" "$T/out" && fail "token printed"
has_arg --reset-then-reuse-values
grep -qx -- '--reuse-values' "$T/helm.argv" && fail "bare --reuse-values"
has_arg otel.collector.enabled=true
has_arg otel.collector.existingSecret.name=heimdall-otel
has_arg otel.collector.mode=daemonset
has_arg otel.collector.logs=true
grep -q 'otel.collector.endpoint' "$T/helm.argv" && fail "endpoint set without ENDPOINT"
grep -q 'rollout status ds/heimdall-otelcol' "$T/kubectl.argv" || fail "no rollout status for DaemonSet"

# --- sidecar, logs off, explicit endpoint ---
reset; run MODE=sidecar LOGS=false ENDPOINT=https://hub.example.com
has_arg otel.collector.mode=sidecar
has_arg otel.collector.logs=false
has_arg otel.collector.endpoint=https://hub.example.com
grep -q 'rollout status deploy/heimdall-agent' "$T/kubectl.argv" || fail "no rollout status for agent (sidecar)"

# --- old Helm: fallback to prior values via -f ---
reset; run STUB_RESET_FLAG=0
grep -qx -- '--reuse-values' "$T/helm.argv" && fail "fallback used bare --reuse-values"
grep -qx -- '--reset-then-reuse-values' "$T/helm.argv" && fail "fallback used unsupported flag"
grep -q 'HEIMDALL_BOOTSTRAP_TOKEN: prior' "$T/helm.files" || fail "fallback did not pass prior values"

# --- OTEL_TOKEN also accepted; bad MODE / missing token rejected ---
reset; env PATH="$T/bin:$PATH" OTEL_TOKEN=hdo_env ./scripts/install-otel-k8s.sh >"$T/out" 2>&1 || fail "OTEL_TOKEN rejected"
grep -q hdo_env "$T/helm.argv" "$T/kubectl.argv" && fail "OTEL_TOKEN in argv"
if env PATH="$T/bin:$PATH" OTEL_TOKEN=x MODE=bogus ./scripts/install-otel-k8s.sh >"$T/out" 2>&1; then fail "bad MODE accepted"; fi
if env PATH="$T/bin:$PATH" ./scripts/install-otel-k8s.sh >"$T/out" 2>&1; then fail "missing token accepted"; fi

# --- deploy-cluster.sh helm with OTEL_COLLECTOR=1 calls the installer ---
reset
env PATH="$T/bin:$PATH" OTEL_COLLECTOR=1 OTEL_TOKEN_FILE="$T/token" SKIP_HOST_MOUNTS=1 IMAGE_HUB=h:1 IMAGE_AGENT=a:1 \
  ./scripts/deploy-cluster.sh helm >"$T/out" 2>&1 || { cat "$T/out" >&2; fail "deploy-cluster.sh helm OTEL_COLLECTOR=1 failed"; }
grep -qx 'otel.collector.enabled=true' "$T/helm.argv" || fail "OTEL_COLLECTOR=1 did not enable collector"
grep -q 'apply -f -' "$T/kubectl.argv" || fail "OTEL_COLLECTOR=1 did not create Secret"
grep -q "$TOKEN" "$T/helm.argv" && fail "token in helm argv via deploy-cluster"

reset
env PATH="$T/bin:$PATH" SKIP_HOST_MOUNTS=1 IMAGE_HUB=h:1 IMAGE_AGENT=a:1 ./scripts/deploy-cluster.sh helm >"$T/out" 2>&1 \
  || { cat "$T/out" >&2; fail "deploy-cluster.sh helm failed"; }
grep -q 'otel.collector' "$T/helm.argv" && fail "collector enabled without OTEL_COLLECTOR=1"
echo "ok"
