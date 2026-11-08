#!/usr/bin/env bash
# Security review: migrate-compose-to-k8s.sh export writes the DB dump to a private, unpredictable
# directory (umask 077 + mktemp -d), never a fixed /var/tmp or /tmp path; the in-container dump dir
# comes from mktemp too. Docker is stubbed; nothing touches a real stack.
set -euo pipefail
cd "$(dirname "$0")/.."
fail() { echo "FAIL: $*" >&2; exit 1; }
perms() { ls -ld "$1" | cut -c1-10; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/tmp" "$T/compose"
cat >"$T/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >>"$STUB_LOG"
[[ "$1" == compose ]] || exit 0
shift
case "$1" in
  exec)
    if [[ " $* " == *" sh -c "* ]]; then echo "/tmp/tmp.Rand0m"; fi ;;
  cp) dest="${*: -1}"; printf 'PGDMP' >"$dest" ;;
esac
exit 0
EOF
chmod +x "$T/bin/docker"

run_export() {
  env -u BACKUP_DIR PATH="$T/bin:$PATH" STUB_LOG="$T/log" TMPDIR="$T/tmp" COMPOSE_DIR="$T/compose" \
    "$@" bash ./scripts/migrate-compose-to-k8s.sh export >"$T/out" 2>&1 \
    || { cat "$T/out" >&2; fail "export exited non-zero"; }
}

run_export
d=$(find "$T/tmp" -maxdepth 1 -type d -name 'heimdall-migrate.*' | head -1)
[[ -n "$d" ]] || fail "no mktemp backup dir under TMPDIR"
[[ "$d" != *"$(date +%Y%m%d)"* ]] || fail "backup dir name is predictable: $d"
[[ "$(perms "$d")" == drwx------ ]] || fail "backup dir mode $(perms "$d") != 0700"
[[ -f "$d/heimdall.dump" ]] || fail "dump not copied into the backup dir"
[[ "$(perms "$d/heimdall.dump")" == -rw------- ]] || fail "dump mode $(perms "$d/heimdall.dump")"
grep -q 'compose cp postgres:/tmp/tmp.Rand0m/heimdall.dump' "$T/log" || fail "dump not taken from the mktemp dir"
grep -q -- '--file=/tmp/heimdall.dump' "$T/log" && fail "fixed /tmp/heimdall.dump path still used"
grep -q 'export BACKUP_DIR=' "$T/out" || fail "backup dir not printed for restore"
# compose.yaml's required secrets get interpolation placeholders, not real defaults.
grep -q "heimdall-dev-""session" "$T/log" && fail "dev session secret leaked into compose calls"

# Explicit BACKUP_DIR is created private.
run_export BACKUP_DIR="$T/mine"
[[ "$(perms "$T/mine")" == drwx------ ]] || fail "explicit BACKUP_DIR mode $(perms "$T/mine")"

# Placeholder session secrets are refused for the Helm install.
out=$( (export PUBLIC_URL=http://h:1 BOOTSTRAP_TOKEN=b SESSION_SECRET="heimdall-dev-""session-secret-change-me!!"
  # shellcheck source=scripts/migrate-compose-to-k8s.sh
  source ./scripts/migrate-compose-to-k8s.sh; helm_sets) 2>&1) && fail "placeholder SESSION_SECRET accepted"
grep -q 'placeholder' <<<"$out" || fail "placeholder refusal not explained: $out"
# Empty SESSION_SECRET is fine (chart generates one) and is not passed to Helm.
out=$( (export PUBLIC_URL=http://h:1 BOOTSTRAP_TOKEN=b SESSION_SECRET=
  source ./scripts/migrate-compose-to-k8s.sh; helm_sets; printf '%s\n' "${HELM_SET_ARGS[@]}") 2>&1) \
  || fail "empty SESSION_SECRET rejected: $out"
grep -q 'HEIMDALL_SESSION_SECRET' <<<"$out" && fail "empty session secret passed to helm"
echo "ok"
