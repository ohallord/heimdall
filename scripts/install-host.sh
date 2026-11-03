#!/usr/bin/env bash
# Heimdall one-command host install. Served by the hub at /install.sh:
#
#   curl -fsSL https://<hub>/install.sh | sudo bash                     # prompts for the agent token
#   curl -fsSL https://<hub>/install.sh | sudo TOKEN=hdt_… bash         # non-interactive; token lands
#                                                                      # in sudo's journal (_CMDLINE)
#   curl -fsSL https://<hub>/install.sh | sudo OTEL=1 bash              # + OTel collector (prompts hdo_…)
#   curl -fsSL https://<hub>/install.sh | sudo bash -s -- --uninstall   # remove (PURGE=1: also state)
#
# Downloads the agent for this CPU plus the host installers from the hub's /downloads/, checks
# every file against the hub's SHA256SUMS, then runs install-agent.sh (and install-otelcol.sh when
# an OTel token is given). Linux + systemd, x86_64 / aarch64.
#
# Env (all optional):
#   HUB_URL                     hub origin (baked in when served by the hub)
#   TOKEN_FILE / TOKEN          agent token (hdt_…); prompted on the terminal when unset
#   OTEL_TOKEN_FILE / OTEL_TOKEN  OTel ingest token (hdo_…); installs the collector
#   OTEL=1                      install the collector, prompting for its token
#   HOSTNAME_VALUE CLUSTER_ID ENABLE_K8S LOG_UNITS LOG_PATHS OTELCOL_BIN DOCKER   passed through
#                               (DOCKER=0: do not add user heimdall to the docker group)
#   DRY_RUN=1                   download + verify, then print the install steps only
#   DESTDIR                     root prefix (tests)
#   PURGE=1                     with --uninstall, also remove /var/lib/heimdall
set -euo pipefail

# Everything runs from main(), called on the last line: bash parses the whole file before acting,
# so a truncated `curl | bash` download cannot run half a script.
main() {
HUB_URL="${HUB_URL:-__HEIMDALL_HUB_URL__}"
case "$HUB_URL" in __HEIMDALL_*) HUB_URL="" ;; esac
DRY_RUN="${DRY_RUN:-0}"
DESTDIR="${DESTDIR:-}"
OTEL="${OTEL:-0}"
TTY="${HEIMDALL_TTY:-/dev/tty}"

die() { echo "error: $*" >&2; exit "${2:-1}"; }
say() { echo "==> $*"; }

usage() { sed -n "2,23p" "${BASH_SOURCE[0]}" 2>/dev/null | sed 's/^# \{0,1\}//'; }

MODE=install
case "${1:-}" in
  "") ;;
  --uninstall) MODE=uninstall ;;
  -h|--help) usage; exit 0 ;;
  *) die "unknown argument: $1 (use --help)" ;;
esac

[[ -n "$HUB_URL" ]] || die "HUB_URL is required (e.g. curl -fsSL https://hub/install.sh | sudo HUB_URL=https://hub bash)" 2
HUB_URL="${HUB_URL%/}"

if [[ -z "$DESTDIR" && "$DRY_RUN" != "1" ]]; then
  [[ "$(id -u)" -eq 0 ]] || die "run as root: curl -fsSL ${HUB_URL}/install.sh | sudo bash"
  [[ -d /run/systemd/system ]] || die "systemd is required (no /run/systemd/system)"
fi

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported architecture: $(uname -m) (need x86_64 or aarch64)" ;;
esac

have_tty() { [[ -r "$TTY" ]] && { : <"$TTY"; } 2>/dev/null; }

# resolve_token VAR FILE_VAR LABEL — VAR from FILE_VAR, else env, else a terminal prompt.
resolve_token() {
  local var="$1" file_var="$2" label="$3" file value
  file="${!file_var:-}"
  value="${!var:-}"
  if [[ -n "$file" ]]; then
    [[ -r "$file" ]] || die "$file_var not readable: $file" 2
    value="$(tr -d '[:space:]' <"$file")"
  fi
  if [[ -z "$value" ]] && have_tty; then
    printf '%s: ' "$label" >"$TTY"
    IFS= read -r -s value <"$TTY" || true
    printf '\n' >"$TTY"
    value="$(printf '%s' "$value" | tr -d '[:space:]')"
  fi
  [[ -n "$value" ]] || return 1
  printf -v "$var" '%s' "$value"
  export "${var?}"
}

