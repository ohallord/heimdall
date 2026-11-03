#!/usr/bin/env bash
# Fail if the well-known dev bootstrap token appears outside the allowed places.
# Allowed: the hub's HEIMDALL_DEV=1 branch (lib/agents/bootstrap.ts) + its unit tests. README.md may document it for local development.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

needle='heimdall-dev-token'
allowed_re='^(apps/hub/src/lib/agents/bootstrap\.ts|apps/hub/src/lib/agents/bootstrap\.test\.ts|apps/hub/src/lib/db/bootstrap-token\.test\.ts|scripts/check-no-default-token\.sh|README\.md)'

hits="$(git grep -nI -e "${needle}" -- . | grep -Ev "${allowed_re}" || true)"
if [[ -n "${hits}" ]]; then
  echo "ERROR: '${needle}' must not be shipped outside allowed fixtures:" >&2
  echo "${hits}" >&2
  exit 1
fi
echo "ok: no shipped default token"
