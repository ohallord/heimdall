#!/usr/bin/env bash
# Ingress path list for scripts/expose-mcp.py. No network.
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 scripts/expose-mcp.py --self-test
