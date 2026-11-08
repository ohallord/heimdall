#!/usr/bin/env bash
# Phase 31: install-host.sh (the `curl <hub>/install.sh | sudo bash` bootstrapper) without root or
# network. build-dist.sh (FAKE_AGENT=1) produces the hub dist dir; it is served via file://.
# systemctl/useradd/groupadd/getent/uname are stubbed and everything installs under DESTDIR.
set -euo pipefail
cd "$(dirname "$0")/.."
fail() { echo "FAIL: $*" >&2; exit 1; }
perms() { ls -l "$1" | cut -c1-10; }

TOKEN=hdt_secret_never_on_argv
OTOKEN=hdo_secret_never_on_argv
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/hub"
printf '%s\n' "$TOKEN" >"$T/token"

# --- dist: real scripts/units, fake agent binaries, manifest ---
FAKE_AGENT=1 AGENT_VERSION=9.9.9-test ./scripts/build-dist.sh "$T/hub/downloads" >"$T/out" 2>&1 \
  || { cat "$T/out" >&2; fail "build-dist.sh failed"; }
M="$T/hub/downloads/SHA256SUMS"
for f in heimdall-agent-linux-amd64 heimdall-agent-linux-arm64 install-host.sh install-agent.sh \
  install-otelcol.sh otel-token.sh heimdall-agent.service heimdall-otelcol.service collector-baremetal.yaml; do
  grep -q "  $f\$" "$M" || fail "manifest missing $f"
  [[ -f "$T/hub/downloads/$f" ]] || fail "dist missing $f"
done
"$T/hub/downloads/heimdall-agent-linux-arm64" version | grep -q 'arm64 9.9.9-test' || fail "fake arm64 binary/version"
(cd "$T/hub/downloads" && if command -v sha256sum >/dev/null; then sha256sum -c --quiet SHA256SUMS; else shasum -a 256 -c --quiet SHA256SUMS; fi) \
  || fail "SHA256SUMS does not verify"

# --- stubs ---
for cmd in systemctl useradd groupadd usermod; do
  printf '#!/usr/bin/env bash\necho "%s $*" >>"%s/argv.log"\nexit 0\n' "$cmd" "$T" >"$T/bin/$cmd"
done
cat >"$T/bin/getent" <<'EOF'
#!/usr/bin/env bash
# no heimdall user/group yet; a docker group only when STUB_DOCKER_GROUP=1
[[ "$1 $2" == "group docker" && "${STUB_DOCKER_GROUP:-0}" == 1 ]] && { echo "docker:x:999:"; exit 0; }
exit 2
EOF
cat >"$T/bin/uname" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == -m ]]; then echo "${STUB_ARCH:-x86_64}"; else exec /usr/bin/uname "$@"; fi
EOF
printf '#!/bin/sh\necho fake-otelcol\n' >"$T/otelcol"
chmod +x "$T/bin/"* "$T/otelcol"

host() { # root, then extra env, then args
  local root="$1"; shift
  # file:// is not https, so the sandbox hub needs the insecure opt-in.
  env PATH="$T/bin:$PATH" DESTDIR="$root" HUB_URL="file://$T/hub" HEIMDALL_TTY=/nonexistent \
    HEIMDALL_ALLOW_INSECURE=1 HOSTNAME_VALUE=lab-01 "$@"
}

# --- install from TOKEN_FILE (x86_64 → amd64) ---
R="$T/root"
host "$R" TOKEN_FILE="$T/token" bash ./scripts/install-host.sh >"$T/out" 2>&1 \
  || { cat "$T/out" >&2; fail "install exited non-zero"; }
B="$R/usr/local/bin/heimdall-agent"; E="$R/etc/heimdall/agent.env"
U="$R/etc/systemd/system/heimdall-agent.service"
[[ -x "$B" ]] || fail "agent binary not installed"
"$B" version | grep -q '^fake-heimdall-agent amd64' || fail "wrong arch binary for x86_64"
[[ "$(perms "$E")" == -rw------- ]] || fail "agent.env mode $(perms "$E") != 0600"
grep -qx "HEIMDALL_BOOTSTRAP_TOKEN=$TOKEN" "$E" || fail "token missing from agent.env"
grep -qx "HEIMDALL_HUB_URL=file://$T/hub" "$E" || fail "hub url missing from agent.env"
grep -qx "HEIMDALL_HOSTNAME=lab-01" "$E" || fail "hostname not passed through"
grep -qx "HEIMDALL_ALLOW_INSECURE=1" "$E" || fail "insecure opt-in not carried into agent.env (agent would refuse the hub)"
cmp -s "$U" deploy/systemd/heimdall-agent.service || fail "agent unit not installed"
[[ -d "$R/var/lib/heimdall" ]] || fail "state dir not created"
grep -qx "systemctl enable heimdall-agent.service" "$T/argv.log" || fail "unit not enabled"
grep -qx "systemctl restart heimdall-agent.service" "$T/argv.log" || fail "agent not (re)started, so a reinstall keeps the old binary"
grep -q "usermod" "$T/argv.log" && fail "usermod without a docker group"
grep -q 'useradd --system' "$T/argv.log" || fail "heimdall user not created"
[[ -e "$R/etc/systemd/system/heimdall-otelcol.service" ]] && fail "collector installed without OTel token"
grep -q "$TOKEN" "$T/argv.log" && fail "token on argv"
grep -q "$TOKEN" "$T/out" && fail "token printed"

