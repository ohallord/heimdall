#!/usr/bin/env bash
# Regression: with k3s installed but `sudo k3s ctr` failing (no cached sudo credentials),
# deploy-cluster.sh fell back to the docker image store, printed "Images ready", and the
# rollout hit ImagePullBackOff. Import must fail before any restart.
set -euo pipefail
cd "$(dirname "$0")/.."
fail() { echo "FAIL: $*" >&2; exit 1; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"
stub() { printf '#!/usr/bin/env bash\n%s\n' "$2" >"$T/bin/$1"; chmod +x "$T/bin/$1"; }
stub k3s    'exit 0'
stub docker 'echo "docker $*" >>"$STUB_LOG"; exit 0'

# shellcheck source=scripts/deploy-cluster.sh
run_import() { ( PATH="$T/bin:$PATH" STUB_LOG="$T/log"; export PATH STUB_LOG
  source ./scripts/deploy-cluster.sh; import_image heimdall-hub:test ) >"$T/out" 2>&1; }

# k3s present, sudo fails: must exit non-zero, name the sudo problem, never claim docker.
stub sudo 'echo "sudo: interactive authentication is required" >&2; exit 1'
rm -f "$T/log"
run_import && { cat "$T/out" >&2; fail "import succeeded although sudo k3s ctr failed"; }
grep -q 'runtime=docker' "$T/out" && { cat "$T/out" >&2; fail "fell back to docker with k3s installed"; }
grep -qi 'sudo' "$T/out" || { cat "$T/out" >&2; fail "error does not mention sudo"; }

# k3s present, sudo works: imports through k3s ctr.
stub sudo 'echo "sudo $*" >>"$STUB_LOG"; [[ "$1 $2 $3" == "k3s ctr images" ]] && cat >/dev/null; exit 0'
rm -f "$T/log"
run_import || { cat "$T/out" >&2; fail "import via k3s failed"; }
grep -q 'sudo k3s ctr images import' "$T/log" || { cat "$T/log" >&2; fail "did not import via k3s ctr"; }
echo "ok"