if [[ "$MODE" == install ]]; then
  resolve_token TOKEN TOKEN_FILE "Heimdall agent token (hdt_…)" \
    || die "no agent token: set TOKEN_FILE or TOKEN, or run from a terminal to be prompted" 2
  WANT_OTEL=0
  if [[ -n "${OTEL_TOKEN_FILE:-}${OTEL_TOKEN:-}" || "$OTEL" == "1" ]]; then
    resolve_token OTEL_TOKEN OTEL_TOKEN_FILE "Heimdall OTel ingest token (hdo_…)" \
      || die "OTEL=1 needs OTEL_TOKEN_FILE or OTEL_TOKEN, or a terminal to prompt on" 2
    unset OTEL_TOKEN_FILE
    WANT_OTEL=1
  fi
fi

W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT
mkdir -p "$W/dl" "$W/scripts/lib" "$W/deploy/systemd" "$W/deploy/otel" "$W/bin"

say "Fetching from ${HUB_URL}/downloads/"
curl -fsSL "${HUB_URL}/downloads/SHA256SUMS" -o "$W/dl/SHA256SUMS" \
  || die "cannot download ${HUB_URL}/downloads/SHA256SUMS (is the hub reachable and built with dist?)"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'
}

# fetch NAME DEST MODE — download, verify against SHA256SUMS, place into the mini repo layout.
fetch() {
  local name="$1" dest="$2" mode="$3" want got
  want="$(awk -v n="$name" '$2 == n || $2 == "*"n {print $1; exit}' "$W/dl/SHA256SUMS")"
  [[ -n "$want" ]] || die "$name is not listed in the hub's SHA256SUMS"
  curl -fsSL "${HUB_URL}/downloads/${name}" -o "$W/dl/$name" || die "download failed: $name"
  got="$(sha256_of "$W/dl/$name")"
  [[ "$got" == "$want" ]] || die "checksum mismatch for $name (expected $want, got $got); nothing installed"
  install -m "$mode" "$W/dl/$name" "$W/$dest"
}

# Mirror the repo layout so the installers find their siblings ($ROOT/scripts/lib, $ROOT/deploy/…).
fetch install-agent.sh scripts/install-agent.sh 0755
fetch install-otelcol.sh scripts/install-otelcol.sh 0755
fetch otel-token.sh scripts/lib/otel-token.sh 0644
if [[ "$MODE" == install ]]; then
  fetch "heimdall-agent-linux-${ARCH}" bin/heimdall-agent 0755
  fetch heimdall-agent.service deploy/systemd/heimdall-agent.service 0644
  if [[ "$WANT_OTEL" == 1 ]]; then
    fetch heimdall-otelcol.service deploy/systemd/heimdall-otelcol.service 0644
    fetch collector-baremetal.yaml deploy/otel/collector-baremetal.yaml 0644
  fi
fi
say "Verified against SHA256SUMS"

export HUB_URL DRY_RUN DESTDIR

if [[ "$MODE" == uninstall ]]; then
  bash "$W/scripts/install-agent.sh" --uninstall </dev/null
  if [[ -e "${DESTDIR}/etc/systemd/system/heimdall-otelcol.service" ]]; then
    bash "$W/scripts/install-otelcol.sh" --uninstall </dev/null
  fi
  exit 0
fi

BINARY="$W/bin/heimdall-agent" bash "$W/scripts/install-agent.sh" </dev/null
if [[ "$WANT_OTEL" == 1 ]]; then
  bash "$W/scripts/install-otelcol.sh" </dev/null
fi
say "Done. The host appears in Heimdall once the agent registers (Fleet → Servers)."
}

main "$@"
