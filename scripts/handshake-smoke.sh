#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HUB_PORT="${HUB_PORT:-43123}"
HUB_URL="http://127.0.0.1:${HUB_PORT}"
TOKEN="${HEIMDALL_BOOTSTRAP_TOKEN:-ci-test-token}"
HOSTNAME_VALUE="${HEIMDALL_HOSTNAME:-smoke-agent-01}"
LOG_DIR="$(mktemp -d)"
# Keep the agent's per-agent secret out of the real state dir.
export HEIMDALL_STATE_DIR="${LOG_DIR}/agent-state"
HUB_PID=""

# Agent register → pushSample reads /proc (meminfo, loadavg, mounts). On Darwin
# that path hangs or fails; use scripts/handshake-smoke-linux.sh instead.
if [[ ! -r /proc/meminfo ]]; then
  echo "handshake-smoke.sh: /proc/meminfo not readable (host=$(uname -s))." >&2
  echo "Re-run via: ./scripts/handshake-smoke-linux.sh (docker + linux /proc)." >&2
  exit 2
fi

cleanup() {
  if [[ -n "${HUB_PID}" ]] && kill -0 "${HUB_PID}" 2>/dev/null; then
    kill "${HUB_PID}" 2>/dev/null || true
    wait "${HUB_PID}" 2>/dev/null || true
  fi
  rm -rf "${LOG_DIR}"
}
trap cleanup EXIT

cd "${ROOT}/apps/hub"
if [[ ! -d node_modules ]]; then
  npm ci
fi
if [[ ! -d .next ]]; then
  echo "==> building hub"
  npm run build
fi

echo "==> starting hub on :${HUB_PORT}"
HEIMDALL_BOOTSTRAP_TOKEN="${TOKEN}" \
  HEIMDALL_DB_DRIVER="${HEIMDALL_DB_DRIVER:-pglite}" \
  HEIMDALL_SECRET_KEY="${HEIMDALL_SECRET_KEY:-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef}" \
  HEIMDALL_SESSION_SECRET="${HEIMDALL_SESSION_SECRET:-ci-smoke-session-secret-test-only-not-for-production}" \
  PORT="${HUB_PORT}" \
  npm run start -- --port "${HUB_PORT}" \
  >"${LOG_DIR}/hub.log" 2>&1 &
HUB_PID=$!

echo "==> waiting for hub health"
for _ in $(seq 1 60); do
  if curl -fsS "${HUB_URL}/api/v1/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "${HUB_PID}" 2>/dev/null; then
    echo "hub exited early; log:" >&2
    cat "${LOG_DIR}/hub.log" >&2
    exit 1
  fi
  sleep 1
done

curl -fsS "${HUB_URL}/api/v1/health" | tee "${LOG_DIR}/health.json"
echo

echo "==> agent register + metrics ingest"
cd "${ROOT}/apps/agent"
REGISTER_OUT="$(HEIMDALL_BOOTSTRAP_TOKEN="${TOKEN}" go run ./cmd/agent register \
  --hub "${HUB_URL}" \
  --hostname "${HOSTNAME_VALUE}" 2>&1)"
echo "${REGISTER_OUT}"
AGENT_ID="$(echo "${REGISTER_OUT}" | sed -n 's/^registered agent \([^ ]*\).*/\1/p' | head -1)"
if [[ -z "${AGENT_ID}" ]]; then
  echo "failed to parse agent id from register output" >&2
  exit 1
fi

echo "==> anonymous agent list must be unauthorized"
HTTP_CODE="$(curl -sS -o "${LOG_DIR}/agents.json" -w "%{http_code}" "${HUB_URL}/api/v1/agents" || true)"
if [[ "${HTTP_CODE}" != "401" && "${HTTP_CODE}" != "403" ]]; then
  echo "expected 401/403 for GET /api/v1/agents without session, got ${HTTP_CODE}" >&2
  cat "${LOG_DIR}/agents.json" >&2
  exit 1
fi

echo "==> authenticated heartbeat for ${AGENT_ID}"
curl -fsS -X POST "${HUB_URL}/api/v1/agents/heartbeat" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"agentId\":\"${AGENT_ID}\"}" | tee "${LOG_DIR}/heartbeat.json"
echo

echo "==> per-agent secret: stored 0600, usable as Bearer, re-register does not 409"
SECRET_FILE="${HEIMDALL_STATE_DIR}/agent-secret"
[[ -s "${SECRET_FILE}" ]] || { echo "agent secret was not persisted" >&2; exit 1; }
PERM="$(stat -c %a "${SECRET_FILE}" 2>/dev/null || stat -f %Lp "${SECRET_FILE}")"
[[ "${PERM}" == "600" ]] || { echo "agent secret mode ${PERM}, want 600" >&2; exit 1; }
AGENT_SECRET="$(tr -d "[:space:]" < "${SECRET_FILE}")"
curl -fsS -X POST "${HUB_URL}/api/v1/agents/heartbeat" \
  -H "Authorization: Bearer ${AGENT_SECRET}" \
  -H "Content-Type: application/json" \
  -d "{\"agentId\":\"${AGENT_ID}\"}" >/dev/null
(cd "${ROOT}/apps/agent" && HEIMDALL_BOOTSTRAP_TOKEN="${TOKEN}" go run ./cmd/agent register --hub "${HUB_URL}" --hostname "${HOSTNAME_VALUE}" >/dev/null)

echo "handshake smoke OK"
