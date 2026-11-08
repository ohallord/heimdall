#!/usr/bin/env bash
# Phase 31: build the files the hub serves at /downloads/* and /install.sh.
#
#   ./scripts/build-dist.sh [OUT]         default OUT: apps/hub/dist (gitignored)
#
# Produces:
#   heimdall-agent-linux-{amd64,arm64}    static agent binaries (CGO off, -trimpath)
#   install-host.sh                        the curl | bash bootstrapper
#   install-agent.sh install-otelcol.sh otel-token.sh
#   heimdall-agent.service heimdall-otelcol.service collector-baremetal.yaml
#   SHA256SUMS                             manifest; the hub only serves names listed here
#
# Env:
#   AGENT_VERSION   stamped into the agent (-X main.version); default: git short SHA, else "dev"
#   FAKE_AGENT=1    write tiny shell stubs instead of compiling (tests; no Go needed)
#   GO              go binary (default: go)
#   SRC_ROOT        repo root to read from (default: this script's repo; the Dockerfile sets it)
set -euo pipefail

SRC_ROOT="${SRC_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
OUT="${1:-$SRC_ROOT/apps/hub/dist}"
GO="${GO:-go}"
FAKE_AGENT="${FAKE_AGENT:-0}"
if [[ -z "${AGENT_VERSION:-}" ]]; then
  AGENT_VERSION="$(git -C "$SRC_ROOT" rev-parse --short HEAD 2>/dev/null || echo dev)"
fi
ARCHES=(amd64 arm64)

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
rm -f "$OUT"/heimdall-agent-linux-* "$OUT/SHA256SUMS"

for arch in "${ARCHES[@]}"; do
  bin="$OUT/heimdall-agent-linux-$arch"
  if [[ "$FAKE_AGENT" == "1" ]]; then
    printf '#!/bin/sh\necho "fake-heimdall-agent %s %s $*"\n' "$arch" "$AGENT_VERSION" >"$bin"
  else
    echo "==> go build linux/$arch ($AGENT_VERSION)"
    (cd "$SRC_ROOT/apps/agent" && CGO_ENABLED=0 GOOS=linux GOARCH="$arch" "$GO" build -trimpath \
      -ldflags "-s -w -X main.version=$AGENT_VERSION" -o "$bin" ./cmd/agent)
  fi
  chmod 0755 "$bin"
done

copy() { install -m "$1" "$SRC_ROOT/$2" "$OUT/$(basename "$2")"; }
copy 0755 scripts/install-host.sh
copy 0755 scripts/install-agent.sh
copy 0755 scripts/install-otelcol.sh
copy 0644 scripts/lib/otel-token.sh
copy 0644 deploy/systemd/heimdall-agent.service
copy 0644 deploy/systemd/heimdall-otelcol.service
copy 0644 deploy/otel/collector-baremetal.yaml

(
  cd "$OUT"
  files=(heimdall-agent-linux-* install-host.sh install-agent.sh install-otelcol.sh otel-token.sh \
    heimdall-agent.service heimdall-otelcol.service collector-baremetal.yaml)
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "${files[@]}"; else shasum -a 256 "${files[@]}"; fi \
    >SHA256SUMS.tmp
  mv SHA256SUMS.tmp SHA256SUMS
)
echo "==> dist at $OUT (agent $AGENT_VERSION)"
