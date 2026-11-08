#!/usr/bin/env bash
# Exercises scripts/setup-hostname.sh with stubbed aws/kubectl/nginx/certbot.
# No real DNS, cluster, or certificate changes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/heimdall-hostname.XXXXXX")"
trap 'rm -rf "$T"' EXIT

BIN="$T/bin"
mkdir -p "$BIN" "$T/sites-available" "$T/sites-enabled" "$T/state"
export PATH="$BIN:$PATH"
export SUDO=""
export NGINX_AVAILABLE="$T/sites-available"
export NGINX_ENABLED="$T/sites-enabled"
export HELM_CHART="$ROOT/deploy/helm/heimdall"
export CERTBOT_EMAIL="certbot@example.com"
export DNS_IP="174.29.221.54"

cat >"$BIN/aws" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
log="${HOSTNAME_TEST_LOG:?}"
printf '%s\n' "$*" >>"$log"
if [[ "$1" == "sts" ]]; then exit 0; fi
if [[ "$1" == "route53" && "$2" == "list-hosted-zones-by-name" ]]; then
  printf '%s\n' "/hostedzone/ZTESTZONE"
  exit 0
fi
if [[ "$1" == "route53" && "$2" == "list-resource-record-sets" ]]; then
  name=""
  prev=""
  for a in "$@"; do
    if [[ "$prev" == "--start-record-name" ]]; then name="$a"; fi
    prev="$a"
  done
  state="${HOSTNAME_TEST_STATE:?}"
  if [[ -f "$state/$name" ]]; then cat "$state/$name"; exit 0; fi
  printf '%s\n' "[]"
  exit 0
fi
if [[ "$1" == "route53" && "$2" == "change-resource-record-sets" ]]; then
  batch=""
  prev=""
  for a in "$@"; do
    if [[ "$prev" == "--change-batch" ]]; then batch="${a#file://}"; fi
    prev="$a"
  done
  cp "$batch" "${HOSTNAME_TEST_BATCH:?}"
  printf '%s\n' "/change/CTEST"
  exit 0
fi
if [[ "$1" == "route53" && "$2" == "wait" ]]; then exit 0; fi
if [[ "$1" == "route53" && "$2" == "get-change" ]]; then
  printf '%s\n' "INSYNC"
  exit 0
fi
echo "unexpected aws invocation: $*" >&2
exit 1
EOF

cat >"$BIN/kubectl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${HOSTNAME_TEST_LOG:?}"
if [[ "$*" == *nodePort* ]]; then
  printf '%s\n' "43123"
  exit 0
fi
exit 0
EOF

cat >"$BIN/helm" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${HOSTNAME_TEST_LOG:?}"
if [[ "$1" == "upgrade" && "${2:-}" == "--help" ]]; then
  printf '%s\n' "--reset-then-reuse-values"
  exit 0
fi
if [[ "$1" == "status" ]]; then exit 0; fi
if [[ "$1" == "upgrade" ]]; then
  printf '%s\n' "$*" >"${HOSTNAME_TEST_HELM:?}"
  exit 0
fi
echo "unexpected helm invocation: $*" >&2
exit 1
EOF

cat >"$BIN/nginx" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${HOSTNAME_TEST_LOG:?}"
[[ "${1:-}" == "-t" ]]
EOF

cat >"$BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${HOSTNAME_TEST_LOG:?}"
[[ "$1" == "reload" && "$2" == "nginx" ]]
EOF

cat >"$BIN/certbot" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${HOSTNAME_TEST_CERTBOT:?}"
exit 0
EOF

