#!/usr/bin/env bash
# Tests install-otelcol.sh / install-otelcol-docker.sh without root or network.
# Fake release tarballs + checksums are served via file://; systemctl/docker/uname are stubbed.
set -euo pipefail
cd "$(dirname "$0")/.."
fail() { echo "FAIL: $*" >&2; exit 1; }
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'; }
perms() { ls -l "$1" | cut -c1-10; }

V=0.111.0
TOKEN=hdo_secret_never_in_config
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/rel/v$V" "$T/bad/v$V" "$T/pkg"
printf '%s\n' "$TOKEN" >"$T/token"

# Fake release: one tarball per arch, plus the checksums file.
for a in amd64 arm64; do
  printf '#!/bin/sh\necho fake-otelcol-%s\n' "$a" >"$T/pkg/otelcol-contrib"
  chmod +x "$T/pkg/otelcol-contrib"
  tar -C "$T/pkg" -czf "$T/rel/v$V/otelcol-contrib_${V}_linux_${a}.tar.gz" otelcol-contrib
  cp "$T/rel/v$V/otelcol-contrib_${V}_linux_${a}.tar.gz" "$T/bad/v$V/"
  echo "$(sha256 "$T/rel/v$V/otelcol-contrib_${V}_linux_${a}.tar.gz")  otelcol-contrib_${V}_linux_${a}.tar.gz" \
    >>"$T/rel/v$V/opentelemetry-collector-releases_otelcol-contrib_checksums.txt"
  echo "$(printf '0%.0s' {1..64})  otelcol-contrib_${V}_linux_${a}.tar.gz" \
    >>"$T/bad/v$V/opentelemetry-collector-releases_otelcol-contrib_checksums.txt"
done

for cmd in systemctl docker; do
  cat >"$T/bin/$cmd" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$T/$cmd.log"
exit 0
EOF
done
cat >"$T/bin/uname" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == -m ]]; then echo "${STUB_ARCH:-x86_64}"; else exec /usr/bin/uname "$@"; fi
EOF
chmod +x "$T/bin/"*

install_otelcol() { # root, then extra env/args
  local root="$1"; shift
  env PATH="$T/bin:$PATH" DESTDIR="$root" HUB_URL=https://hub.example.com OTEL_TOKEN_FILE="$T/token" \
    OTELCOL_DOWNLOAD_BASE="file://$T/rel" "$@"
}

# --- install (amd64) ---
R="$T/root"
install_otelcol "$R" LOG_UNITS="sshd.service, nginx.service" LOG_PATHS="/var/log/app/*.log" AGENT_ID=agt_1 \
  ./scripts/install-otelcol.sh >"$T/out" 2>&1 || { cat "$T/out" >&2; fail "install exited non-zero"; }
B="$R/usr/local/bin/otelcol-contrib"; C="$R/etc/heimdall/otel-collector.yaml"; E="$R/etc/heimdall/otel.env"
U="$R/etc/systemd/system/heimdall-otelcol.service"
[[ -x "$B" ]] || fail "binary not installed"
"$B" | grep -q fake-otelcol-amd64 || fail "wrong arch binary for x86_64"
grep -q 'units: \["sshd.service", "nginx.service"\]' "$C" || fail "LOG_UNITS not templated"
grep -q 'include: \["/var/log/app/\*.log"\]' "$C" || fail "LOG_PATHS not templated"
grep -q 'receivers: \[journald, filelog\]' "$C" || fail "LOG_PATHS did not add filelog to logs pipeline"
grep -q '^ *- key: heimdall.agent_id' "$C" || fail "AGENT_ID attribute not enabled"
[[ "$(perms "$C")" == -rw-r--r-- ]] || fail "config mode $(perms "$C") != 0644"
[[ "$(perms "$E")" == -rw------- ]] || fail "otel.env mode $(perms "$E") != 0600"
grep -qx "HEIMDALL_OTEL_TOKEN=$TOKEN" "$E" || fail "token missing from otel.env"
grep -qx "HEIMDALL_OTLP_ENDPOINT=https://hub.example.com" "$E" || fail "endpoint missing from otel.env"
grep -qx "HEIMDALL_AGENT_ID=agt_1" "$E" || fail "agent id missing from otel.env"
grep -q "$TOKEN" "$C" && fail "token leaked into config"
grep -q "$TOKEN" "$T/out" && fail "token printed to stdout"
grep -q 'ExecStart=/usr/local/bin/otelcol-contrib' "$U" || fail "unit not installed"
grep -qx 'daemon-reload' "$T/systemctl.log" || fail "no daemon-reload"
grep -qx 'enable heimdall-otelcol.service' "$T/systemctl.log" || fail "unit not enabled"
grep -qx 'restart heimdall-otelcol.service' "$T/systemctl.log" || fail "unit not (re)started"

