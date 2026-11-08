#!/usr/bin/env bash
# Shared helpers for Heimdall install / enroll / publish scripts.
# shellcheck shell=bash

heimdall_log() { printf '%s\n' "$*"; }
heimdall_err() { printf 'error: %s\n' "$*" >&2; }

# Generate a URL-safe (hex) secret of nbytes random bytes into a file with mode 0600. Never prints
# the value. Hex: it goes into DATABASE_URL, and 32 bytes is a valid HEIMDALL_SECRET_KEY.
heimdall_write_secret_file() {
  local dest="$1"
  local nbytes="${2:-32}"
  local dir
  dir="$(dirname "$dest")"
  mkdir -p "$dir"
  umask 077
  # openssl /dev/urandom — no secret on argv
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$nbytes" | tr -d '\n' >"$dest"
  else
    head -c "$nbytes" /dev/urandom | od -An -tx1 | tr -d ' \n' >"$dest"
  fi
  chmod 0600 "$dest"
}

heimdall_read_secret_file() {
  local src="$1"
  if [[ ! -f "$src" ]]; then
    heimdall_err "secret file not found: $src"
    return 1
  fi
  # strip trailing newlines only
  tr -d '\r' <"$src" | tr -d '\n'
}

# Redact common secret-looking assignments for dry-run echoes.
heimdall_redact_line() {
  local line="$1"
  printf '%s\n' "$line" | sed -E \
    -e 's/(TOKEN|SECRET|PASSWORD|AUTHORIZATION|BEARER|API[_-]?KEY)[=:][[:space:]]*[^[:space:]]+/\1=[REDACTED]/gI' \
    -e 's/(hdt_|hdo_|hdu_|hdr_|hda_)[A-Za-z0-9]+/\1[REDACTED]/g'
}

heimdall_require_cmd() {
  local c="$1"
  if ! command -v "$c" >/dev/null 2>&1; then
    heimdall_err "required command not found: $c"
    return 1
  fi
}
