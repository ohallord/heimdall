#!/usr/bin/env bash
# Regression: `deploy-cluster.sh helm` must merge new chart defaults into reused release values.
# Plain --reuse-values dropped Phase 27's `otel:` defaults → nil pointer at .Values.otel.collector.
set -euo pipefail
cd "$(dirname "$0")/.."
fail() { echo "FAIL: $*" >&2; exit 1; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"
cat >"$T/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$T/bin/helm" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  status) exit 0 ;;
  get) echo "hub: {env: {HEIMDALL_BOOTSTRAP_TOKEN: prior}}" ;;
  upgrade)
    if [[ " $* " == *" --help "* ]]; then
      [[ "${STUB_RESET_FLAG:-1}" == 1 ]] && echo "      --reset-then-reuse-values   reset to chart defaults, then reuse last release's values"
      exit 0
    fi
    printf '%s\n' "$@" >"$STUB_LOG"
    for ((i = 1; i <= $#; i++)); do
      [[ "${!i}" == -f ]] && { j=$((i + 1)); cat "${!j}" >>"$STUB_LOG.files"; }
    done
    ;;
esac
exit 0
EOF
chmod +x "$T/bin/"*

run() {
  STUB_LOG="$T/args" PATH="$T/bin:$PATH" SKIP_HOST_MOUNTS=1 IMAGE_HUB=h:1 IMAGE_AGENT=a:1 \
    ./scripts/deploy-cluster.sh helm >"$T/out" 2>&1 || { cat "$T/out" >&2; fail "deploy-cluster.sh helm exited non-zero"; }
}

# Helm with --reset-then-reuse-values (>=3.14): use it, never bare --reuse-values.
rm -f "$T/args"*; STUB_RESET_FLAG=1 run
grep -qx -- '--reset-then-reuse-values' "$T/args" || fail "missing --reset-then-reuse-values"
grep -qx -- '--reuse-values' "$T/args" && fail "bare --reuse-values drops new chart defaults"

# Older Helm: fall back to prior release values passed via -f (chart defaults still apply).
rm -f "$T/args"*; STUB_RESET_FLAG=0 run
grep -qx -- '--reuse-values' "$T/args" && fail "fallback used bare --reuse-values"
grep -q 'HEIMDALL_BOOTSTRAP_TOKEN: prior' "$T/args.files" 2>/dev/null || fail "fallback did not pass prior values"
echo "ok"
