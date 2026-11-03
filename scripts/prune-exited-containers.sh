#!/usr/bin/env bash
# Remove stopped (exited/dead) containers that keep tripping the
# "Container exited" alert.
#
# Dry run by default; pass --yes to actually remove.
# Never removes volumes: named and anonymous volumes and bind mounts are left
# untouched, so container data/config survives (`docker rm` without -v).
#
# Usage:
#   scripts/prune-exited-containers.sh                    # list what would go
#   scripts/prune-exited-containers.sh --keep jellyfin    # spare one (repeatable)
#   scripts/prune-exited-containers.sh --min-age 7        # only stopped >= 7 days
#   scripts/prune-exited-containers.sh --yes              # do it
set -euo pipefail

DOCKER="${DOCKER:-docker}"
APPLY=0
MIN_AGE_DAYS=0
KEEP=()

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes) APPLY=1 ;;
    -k|--keep) KEEP+=("${2:?--keep needs a container name}"); shift ;;
    --min-age) MIN_AGE_DAYS="${2:?--min-age needs days}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if ! [[ "$MIN_AGE_DAYS" =~ ^[0-9]+$ ]]; then
  echo "--min-age must be a whole number of days" >&2
  exit 2
fi

is_kept() {
  local name="$1" k
  for k in "${KEEP[@]+"${KEEP[@]}"}"; do
    [[ "$k" == "$name" ]] && return 0
  done
  return 1
}

mapfile -t ids < <("$DOCKER" ps -aq --filter status=exited --filter status=dead)
if [[ ${#ids[@]} -eq 0 ]]; then
  echo "No exited or dead containers."
  exit 0
fi

now=$(date +%s)
cutoff=$(( now - MIN_AGE_DAYS * 86400 ))
remove=()

printf '%-8s %-28s %-36s %-5s %-12s %s\n' ACTION NAME IMAGE EXIT STOPPED COMPOSE
while IFS=$'\t' read -r id name image code finished project; do
  name="${name#/}"
  [[ "$project" == "<no value>" ]] && project=""
  finished_s=$(date -d "$finished" +%s 2>/dev/null || echo 0)
  if (( finished_s > 0 )); then
    stopped="$(( (now - finished_s) / 86400 ))d ago"
  else
    stopped="unknown"
  fi

  action="remove"
  if is_kept "$name"; then
    action="keep"
  elif (( finished_s > cutoff )); then
    action="too-new"
  fi

  printf '%-8s %-28s %-36s %-5s %-12s %s\n' \
    "$action" "$name" "${image:0:36}" "$code" "$stopped" "${project:--}"
  [[ "$action" == "remove" ]] && remove+=("$id")
done < <("$DOCKER" inspect -f \
  '{{.Id}}{{"\t"}}{{.Name}}{{"\t"}}{{.Config.Image}}{{"\t"}}{{.State.ExitCode}}{{"\t"}}{{.State.FinishedAt}}{{"\t"}}{{index .Config.Labels "com.docker.compose.project"}}' \
  "${ids[@]}")

echo
if [[ ${#remove[@]} -eq 0 ]]; then
  echo "Nothing to remove."
  exit 0
fi

if (( ! APPLY )); then
  echo "Dry run: ${#remove[@]} container(s) would be removed. Re-run with --yes to remove them."
  exit 0
fi

"$DOCKER" rm "${remove[@]}"
echo "Removed ${#remove[@]} container(s). Volumes and bind-mounted data were left in place."
