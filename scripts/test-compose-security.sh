#!/usr/bin/env bash
# Security review: Compose ships no default secrets, Postgres is loopback-only, agents hold no
# capabilities, and deploy-cluster.sh's image build still interpolates without runtime secrets.
# Needs only the docker compose CLI (`config` does not talk to the daemon).
set -euo pipefail
cd "$(dirname "$0")/.."
fail() { echo "FAIL: $*" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "skip: docker compose not installed"; exit 0; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
F=deploy/docker/compose.yaml
cfg() { (cd "$T" && env -i PATH="$PATH" HOME="$HOME" "$@" docker compose -f "$OLDPWD/$F" --project-directory "$T" config 2>&1); }

# Each runtime secret is required (no shipped default).
base=(HEIMDALL_BOOTSTRAP_TOKEN=b HEIMDALL_SECRET_KEY=k HEIMDALL_SESSION_SECRET=s POSTGRES_PASSWORD=p)
for v in HEIMDALL_SESSION_SECRET POSTGRES_PASSWORD; do
  args=()
  for kv in "${base[@]}"; do [[ "$kv" == "$v="* ]] || args+=("$kv"); done
  out=$(cfg "${args[@]}") && fail "compose rendered without $v"
  grep -q "$v" <<<"$out" || fail "missing $v error does not name it: $out"
done

out=$(cfg "${base[@]}" POSTGRES_PASSWORD=pgsecret123 HEIMDALL_SESSION_SECRET=sess-test-only) || fail "compose config: $out"
grep -q 'heimdall-dev-''session-secret' <<<"$out" && fail "default session secret in compose"
grep -q 'HEIMDALL_SESSION_SECRET: sess-test-only' <<<"$out" || fail "session secret not from env"
grep -q 'POSTGRES_PASSWORD: pgsecret123' <<<"$out" || fail "postgres password not from env"
grep -q 'postgres://heimdall:pgsecret123@postgres:5432/heimdall' <<<"$out" || fail "DATABASE_URL not built from POSTGRES_PASSWORD"
grep -q 'postgres://heimdall:CHANGE_ME_DB_PASSWORD@' <<<"$out" && fail "legacy hardcoded DATABASE_URL"
grep -B3 'published: "54329"' <<<"$out" | grep -q 'host_ip: 127.0.0.1' || fail "postgres port not bound to 127.0.0.1"
n=$(grep -c 'no-new-privileges:true' <<<"$out") || true
[[ "$n" -ge 1 ]] || fail "agent lacks no-new-privileges"
grep -A1 'cap_drop:' <<<"$out" | grep -q -- '- ALL' || fail "agent does not drop all capabilities"

# Posture profile: still no-new-privileges, only DAC_READ_SEARCH added back.
out=$(cfg "${base[@]}" COMPOSE_PROFILES=with-trivy) || fail "posture profile config: $out"
[[ $(grep -c 'no-new-privileges:true' <<<"$out") -ge 2 ]] || fail "agent-posture lacks no-new-privileges"
grep -A1 'cap_add:' <<<"$out" | grep -q -- '- DAC_READ_SEARCH' || fail "agent-posture cap_add"
grep -qE 'SYS_ADMIN|NET_ADMIN|privileged: true' <<<"$out" && fail "agent-posture gained broad privileges"

# deploy-cluster.sh (private repo only) builds images with no runtime secrets in the environment.
if [[ -f scripts/deploy-cluster.sh ]]; then
  out=$( (export COMPOSE_DIR="$PWD/deploy/docker"; unset HEIMDALL_BOOTSTRAP_TOKEN HEIMDALL_SECRET_KEY HEIMDALL_SESSION_SECRET POSTGRES_PASSWORD
    # shellcheck source=scripts/deploy-cluster.sh
    source ./scripts/deploy-cluster.sh; compose config --quiet) 2>&1) || fail "deploy-cluster compose() no longer interpolates: $out"
fi
echo "ok"