# --- idempotent re-run replaces config ---
install_otelcol "$R" LOG_UNITS=cron.service ./scripts/install-otelcol.sh >"$T/out" 2>&1 \
  || { cat "$T/out" >&2; fail "re-run exited non-zero"; }
grep -q 'units: \["cron.service"\]' "$C" || fail "re-run did not replace config"
grep -q 'receivers: \[journald, filelog\]' "$C" && fail "filelog in logs pipeline without LOG_PATHS (empty include fails startup)"
grep -q '^ *- key: heimdall.agent_id' "$C" && fail "re-run kept stale AGENT_ID"

# --- arm64 ---
install_otelcol "$T/arm" STUB_ARCH=aarch64 ./scripts/install-otelcol.sh >"$T/out" 2>&1 \
  || { cat "$T/out" >&2; fail "arm64 install exited non-zero"; }
"$T/arm/usr/local/bin/otelcol-contrib" | grep -q fake-otelcol-arm64 || fail "wrong arch binary for aarch64"

# --- checksum mismatch: non-zero, nothing installed ---
if install_otelcol "$T/bad-root" OTELCOL_DOWNLOAD_BASE="file://$T/bad" ./scripts/install-otelcol.sh >"$T/out" 2>&1; then
  fail "checksum mismatch should exit non-zero"
fi
[[ -z "$(find "$T/bad-root" -type f 2>/dev/null)" ]] || fail "checksum mismatch installed files"

# --- unsupported arch ---
if install_otelcol "$T/mips" STUB_ARCH=mips ./scripts/install-otelcol.sh >"$T/out" 2>&1; then
  fail "unsupported arch should exit non-zero"
fi
grep -qi 'unsupported' "$T/out" || fail "unsupported arch: no clear error"
[[ -z "$(find "$T/mips" -type f 2>/dev/null)" ]] || fail "unsupported arch installed files"

# --- OTELCOL_BIN: offline, no download ---
printf '#!/bin/sh\necho local-otelcol\n' >"$T/local-otelcol"; chmod +x "$T/local-otelcol"
install_otelcol "$T/offline" OTELCOL_BIN="$T/local-otelcol" OTELCOL_DOWNLOAD_BASE="file://$T/nope" \
  ./scripts/install-otelcol.sh >"$T/out" 2>&1 || { cat "$T/out" >&2; fail "OTELCOL_BIN install exited non-zero"; }
"$T/offline/usr/local/bin/otelcol-contrib" | grep -q local-otelcol || fail "OTELCOL_BIN not used"

# --- traces: local OTLP receiver feeding a traces pipeline ---
grep -q "endpoint: 127.0.0.1:4318" "$C" || fail "baremetal otlp http receiver not on loopback"
grep -q "^    traces:" "$C" || fail "baremetal config has no traces pipeline"

# --- OTEL_TOKEN works too; missing token fails ---
env PATH="$T/bin:$PATH" DESTDIR="$T/envtok" HUB_URL=https://h OTEL_TOKEN=hdo_env OTELCOL_BIN="$T/local-otelcol" \
  ./scripts/install-otelcol.sh >"$T/out" 2>&1 || { cat "$T/out" >&2; fail "OTEL_TOKEN install failed"; }
grep -qx 'HEIMDALL_OTEL_TOKEN=hdo_env' "$T/envtok/etc/heimdall/otel.env" || fail "OTEL_TOKEN not written"
if env PATH="$T/bin:$PATH" DESTDIR="$T/notok" HUB_URL=https://h OTELCOL_BIN="$T/local-otelcol" \
  ./scripts/install-otelcol.sh >"$T/out" 2>&1; then fail "missing token should fail"; fi

# --- DRY_RUN touches nothing ---
: >"$T/systemctl.log"
install_otelcol "$T/dry" DRY_RUN=1 ./scripts/install-otelcol.sh >"$T/out" 2>&1 \
  || { cat "$T/out" >&2; fail "DRY_RUN exited non-zero"; }
