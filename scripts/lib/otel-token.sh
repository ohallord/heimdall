# shellcheck shell=bash
# Shared by the OTel install scripts.
#
# read_otel_token
#   Sets OTEL_TOKEN from OTEL_TOKEN_FILE (preferred: keeps the token out of shell history)
#   or leaves the OTEL_TOKEN env value. Returns 1 if neither yields a token.
read_otel_token() {
  if [[ -n "${OTEL_TOKEN_FILE:-}" ]]; then
    [[ -r "${OTEL_TOKEN_FILE}" ]] || { echo "error: OTEL_TOKEN_FILE not readable: ${OTEL_TOKEN_FILE}" >&2; return 1; }
    OTEL_TOKEN="$(tr -d '[:space:]' <"${OTEL_TOKEN_FILE}")"
  fi
  if [[ -z "${OTEL_TOKEN:-}" ]]; then
    echo "error: set OTEL_TOKEN_FILE (preferred) or OTEL_TOKEN to the hdo_… ingest token" >&2
    return 1
  fi
}

# require_hub_url SCRIPT
#   Exits 2 if HUB_URL is empty. Under sudo the usual cause is that sudo dropped the caller's env
#   (sudo-rs has no -E), so say how to pass it.
require_hub_url() {
  [[ -n "${HUB_URL:-}" ]] && return 0
  echo "error: HUB_URL is required" >&2
  if [[ -n "${SUDO_USER:-}" ]]; then
    echo "  sudo resets the environment. Pass variables after 'sudo env':" >&2
    echo "  sudo env HUB_URL=https://hub.example.com OTEL_TOKEN_FILE=\$HOME/hdo.txt ./scripts/$1" >&2
  fi
  exit 2
}