# --- TOKEN env, arm64, plus collector via OTEL_TOKEN (offline OTELCOL_BIN) ---
: >"$T/argv.log"
R2="$T/root2"
host "$R2" STUB_ARCH=aarch64 TOKEN="$TOKEN" OTEL_TOKEN="$OTOKEN" OTELCOL_BIN="$T/otelcol" \
  LOG_UNITS=sshd.service bash ./scripts/install-host.sh >"$T/out" 2>&1 \
  || { cat "$T/out" >&2; fail "install with collector exited non-zero"; }
"$R2/usr/local/bin/heimdall-agent" version | grep -q '^fake-heimdall-agent arm64' || fail "wrong arch for aarch64"
OE="$R2/etc/heimdall/otel.env"
[[ "$(perms "$OE")" == -rw------- ]] || fail "otel.env mode"
grep -qx "HEIMDALL_OTEL_TOKEN=$OTOKEN" "$OE" || fail "otel token missing"
[[ -f "$R2/etc/systemd/system/heimdall-otelcol.service" ]] || fail "collector unit not installed"
grep -q 'units: \["sshd.service"\]' "$R2/etc/heimdall/otel-collector.yaml" || fail "LOG_UNITS not passed"
grep -qx 'systemctl enable heimdall-otelcol.service' "$T/argv.log" || fail "collector not enabled"
grep -q "$OTOKEN" "$T/argv.log" "$T/out" && fail "otel token on argv/output"

# --- docker group present: heimdall joins it (container metrics); DOCKER=0 opts out ---
: >"$T/argv.log"
host "$T/dk" STUB_DOCKER_GROUP=1 TOKEN="$TOKEN" bash ./scripts/install-host.sh >"$T/out" 2>&1 \
  || { cat "$T/out" >&2; fail "docker-group install failed"; }
grep -qx "usermod -aG docker heimdall" "$T/argv.log" || fail "heimdall not added to docker group"
grep -qi "root-equivalent" "$T/out" || fail "docker group grant not explained"
: >"$T/argv.log"
host "$T/dk0" STUB_DOCKER_GROUP=1 DOCKER=0 TOKEN="$TOKEN" bash ./scripts/install-host.sh >"$T/out" 2>&1 \
  || fail "DOCKER=0 install failed"
grep -q "usermod" "$T/argv.log" && fail "DOCKER=0 still ran usermod"

# --- checksum mismatch: nothing installed ---
cp -R "$T/hub" "$T/badhub"
printf 'tampered' >>"$T/badhub/downloads/heimdall-agent-linux-amd64"
if host "$T/bad" TOKEN="$TOKEN" HUB_URL="file://$T/badhub" bash ./scripts/install-host.sh >"$T/out" 2>&1; then
  fail "checksum mismatch should fail"
fi
grep -qi 'checksum' "$T/out" || fail "mismatch not explained"
[[ -e "$T/bad" ]] && fail "mismatch installed something"

# --- non-https hub refused without HEIMDALL_ALLOW_INSECURE=1 (loopback http allowed) ---
for u in "http://203.0.113.10:43123" "http://heimdall.example.com" "file://$T/hub" "http://127.evil.com"; do
  set +e
  host "$T/insec" HEIMDALL_ALLOW_INSECURE=0 HUB_URL="$u" TOKEN="$TOKEN" bash ./scripts/install-host.sh >"$T/out" 2>&1; rc=$?
  set -e
  [[ $rc -eq 2 ]] || fail "non-https $u exit $rc != 2"
  grep -q 'HEIMDALL_ALLOW_INSECURE=1' "$T/out" || fail "non-https refusal for $u does not name the opt-in"
  [[ -e "$T/insec" ]] && fail "non-https $u installed something"
done
for u in "http://127.0.0.1:9" "http://localhost:9" "http://[::1]:9"; do
  host "$T/lo" HEIMDALL_ALLOW_INSECURE=0 HUB_URL="$u" TOKEN="$TOKEN" bash ./scripts/install-host.sh >"$T/out" 2>&1 || true
  grep -q 'refusing non-https' "$T/out" && fail "loopback $u refused"
  grep -q 'cannot download' "$T/out" || fail "loopback $u did not reach the download step: $(cat "$T/out")"
done