chmod 755 "$BIN"/*

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

run_case() {
  local name="$1"
  shift
  HOSTNAME_TEST_LOG="$T/state/${name}.log"
  HOSTNAME_TEST_BATCH="$T/state/${name}.batch"
  HOSTNAME_TEST_HELM="$T/state/${name}.helm"
  HOSTNAME_TEST_CERTBOT="$T/state/${name}.certbot"
  HOSTNAME_TEST_STATE="$T/state/records"
  export HOSTNAME_TEST_LOG HOSTNAME_TEST_BATCH HOSTNAME_TEST_HELM HOSTNAME_TEST_CERTBOT HOSTNAME_TEST_STATE
  mkdir -p "$HOSTNAME_TEST_STATE"
  : >"$HOSTNAME_TEST_LOG"
  : >"$HOSTNAME_TEST_CERTBOT"
  printf '==> %s\n' "$name"
  "$ROOT/scripts/setup-hostname.sh" "$@" >"$T/state/${name}.out" 2>"$T/state/${name}.err"
}

# Only the heimdall record is ever listed. Other names are not fixtures.
mkdir -p "$T/state/records"
cat >"$T/state/records/heimdall.drohalloran.net" <<'EOF'
[{"Name":"heimdall.drohalloran.net.","Type":"CNAME","TTL":300,"ResourceRecords":[{"Value":"example.net"}]}]
EOF

# CNAME must be refused before any change.
if run_case cname --dry-run; then
  fail "CNAME name should fail"
fi
grep -q 'has a CNAME' "$T/state/cname.err" || fail "missing CNAME error"
[[ ! -s "$T/state/cname.batch" ]] || fail "CNAME case submitted a change"
rm -f "$T/state/records/heimdall.drohalloran.net"

# Dry run publishes only heimdall and does not submit a change.
run_case dry --dry-run
grep -q 'publishing heimdall.drohalloran.net A 174.29.221.54' "$T/state/dry.out"
grep -q 'would UPSERT heimdall.drohalloran.net A 174.29.221.54' "$T/state/dry.out"
if grep -q 'mcp.drohalloran.net' "$T/state/dry.log" "$T/state/dry.out"; then
  fail "dry-run mentioned another hostname"
fi
grep -q 'would write' "$T/state/dry.out"
grep -q 'would run certbot --nginx -d heimdall.drohalloran.net' "$T/state/dry.out"
grep -q 'HEIMDALL_PUBLIC_URL=https://heimdall.drohalloran.net' "$T/state/dry.out"
if grep -q '^route53 change-resource-record-sets' "$T/state/dry.log"; then
  fail "dry-run submitted a Route 53 change"
fi
[[ ! -f "$NGINX_AVAILABLE/heimdall.drohalloran.net" ]] || fail "dry-run wrote nginx config"

# Apply: one A record, nginx upstream, certbot, helm origin.
run_case apply
[[ -f "$T/state/apply.batch" ]] || fail "apply did not build a change batch"
grep -q 'heimdall.drohalloran.net' "$T/state/apply.batch"
if grep -q 'mcp.drohalloran.net' "$T/state/apply.batch"; then
  fail "change batch mentioned the source name"
fi
python3 - <<'PY' "$T/state/apply.batch"
import json, sys
batch = json.load(open(sys.argv[1]))
changes = batch["Changes"]
assert len(changes) == 1, changes
rr = changes[0]["ResourceRecordSet"]
assert rr["Name"] == "heimdall.drohalloran.net."
assert rr["Type"] == "A"
assert rr["TTL"] == 300
assert rr["ResourceRecords"] == [{"Value": "174.29.221.54"}]
assert "AliasTarget" not in rr
PY
if grep -qE 'mcp|jobs|memory' "$T/state/apply.log" "$T/state/apply.batch"; then
  fail "apply touched another name"
fi
conf="$NGINX_AVAILABLE/heimdall.drohalloran.net"
grep -q 'server_name heimdall.drohalloran.net;' "$conf"
grep -q 'proxy_pass http://203.0.113.10:43123;' "$conf"
grep -q 'client_max_body_size 16m;' "$conf"
[[ -L "$NGINX_ENABLED/heimdall.drohalloran.net" ]] || fail "sites-enabled link missing"
grep -q -- '-d heimdall.drohalloran.net' "$T/state/apply.certbot"
grep -q -- '--email certbot@example.com' "$T/state/apply.certbot"
grep -q 'hub.env.HEIMDALL_PUBLIC_URL=https://heimdall.drohalloran.net' "$T/state/apply.helm"
grep -q 'hub.env.HEIMDALL_RP_ID=heimdall.drohalloran.net' "$T/state/apply.helm"
grep -q 'hub.extraEnv.HEIMDALL_TRUST_PROXY=true' "$T/state/apply.helm"
if grep -E 'HEIMDALL_SESSION_SECRET=|HEIMDALL_BOOTSTRAP_TOKEN=' "$T/state/apply.out" "$T/state/apply.helm"; then
  fail "secret echoed"
fi

# Second apply with the same A record already in place does not change DNS.
cat >"$T/state/records/heimdall.drohalloran.net" <<'EOF'
[{"Name":"heimdall.drohalloran.net.","Type":"A","TTL":300,"ResourceRecords":[{"Value":"174.29.221.54"}]}]
EOF
# Pretend certbot already edited the vhost so a re-run must not wipe it.
printf '\n# managed by Certbot\n' >>"$conf"
before="$(cat "$conf")"
run_case again
grep -q 'already A 174.29.221.54' "$T/state/again.out"
if grep -q '^route53 change-resource-record-sets' "$T/state/again.log"; then
  fail "unchanged record was submitted again"
fi
after="$(cat "$conf")"
[[ "$before" == "$after" ]] || fail "certbot-managed vhost was rewritten"

# A private DNS_IP still only writes heimdall, and skips certbot.
rm -f "$T/state/records/heimdall.drohalloran.net"
rm -f "$conf" "$NGINX_ENABLED/heimdall.drohalloran.net"
DNS_IP=203.0.113.10 run_case lan --skip-public-url
grep -q '203.0.113.10' "$T/state/lan.batch"
grep -q 'skipping certbot HTTP-01' "$T/state/lan.out"
[[ ! -s "$T/state/lan.certbot" ]] || fail "certbot ran for a private address"
grep -q 'proxy_pass http://203.0.113.10:43123;' "$conf"

echo "test-setup-hostname: ok"
