#!/usr/bin/env bash
# Fail if a well-known dev credential appears outside the allowed places.
#  - CHANGE_ME_BOOTSTRAP_TOKEN: the hub's HEIMDALL_DEV=1 branch (lib/agents/bootstrap.ts) + its unit tests,
#    historical phase docs / discussion log.
#  - the dev session secret (heimdall-dev-…-change-me): the hub's dev-only fallback (lib/auth/session*.ts), which refuses it
#    in production; historical docs; .publish/ (snapshot rewrite rules). No deploy path may ship it.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

fail=0
check() {
  local needle="$1" allowed_re="$2" hits
  hits="$(git grep -nIF -e "${needle}" -- . | grep -Ev "${allowed_re}" || true)"
  if [[ -n "${hits}" ]]; then
    echo "ERROR: '${needle}' must not be shipped outside allowed fixtures:" >&2
    echo "${hits}" >&2
    fail=1
  fi
}

check 'CHANGE_ME_BOOTSTRAP_TOKEN' \
  '^(apps/hub/src/lib/agents/bootstrap\.ts|apps/hub/src/lib/agents/bootstrap\.test\.ts|apps/hub/src/lib/db/bootstrap-token\.test\.ts|docs/phases/|docs/discussion-log\.md|\.publish/|scripts/check-no-default-token\.sh|README\.md)'

# Needle split so this file itself passes the publish denylist.
check "heimdall-dev-""session-secret" \
  '^(apps/hub/src/lib/auth/session[^/]*\.ts:|docs/phases/|docs/discussion-log\.md|\.publish/|scripts/check-no-default-token\.sh)'

[[ "${fail}" -eq 0 ]] || exit 1
echo "ok: no shipped default token or session secret"