[[ ! -e "$T/dry" ]] || fail "DRY_RUN created files"
[[ ! -s "$T/systemctl.log" ]] || fail "DRY_RUN ran systemctl"
grep -q 'otelcol-contrib' "$T/out" || fail "DRY_RUN printed no steps"
grep -q "$TOKEN" "$T/out" && fail "DRY_RUN printed token"

# --- uninstall ---
: >"$T/systemctl.log"
env PATH="$T/bin:$PATH" DESTDIR="$R" ./scripts/install-otelcol.sh --uninstall >"$T/out" 2>&1 \
  || { cat "$T/out" >&2; fail "uninstall exited non-zero"; }
grep -qx 'disable --now heimdall-otelcol.service' "$T/systemctl.log" || fail "uninstall did not disable unit"
for f in "$B" "$C" "$E" "$U"; do [[ -e "$f" ]] && fail "uninstall left $f"; done

# --- docker variant ---
D="$T/docker-root"
env PATH="$T/bin:$PATH" DESTDIR="$D" HUB_URL=https://hub.example.com OTEL_TOKEN_FILE="$T/token" \
  ./scripts/install-otelcol-docker.sh >"$T/out" 2>&1 || { cat "$T/out" >&2; fail "docker install exited non-zero"; }
DE="$D/etc/heimdall/otel.env"
[[ "$(perms "$DE")" == -rw------- ]] || fail "docker otel.env mode $(perms "$DE") != 0600"
grep -qx "HEIMDALL_OTEL_TOKEN=$TOKEN" "$DE" || fail "docker otel.env missing token"
run_line="$(grep '^run ' "$T/docker.log")" || fail "docker run not called"
for want in "--name heimdall-otelcol" "--restart unless-stopped" "--env-file $DE" "/:/hostfs:ro" \
 "-p 127.0.0.1:4318:4318" "-p 127.0.0.1:4317:4317" \
  "otel/opentelemetry-collector-contrib:$V"; do
  [[ "$run_line" == *"$want"* ]] || fail "docker run missing '$want': $run_line"
done
[[ "$run_line" =~ :/etc/otelcol-contrib/config.yaml:ro ]] || fail "config not mounted read-only"
grep -q "$TOKEN" "$T/docker.log" && fail "token in docker argv"
cfg="$(sed -E 's/.* -v ([^ ]+):\/etc\/otelcol-contrib\/config.yaml:ro.*/\1/' <<<"$run_line")"
grep -q 'root_path: /hostfs' "$cfg" || fail "docker config not reading /hostfs"
grep -q "^    traces:" "$cfg" || fail "docker config has no traces pipeline"

: >"$T/docker.log"
env PATH="$T/bin:$PATH" DESTDIR="$T/docker-dry" HUB_URL=https://h OTEL_TOKEN=hdo_x DRY_RUN=1 \
  ./scripts/install-otelcol-docker.sh >"$T/out" 2>&1 || { cat "$T/out" >&2; fail "docker DRY_RUN failed"; }
[[ ! -s "$T/docker.log" && ! -e "$T/docker-dry" ]] || fail "docker DRY_RUN touched something"

env PATH="$T/bin:$PATH" DESTDIR="$D" ./scripts/install-otelcol-docker.sh --uninstall >"$T/out" 2>&1 \
  || { cat "$T/out" >&2; fail "docker uninstall failed"; }
grep -qx 'rm -f heimdall-otelcol' "$T/docker.log" || fail "docker uninstall did not remove container"
[[ -e "$DE" ]] && fail "docker uninstall left otel.env"

# --- sudo-rs has no -E: docs must not suggest it; a sudo run that lost HUB_URL says how to pass it ---
grep -rn "sudo -E" docs/otel.md scripts/install-*.sh && fail "docs/scripts suggest sudo -E (unsupported by sudo-rs)"
for s in install-otelcol.sh install-otelcol-docker.sh; do
  if env -u HUB_URL PATH="$T/bin:$PATH" SUDO_USER=me DESTDIR="$T/sudo" ./scripts/$s >"$T/out" 2>&1; then fail "$s: missing HUB_URL accepted"; fi
  grep -q "sudo env HUB_URL=" "$T/out" || fail "$s: no sudo env hint when HUB_URL lost under sudo"
done
echo "ok"
