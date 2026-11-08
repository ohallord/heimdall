#!/usr/bin/env bash
# Installer + publish gate unit tests (sandbox only; no real deploy/push).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

fail=0
run() {
  local name="$1"
  shift
  echo "==> $name"
  if "$@"; then
    echo "PASS $name"
  else
    echo "FAIL $name" >&2
    fail=$((fail + 1))
  fi
}

run shellcheck-installers shellcheck -x \
  -P scripts/lib \
  scripts/install.sh \
  scripts/enroll-agent.sh \
  scripts/lib/heimdall-common.sh \
  scripts/publish.sh \
  scripts/setup-hostname.sh

run setup-hostname \
  ./scripts/tests/test-setup-hostname.sh

run install-server-dry-run \
  ./scripts/tests/test-install-server.sh

run enroll-agent-dry-run \
  ./scripts/tests/test-enroll-agent.sh

run publish-push-refusal \
  ./scripts/tests/test-publish-gates.sh

if [[ "$fail" -ne 0 ]]; then
  echo "FAILED $fail test group(s)" >&2
  exit 1
fi
echo "All scripts/tests groups passed"