# --- EXPECTED_SHA256 pins the manifest ---
SUMS_SHA="$(if command -v sha256sum >/dev/null; then sha256sum "$M"; else shasum -a 256 "$M"; fi | awk '{print $1}')"
if host "$T/pinbad" TOKEN="$TOKEN" EXPECTED_SHA256=0000 bash ./scripts/install-host.sh >"$T/out" 2>&1; then
  fail "EXPECTED_SHA256 mismatch should fail"
fi
grep -q 'EXPECTED_SHA256' "$T/out" || fail "pin mismatch not explained"
[[ -e "$T/pinbad" ]] && fail "pin mismatch installed something"
host "$T/pinok" TOKEN="$TOKEN" EXPECTED_SHA256="$SUMS_SHA" bash ./scripts/install-host.sh >"$T/out" 2>&1 \
  || { cat "$T/out" >&2; fail "matching EXPECTED_SHA256 failed"; }
grep -q 'matches EXPECTED_SHA256' "$T/out" || fail "pin match not reported"

# --- install-agent.sh applies the agent's hub URL rule ---
set +e
env PATH="$T/bin:$PATH" DESTDIR="$T/ia" HUB_URL=http://203.0.113.10:43123 TOKEN="$TOKEN" DRY_RUN=1 \
  HEIMDALL_ALLOW_INSECURE=0 bash ./scripts/install-agent.sh >"$T/out" 2>&1; rc=$?
set -e
[[ $rc -eq 2 ]] || fail "install-agent.sh accepted public-IP http without opt-in (rc=$rc)"
for u in http://203.0.113.10:43123 http://203.0.113.20:43123 http://heimdall.lan:43123 http://heimdall-hub:43123 http://heimdall-hub.heimdall.svc.cluster.local:43123 https://h.example.com; do
  env PATH="$T/bin:$PATH" DESTDIR="$T/ia" HUB_URL="$u" TOKEN="$TOKEN" DRY_RUN=1 HEIMDALL_ALLOW_INSECURE=0 \
    bash ./scripts/install-agent.sh >"$T/out" 2>&1 || { cat "$T/out" >&2; fail "install-agent.sh refused $u"; }
done

# --- no token and no tty: exit 2 ---
set +e
host "$T/notok" bash ./scripts/install-host.sh >"$T/out" 2>&1; rc=$?
set -e
[[ $rc -eq 2 ]] || fail "missing token exit $rc != 2"
grep -q 'TOKEN' "$T/out" || fail "missing token not explained"

# --- unsupported arch ---
if host "$T/arch" STUB_ARCH=riscv64 TOKEN="$TOKEN" bash ./scripts/install-host.sh >"$T/out" 2>&1; then
  fail "riscv64 should fail"
fi
grep -q 'riscv64' "$T/out" || fail "arch error not explained"

# --- no HUB_URL (raw script, placeholder not rendered) ---
if env PATH="$T/bin:$PATH" DESTDIR="$T/nohub" TOKEN="$TOKEN" bash ./scripts/install-host.sh >"$T/out" 2>&1; then
  fail "missing HUB_URL should fail"
fi
grep -q 'HUB_URL' "$T/out" || fail "missing HUB_URL not explained"

# --- DRY_RUN touches nothing ---
: >"$T/argv.log"
host "$T/dry" DRY_RUN=1 TOKEN="$TOKEN" bash ./scripts/install-host.sh >"$T/out" 2>&1 \
  || { cat "$T/out" >&2; fail "DRY_RUN failed"; }
[[ ! -e "$T/dry" ]] || fail "DRY_RUN created files"
[[ ! -s "$T/argv.log" ]] || fail "DRY_RUN ran commands: $(cat "$T/argv.log")"
grep -q "$TOKEN" "$T/out" && fail "DRY_RUN printed token"

# --- uninstall removes agent and collector; state kept unless PURGE=1 ---
: >"$T/argv.log"
host "$R2" bash ./scripts/install-host.sh --uninstall >"$T/out" 2>&1 \
  || { cat "$T/out" >&2; fail "uninstall failed"; }
for f in usr/local/bin/heimdall-agent etc/heimdall/agent.env etc/systemd/system/heimdall-agent.service \
  etc/systemd/system/heimdall-otelcol.service etc/heimdall/otel.env usr/local/bin/otelcol-contrib; do
  [[ -e "$R2/$f" ]] && fail "uninstall left /$f"
done
grep -qx 'systemctl disable --now heimdall-agent.service' "$T/argv.log" || fail "agent unit not disabled"
[[ -d "$R2/var/lib/heimdall" ]] || fail "uninstall removed state without PURGE"
host "$R2" PURGE=1 bash ./scripts/install-host.sh --uninstall >"$T/out" 2>&1 || fail "purge failed"
[[ -e "$R2/var/lib/heimdall" ]] && fail "PURGE=1 kept state dir"

echo "ok"
