#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/heimdall-install-server.XXXXXX")"
trap 'rm -rf "$T"' EXIT

# Dry-run compose (default) — no files written under repo
out="$T/dry.txt"
"$ROOT/scripts/install.sh" install --non-interactive --mode compose --dry-run \
  --public-url http://127.0.0.1:43123 --port 43123 --storage postgres \
  >"$out" 2>&1
grep -q 'dry_run=1' "$out"
grep -q 'HEIMDALL_BOOTSTRAP_TOKEN=\[REDACTED\]' "$out"
# no secret-looking long tokens printed
if grep -E 'HEIMDALL_BOOTSTRAP_TOKEN=[A-Za-z0-9/+]{12,}' "$out"; then
  echo "secret leaked in dry-run stdout" >&2
  exit 1
fi
test ! -f "$ROOT/deploy/docker/.env.heimdall"

# Apply into temp config-dir
cfg="$T/compose-out"
"$ROOT/scripts/install.sh" configure --non-interactive --mode compose --apply \
  --config-dir "$cfg" \
  --public-url https://heimdall.example.com --port 43123 --storage postgres --tls on \
  >"$T/apply.txt" 2>&1
test -f "$cfg/.env.heimdall"
stat_mode="$(stat -f '%Lp' "$cfg/.env.heimdall" 2>/dev/null || stat -c '%a' "$cfg/.env.heimdall")"
[[ "$stat_mode" == "600" ]]
grep -q 'HEIMDALL_COOKIE_SECURE=true' "$cfg/.env.heimdall"
grep -q 'HEIMDALL_PUBLIC_URL=https://heimdall.example.com' "$cfg/.env.heimdall"
# apply stdout must not include secret values from the file
if grep -E 'HEIMDALL_BOOTSTRAP_TOKEN=[A-Za-z0-9/+]{8,}' "$T/apply.txt"; then
  echo "secret leaked in apply stdout" >&2
  exit 1
fi

# Generated env satisfies compose.yaml's required secrets; DB password is URL-safe (DATABASE_URL).
grep -Eq '^POSTGRES_PASSWORD=[0-9a-f]{48}$' "$cfg/.env.heimdall" || { echo "POSTGRES_PASSWORD missing or not hex" >&2; exit 1; }
grep -Eq '^HEIMDALL_SECRET_KEY=[0-9a-f]{64}$' "$cfg/.env.heimdall" || { echo "HEIMDALL_SECRET_KEY missing or not 32-byte hex" >&2; exit 1; }
grep -Eq '^HEIMDALL_SESSION_SECRET=.{32,}$' "$cfg/.env.heimdall" || { echo "HEIMDALL_SESSION_SECRET missing/short" >&2; exit 1; }
if docker compose version >/dev/null 2>&1; then
  docker compose -f "$ROOT/deploy/docker/compose.yaml" --env-file "$cfg/.env.heimdall" config --quiet \
    || { echo "compose.yaml does not interpolate with the generated env file" >&2; exit 1; }
fi

# Doctor
"$ROOT/scripts/install.sh" doctor >/dev/null

# Invalid mode fails closed
if "$ROOT/scripts/install.sh" --non-interactive --mode baremetal --dry-run >/dev/null 2>&1; then
  echo "baremetal mode should fail" >&2
  exit 1
fi

# Refuse secret CLI style for enroll is separate; server has no token flags
echo "test-install-server: ok"
