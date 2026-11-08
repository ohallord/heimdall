#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Push must refuse outside allowed CI tag context (no real push).
set +e
out="$(cd "$ROOT" && env -u PUBLIC_REPO_TOKEN -u PUBLISH_ALLOW_PUSH ./scripts/publish.sh --push --skip-tests 2>&1)"
ec=$?
set -e
[[ "$ec" -ne 0 ]] || { echo "push should refuse locally" >&2; exit 1; }
printf '%s\n' "$out" | grep -qi 'push refused'

# Allow flag without a token (and no usable gh) still refuses, and must not clone.
# PUBLISH_GH_BIN points at a missing binary so a logged-in gh on this machine cannot arm a real push.
set +e
out2="$(cd "$ROOT" && env -u PUBLIC_REPO_TOKEN PUBLISH_ALLOW_PUSH=1 PUBLISH_GH_BIN=/nonexistent/gh ./scripts/publish.sh --push --skip-tests 2>&1)"
ec2=$?
set -e
[[ "$ec2" -ne 0 ]] || { echo "push should refuse without PUBLIC_REPO_TOKEN" >&2; exit 1; }
printf '%s\n' "$out2" | grep -qi 'PUBLIC_REPO_TOKEN'

# Token from `gh auth token` when PUBLIC_REPO_TOKEN is unset: used, never printed.
# --assemble-only stops before any clone or push.
GHS="$(mktemp -d "${TMPDIR:-/tmp}/heimdall-gh.XXXXXX")"
cat >"$GHS/gh" <<'STUB'
#!/usr/bin/env bash
[[ "$1 $2" == "auth token" ]] && { echo "gho_stubtoken_do_not_print"; exit 0; }
exit 1
STUB
chmod +x "$GHS/gh"
set +e
out4="$(cd "$ROOT" && env -u PUBLIC_REPO_TOKEN PUBLISH_ALLOW_PUSH=1 PUBLISH_GH_BIN="$GHS/gh" ./scripts/publish.sh --push --skip-tests --assemble-only 2>&1)"
ec4=$?
set -e
snap4="$(printf '%s\n' "$out4" | sed -n 's/.*snapshot=\([^ ]*\).*/\1/p' | head -1)"
case "$snap4" in */heimdall-publish.*) rm -rf -- "$snap4" ;; esac
rm -rf -- "$GHS"
[[ "$ec4" -eq 0 ]] || { echo "push gate should accept a token from gh (exit $ec4)" >&2; printf '%s\n' "$out4" >&2; exit 1; }
printf '%s\n' "$out4" | grep -q 'token from gh' || { echo "gh token source not logged" >&2; exit 1; }
if printf '%s\n' "$out4" | grep -q 'gho_stubtoken_do_not_print'; then echo "gh token was printed" >&2; exit 1; fi

# Allow flag + gh present but not logged in: still refuses.
GHF="$(mktemp -d "${TMPDIR:-/tmp}/heimdall-gh.XXXXXX")"
printf '#!/usr/bin/env bash\nexit 1\n' >"$GHF/gh"; chmod +x "$GHF/gh"
set +e
out5="$(cd "$ROOT" && env -u PUBLIC_REPO_TOKEN PUBLISH_ALLOW_PUSH=1 PUBLISH_GH_BIN="$GHF/gh" ./scripts/publish.sh --push --skip-tests 2>&1)"
ec5=$?
set -e
rm -rf -- "$GHF"
[[ "$ec5" -ne 0 ]] || { echo "push should refuse when gh has no token" >&2; exit 1; }

# Symlink escape: copy-allowlist rejects symlinks
T="$(mktemp -d "${TMPDIR:-/tmp}/heimdall-allow.XXXXXX")"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/src" "$T/dst" "$T/outside"
echo secret >"$T/outside/x"
ln -s "$T/outside/x" "$T/src/link.txt"
printf 'link.txt\n' >"$T/allow"
set +e
/usr/bin/python3 "$ROOT/scripts/lib/copy-allowlist.py" "$T/src" "$T/allow" "$T/dst" >/dev/null 2>"$T/err"
ec3=$?
set -e
[[ "$ec3" -ne 0 ]] || { echo "symlink should fail closed" >&2; exit 1; }
grep -qi 'symlink' "$T/err"

# Snapshot ships the gitleaks fixture allowlist at its root (external `gitleaks detect` auto-loads
# .gitleaks.toml) plus Dependabot config. --assemble-only stops before gitleaks/tests/network.
set +e
out4="$(cd "$ROOT" && TMPDIR="$T" ./scripts/publish.sh --assemble-only 2>&1)"
ec4=$?
set -e
[[ "$ec4" -eq 0 ]] || { echo "assemble-only failed: $out4" >&2; exit 1; }
SNAP="$(printf '%s\n' "$out4" | sed -n 's/^assembled snapshot at //p' | tail -1)"
[[ -n "$SNAP" && -d "$SNAP" ]] || { echo "assemble-only did not report the snapshot dir" >&2; exit 1; }
cmp -s "$ROOT/.publish/gitleaks.toml" "$SNAP/.gitleaks.toml" || { echo "snapshot .gitleaks.toml missing/differs" >&2; exit 1; }
[[ -f "$SNAP/.github/dependabot.yml" ]] || { echo "snapshot missing .github/dependabot.yml" >&2; exit 1; }
if grep -rqF "heimdall-dev-""session-secret" "$SNAP" --exclude-dir=node_modules; then
  echo "snapshot ships the dev session secret" >&2; exit 1
fi

echo "test-publish-gates: ok"
