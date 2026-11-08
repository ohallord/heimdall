#!/usr/bin/env bash
# Linux-container handshake smoke for hosts without /proc (e.g. macOS).
# Prefers a prebuilt hub (.next/standalone from npm run build). Never pushes.
# Synthetic tokens only.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOKEN="${HEIMDALL_BOOTSTRAP_TOKEN:-ci-test-token}"
SESSION="${HEIMDALL_SESSION_SECRET:-snapshot-gate-session-secret-not-for-prod}"
SECRET_KEY="${HEIMDALL_SECRET_KEY:-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef}"
ART_OUT="${ART_OUT:-}"
HUB_NAME="heimdall-smoke-hub-$$"
AGENT_NAME="heimdall-smoke-agent-$$"
NET="heimdall-smoke-$$"
STAGE=""

if ! command -v docker >/dev/null 2>&1; then
  echo "docker required for linux handshake smoke" >&2
  exit 2
fi

STANDALONE="${ROOT}/apps/hub/.next/standalone"
if [[ ! -f "${STANDALONE}/server.js" ]]; then
  echo "hub standalone missing at ${STANDALONE}/server.js — run npm run build first" >&2
  exit 2
fi

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/heimdall-smoke-stage.XXXXXX")"
# Single writable tree: nested :ro mounts into a :ro rootfs fail on Docker Desktop.
cp -a "${STANDALONE}/." "${STAGE}/"
mkdir -p "${STAGE}/.next/static" "${STAGE}/public" "${STAGE}/db"
if [[ -d "${ROOT}/apps/hub/.next/static" ]]; then
  cp -a "${ROOT}/apps/hub/.next/static/." "${STAGE}/.next/static/"
fi
if [[ -d "${ROOT}/apps/hub/public" ]]; then
  cp -a "${ROOT}/apps/hub/public/." "${STAGE}/public/"
fi
if [[ -d "${ROOT}/apps/hub/db" ]]; then
  cp -a "${ROOT}/apps/hub/db/." "${STAGE}/db/"
fi

docker network create "$NET" >/dev/null
cleanup() {
  docker rm -f "$HUB_NAME" >/dev/null 2>&1 || true
  docker rm -f "$AGENT_NAME" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$STAGE"
}
trap cleanup EXIT

echo "==> starting prebuilt hub in linux container (${HUB_NAME})"
docker run -d --name "$HUB_NAME" --network "$NET" \
  -e HEIMDALL_BOOTSTRAP_TOKEN="$TOKEN" \
  -e HEIMDALL_DB_DRIVER=pglite \
  -e HEIMDALL_SESSION_SECRET="$SESSION" \
  -e HEIMDALL_SECRET_KEY="$SECRET_KEY" \
  -e PORT=43123 \
  -e HOSTNAME=0.0.0.0 \
  -v "${STAGE}:/app" \
  -w /app \
  node:22-bookworm-slim \
  node server.js >/dev/null

echo "==> waiting for hub health"
for i in $(seq 1 60); do
  if docker run --rm --network "$NET" curlimages/curl:8.5.0 \
    -fsS "http://${HUB_NAME}:43123/api/v1/health" >/dev/null 2>&1; then
    echo "hub healthy after ${i}s"
    break
  fi
  if [[ "$i" -eq 60 ]]; then
    echo "hub never became healthy" >&2
    docker logs "$HUB_NAME" 2>&1 | tail -50 >&2 || true
    exit 1
  fi
  sleep 1
done

echo "==> agent register + metrics on linux (/proc present)"
OUT="$(HEIMDALL_BOOTSTRAP_TOKEN="$TOKEN" docker run --rm --name "$AGENT_NAME" --network "$NET" \
  -e HEIMDALL_STATE_DIR=/tmp/agent-state \
  -e HEIMDALL_BOOTSTRAP_TOKEN \
  -v "${ROOT}/apps/agent:/src" \
  -w /src \
  golang:1.26-bookworm \
  bash -c "go run ./cmd/agent register --hub http://${HUB_NAME}:43123 --hostname smoke-linux-01" 2>&1)" || {
  printf '%s\n' "$OUT" >&2
  echo "linux agent register failed" >&2
  exit 1
}
printf '%s\n' "$OUT"
echo "$OUT" | grep -q 'registered agent' || { echo "missing registered agent line" >&2; exit 1; }
echo "$OUT" | grep -q 'metrics ingest ok' || { echo "missing metrics ingest ok" >&2; exit 1; }

if [[ -n "$ART_OUT" ]]; then
  mkdir -p "$ART_OUT"
  printf '%s\n' "$OUT" >"$ART_OUT/handshake-linux.txt"
fi
echo "linux handshake smoke OK"
