#!/usr/bin/env bash
# Private → public snapshot publisher. Default: --dry-run (never pushes).
# Fail-closed allowlist + replace + denylist + gitleaks + build/test gates.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUBLISH_DIR="$ROOT/.publish"
GITLEAKS_VERSION="${GITLEAKS_VERSION:-8.21.2}"
PUBLIC_REPO_URL="${PUBLIC_REPO_URL:-https://github.com/ohallord/heimdall.git}"
PUBLIC_REF="${PUBLIC_REF:-main}"
MODE="dry-run"
RUN_TESTS=1
SNAPSHOT_DIR=""
KEEP_SNAPSHOT=0
ASSEMBLE_ONLY=0

usage() {
  cat <<'EOF'
Usage: ./scripts/publish.sh [--dry-run|--push] [--skip-tests] [--keep-snapshot] [--assemble-only]

Default --dry-run builds a snapshot, runs gates, prints diffstat, never pushes.

--push writes that snapshot as one new commit on the public GitHub branch.
It does not push private history. It refuses unless both are set:
  PUBLISH_ALLOW_PUSH=1
  a token with write access to the public repo (never printed), from either
    PUBLIC_REPO_TOKEN, or
    `gh auth token` when PUBLIC_REPO_TOKEN is unset and the GitHub CLI is logged in
    (PUBLISH_GH_BIN overrides the gh binary; set it to /nonexistent to disable)

  PUBLISH_ALLOW_PUSH=1 ./scripts/publish.sh --push     # uses your gh login
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) MODE="dry-run"; shift ;;
    --push) MODE="push"; shift ;;
    --skip-tests) RUN_TESTS=0; shift ;;
    --keep-snapshot) KEEP_SNAPSHOT=1; shift ;;
    # Test hook (scripts/tests/test-publish-gates.sh): assemble the tree, check required files, stop.
    --assemble-only) ASSEMBLE_ONLY=1; KEEP_SNAPSHOT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done

log() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ -d "$PUBLISH_DIR" ]] || die ".publish/ missing"
[[ -f "$PUBLISH_DIR/allowlist" ]] || die ".publish/allowlist missing"
[[ -f "$PUBLISH_DIR/replace.tsv" ]] || die ".publish/replace.tsv missing"
[[ -f "$PUBLISH_DIR/denylist.regex" ]] || die ".publish/denylist.regex missing"
[[ -f "$PUBLISH_DIR/PUBLIC_README.md" ]] || die ".publish/PUBLIC_README.md missing"

refuse_push() {
  local reason="$1"
  if [[ "$MODE" == "push" ]]; then
    die "push refused: $reason"
  fi
}

# Push gate. A bare --push does nothing. The token stays in the environment
# and is handed to git through GIT_ASKPASS, not placed on the command line.
if [[ "$MODE" == "push" ]]; then
  [[ "${PUBLISH_ALLOW_PUSH:-}" == "1" ]] || refuse_push "PUBLISH_ALLOW_PUSH!=1"
  if [[ -z "${PUBLIC_REPO_TOKEN:-}" ]]; then
    # Fall back to the GitHub CLI login. The value is captured, never echoed.
    gh_bin="${PUBLISH_GH_BIN:-gh}"
    if command -v "$gh_bin" >/dev/null 2>&1; then
      PUBLIC_REPO_TOKEN="$("$gh_bin" auth token --hostname github.com 2>/dev/null || true)"
      [[ -n "$PUBLIC_REPO_TOKEN" ]] && log "push: using token from gh auth token (github.com)"
    fi
  fi
  [[ -n "${PUBLIC_REPO_TOKEN:-}" ]] || refuse_push "PUBLIC_REPO_TOKEN unset and no gh login (run: gh auth login)"
  export PUBLIC_REPO_TOKEN
fi

SNAPSHOT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/heimdall-publish.XXXXXX")"
cleanup() {
  if [[ "$KEEP_SNAPSHOT" -eq 0 && -n "$SNAPSHOT_DIR" && -d "$SNAPSHOT_DIR" ]]; then
    rm -rf "$SNAPSHOT_DIR"
  else
    log "snapshot kept at $SNAPSHOT_DIR"
  fi
}
trap cleanup EXIT

log "publish mode=$MODE gitleaks=v$GITLEAKS_VERSION snapshot=$SNAPSHOT_DIR"

# --- copy allowlisted paths (fail-closed; reject path traversal / symlinks) ---
/usr/bin/python3 "$ROOT/scripts/lib/copy-allowlist.py" \
  "$ROOT" "$PUBLISH_DIR/allowlist" "$SNAPSHOT_DIR"

# README swap + screenshots + gitleaks config + changelog
cp "$PUBLISH_DIR/PUBLIC_README.md" "$SNAPSHOT_DIR/README.md"
cp "$PUBLISH_DIR/CHANGELOG.md" "$SNAPSHOT_DIR/CHANGELOG.md"
cp "$PUBLISH_DIR/gitleaks.toml" "$SNAPSHOT_DIR/.gitleaks.toml"
mkdir -p "$SNAPSHOT_DIR/docs/screenshots"
if [[ -d "$PUBLISH_DIR/screenshots" ]]; then
  find "$PUBLISH_DIR/screenshots" -type f ! -name 'PLACEHOLDER.md' -exec cp {} "$SNAPSHOT_DIR/docs/screenshots/" \;
fi

# Apply replace.tsv (+ path-scoped IP/home rewrites outside unit fixtures)
/usr/bin/python3 - "$SNAPSHOT_DIR" "$PUBLISH_DIR/replace.tsv" <<'PY'
import re, sys
from pathlib import Path
root = Path(sys.argv[1])
rules = []
for raw in Path(sys.argv[2]).read_text().splitlines():
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    if "\t" not in line:
        raise SystemExit(f"replace.tsv line needs TAB: {line!r}")
    pat, repl = line.split("\t", 1)
    rules.append((re.compile(pat, re.I | re.M), repl))

# Applied only outside *.test.* / fixtures so SSRF tests keep RFC1918 samples.
scoped = [
    (re.compile(r"/home/[A-Za-z0-9._-]+"), "/path/to/home"),
    (re.compile(r"\b192\.168\.\d{1,3}\.\d{1,3}\b"), "203.0.113.10"),
    (re.compile(r"\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b"), "203.0.113.20"),
    (re.compile(r"\b172\.(1[6-9]|2[0-9]|3[0-1])\.\d{1,3}\.\d{1,3}\b"), "203.0.113.30"),
    (re.compile(r"\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b"), "203.0.113.40"),
]
fixture_skip = re.compile(
    r"(^|/)(fixtures)/|\.test\.[tj]sx?$|_test\.go$|\.spec\.[tj]sx?$",
    re.I,
)

text_ext = {
  ".md",".txt",".yml",".yaml",".toml",".json",".ts",".tsx",".js",".mjs",".cjs",
  ".go",".sh",".env",".example",".css",".sql",".svg",".service",".mod",".sum",
  ".gitignore",".npmrc",".eslintrc",".log",".conf",".cfg",".ini",""
}
changed = 0
for p in root.rglob("*"):
    if not p.is_file():
        continue
    if p.suffix.lower() not in text_ext and p.name not in {"allowlist","Dockerfile","Makefile","LICENSE","README","CHANGELOG"}:
        if p.suffix:
            continue
    try:
        data = p.read_text(encoding="utf-8")
    except Exception:
        continue
    orig = data
    for rx, repl in rules:
        data = rx.sub(repl, data)
    rel = p.relative_to(root).as_posix()
    if not fixture_skip.search(rel):
        for rx, repl in scoped:
            data = rx.sub(repl, data)
    if data != orig:
        p.write_text(data, encoding="utf-8")
        changed += 1
print(f"replace applied to {changed} files")
PY

# Files the public tree must carry. A root .gitleaks.toml is what a plain `gitleaks detect` on the
# public repo (or a fork's CI) auto-loads, so external scans see the fixture allowlist too.
for f in LICENSE README.md .gitleaks.toml .github/dependabot.yml .github/workflows/ci.yml; do
  [[ -f "$SNAPSHOT_DIR/$f" ]] || die "snapshot missing $f (check .publish/allowlist and the copy step)"
done
if [[ "$ASSEMBLE_ONLY" -eq 1 ]]; then
  log "assembled snapshot at $SNAPSHOT_DIR"
  exit 0
fi

# Banned files
banned_hits=0
while IFS= read -r -d '' f; do
  rel="${f#"$SNAPSHOT_DIR"/}"
  case "$rel" in
    .env|AGENTS.md|CLAUDE.md|GEMINI.md|.cursorrules|.clauderules|*/AGENTS.md|*/CLAUDE.md|*/GEMINI.md)
      log "BANNED file present: $rel"; banned_hits=$((banned_hits+1)) ;;
  esac
  case "$rel" in
    *.sops.yaml)
      case "$rel" in *.sops.yaml.example) ;; *) log "BANNED sops: $rel"; banned_hits=$((banned_hits+1)) ;; esac ;;
  esac
  base="$(basename "$f")"
  case "$base" in
    kubeconfig|kubeconfig.yaml|.kubeconfig)
      log "BANNED kubeconfig: $rel"; banned_hits=$((banned_hits+1)) ;;
  esac
done < <(find "$SNAPSHOT_DIR" -type f -print0)
# banned dirs
for d in .cursor .agents; do
  if [[ -e "$SNAPSHOT_DIR/$d" ]]; then
    log "BANNED dir present: $d"; banned_hits=$((banned_hits+1))
  fi
done
[[ "$banned_hits" -eq 0 ]] || die "banned-file gate failed ($banned_hits)"

[[ -f "$SNAPSHOT_DIR/LICENSE" ]] || die "LICENSE missing"
[[ -f "$SNAPSHOT_DIR/README.md" ]] || die "README.md missing"

# Denylist (skip RFC1918/home-path rules inside unit fixtures/tests)
DENY_FILE="$PUBLISH_DIR/denylist.regex"
deny_hits="$(
  /usr/bin/python3 - "$SNAPSHOT_DIR" "$DENY_FILE" "${DENYLIST_EXTRA:-}" <<'PY'
import re, sys
from pathlib import Path
root = Path(sys.argv[1])
patterns = []
for raw in Path(sys.argv[2]).read_text().splitlines():
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    patterns.append(re.compile(line, re.I))
extra = sys.argv[3] if len(sys.argv) > 3 else ""
for line in extra.splitlines():
    line = line.strip()
    if line:
        patterns.append(re.compile(line, re.I))

# Synthetic SSRF / log-threat fixtures legitimately contain private IPs and /home/…
fixture_skip = re.compile(
    r"(^|/)(fixtures)/|\.test\.[tj]sx?$|_test\.go$|\.spec\.[tj]sx?$",
    re.I,
)
def is_fixture_only_rule(pat: str) -> bool:
    # Private-path / RFC1918 / CGNAT rules — allowed inside synthetic fixtures.
    keys = ("/Users/", "/home/", r"10\.", r"192\.168", r"172\.", r"100\.", "/path/to")
    return any(k in pat for k in keys)

hits = 0
for p in root.rglob("*"):
    if not p.is_file():
        continue
    rel = p.relative_to(root).as_posix()
    # Skip binaries / non-text (NUL in first 8KiB)
    try:
        sample = p.read_bytes()[:8192]
    except Exception:
        continue
    if b"\x00" in sample:
        continue
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except Exception:
        continue
    in_fixture = bool(fixture_skip.search(rel))
    for i, line in enumerate(text.splitlines(), 1):
        for rx in patterns:
            if in_fixture and is_fixture_only_rule(rx.pattern):
                continue
            if rx.search(line):
                print(f"DENY {rx.pattern!r} at {rel}:{i}")
                hits += 1
                break
print(f"DENY_HITS={hits}")
sys.exit(1 if hits else 0)
PY
)" || {
  printf '%s\n' "$deny_hits" | sed -n '/^DENY /p; /^DENY_HITS=/p'
  die "denylist gate failed"
}
log "denylist: clean"

# gitleaks (pinned via docker). --exit-code 1 → non-zero on findings.
if ! command -v docker >/dev/null 2>&1; then
  die "docker required for pinned gitleaks v${GITLEAKS_VERSION}"
fi
GL_DIR="$(umask 077; mktemp -d "${TMPDIR:-/tmp}/heimdall-gitleaks.XXXXXX")"
set +e
docker run --rm \
  -v "$SNAPSHOT_DIR:/repo:ro" \
  "zricethezav/gitleaks:v${GITLEAKS_VERSION}" \
  detect --no-git --source /repo --config /repo/.gitleaks.toml --no-banner --exit-code 1 \
  >"$GL_DIR/out" 2>"$GL_DIR/err"
gl_ec=$?
set -e
if [[ "$gl_ec" -ne 0 ]]; then
  count="$(grep -E 'leaks found:' "$GL_DIR/err" 2>/dev/null | tail -1 | sed -E 's/.*leaks found: *([0-9]+).*/\1/' || echo unknown)"
  rm -rf "$GL_DIR"
  die "gitleaks snapshot gate failed (findings=${count})"
fi
rm -rf "$GL_DIR"
log "gitleaks v${GITLEAKS_VERSION}: clean"

# Build/test from snapshot
if [[ "$RUN_TESTS" -eq 1 ]]; then
  log "running snapshot tests…"
  (
    cd "$SNAPSHOT_DIR/apps/hub"
    npm ci
    npm run lint
    npm test
    npm run build
  )
  # Same toolchain as .github/workflows/publish.yml. The homelab has
  # Docker (gitleaks already required it) and often no host Go.
  if command -v go >/dev/null 2>&1; then
    ( cd "$SNAPSHOT_DIR/apps/agent" && go test ./... )
  else
    log "go not on PATH; running agent tests in golang:1.26-bookworm"
    docker run --rm \
      -v "$SNAPSHOT_DIR/apps/agent:/src" \
      -w /src \
      -e GOCACHE=/tmp/go-cache \
      -e GOPATH=/tmp/gopath \
      golang:1.26-bookworm \
      go test ./...
  fi
  (
    cd "$SNAPSHOT_DIR"
    # handshake needs built hub; native agent metrics require /proc and go.
    export HEIMDALL_DB_DRIVER=pglite
    export HEIMDALL_SESSION_SECRET=snapshot-gate-session-secret-not-for-prod
    export HEIMDALL_BOOTSTRAP_TOKEN=snapshot-gate-bootstrap
    if command -v go >/dev/null 2>&1 && [[ -r /proc/meminfo ]]; then
      ./scripts/handshake-smoke.sh
    else
      if ! command -v go >/dev/null 2>&1; then
        log "go not on PATH; using docker linux handshake smoke"
      else
        log "no /proc/meminfo on host; using docker linux handshake smoke"
      fi
      ./scripts/handshake-smoke-linux.sh
    fi
  )
  log "snapshot build/test/lint/handshake: pass"
else
  log "WARNING: --skip-tests set; not a shippable dry-run"
fi

# Diffstat vs public (exclude build trees — never copy node_modules/.next into diff workdir)
DIFF_DIR="$(mktemp -d "${TMPDIR:-/tmp}/heimdall-public-diff.XXXXXX")"
if git clone --depth 1 --branch "$PUBLIC_REF" "$PUBLIC_REPO_URL" "$DIFF_DIR/public" 2>/dev/null; then
  log "diffstat vs public $PUBLIC_REF:"
  diff -rq "$DIFF_DIR/public" "$SNAPSHOT_DIR" \
    --exclude .git --exclude node_modules --exclude .next 2>/dev/null \
    | tee "$DIFF_DIR/diffstat.txt" \
    | wc -l | awk '{print "changed_paths="$1}' || true
else
  log "warning: could not clone public repo for diffstat (network/auth); continuing"
fi
rm -rf "$DIFF_DIR"

# One new commit on the public branch. The tree is the snapshot, not private history.
# Community files that exist only on GitHub are copied forward so this commit
# does not delete them.
publish_snapshot() {
  local work askpass sha name email
  work="$(mktemp -d "${TMPDIR:-/tmp}/heimdall-publish-push.XXXXXX")"
  askpass="$(mktemp)"
  cat >"$askpass" <<'EOF'
#!/bin/sh
case "$1" in
  *Username*) printf '%s\n' "x-access-token" ;;
  *) printf '%s\n' "${PUBLIC_REPO_TOKEN}" ;;
esac
EOF
  chmod 700 "$askpass"
  export GIT_ASKPASS="$askpass"
  export GIT_TERMINAL_PROMPT=0
  if ! git clone --depth 1 --branch "$PUBLIC_REF" "$PUBLIC_REPO_URL" "$work/repo"; then
    rm -rf "$work"
    rm -f "$askpass"
    die "could not clone the public repo. The token needs write access to ${PUBLIC_REPO_URL}"
  fi
  /usr/bin/python3 - "$work/repo" "$SNAPSHOT_DIR" <<'PY'
import os, shutil, sys
repo, snap = sys.argv[1], sys.argv[2]
keep = [
    "SECURITY.md",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    ".github/pull_request_template.md",
    ".github/ISSUE_TEMPLATE/bug_report.md",
    ".github/ISSUE_TEMPLATE/feature_request.md",
    ".github/ISSUE_TEMPLATE/config.yml",
]
for rel in keep:
    src = os.path.join(repo, rel)
    dst = os.path.join(snap, rel)
    if os.path.isfile(src) and not os.path.exists(dst):
        parent = os.path.dirname(dst)
        if parent:
            os.makedirs(parent, exist_ok=True)
        shutil.copy2(src, dst)
        print(f"kept public-only file {rel}")
for name in os.listdir(repo):
    if name == ".git":
        continue
    path = os.path.join(repo, name)
    if os.path.isdir(path) and not os.path.islink(path):
        shutil.rmtree(path)
    else:
        os.remove(path)
for name in os.listdir(snap):
    src = os.path.join(snap, name)
    dst = os.path.join(repo, name)
    if os.path.isdir(src) and not os.path.islink(src):
        shutil.copytree(src, dst, symlinks=False)
    else:
        shutil.copy2(src, dst)
PY
  sha="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
  name="$(git -C "$ROOT" config user.name || true)"
  email="$(git -C "$ROOT" config user.email || true)"
  [[ -n "$name" && -n "$email" ]] || die "set git user.name and user.email before pushing the public snapshot"
  git -C "$work/repo" add -A
  git -C "$work/repo" ls-files --error-unmatch .gitleaks.toml >/dev/null 2>&1 \
    || die ".gitleaks.toml would not be committed to the public repo"
  if git -C "$work/repo" diff --cached --quiet; then
    log "public ${PUBLIC_REF} already matches this snapshot"
  else
    git -C "$work/repo" -c user.name="$name" -c user.email="$email" commit -m "$(cat <<EOF
Publish snapshot from private ${sha}

Allowlisted tree only. Private history is not in this commit.
EOF
)"
    git -C "$work/repo" push origin "HEAD:${PUBLIC_REF}"
    log "pushed snapshot to ${PUBLIC_REPO_URL} (${PUBLIC_REF})"
  fi
  rm -rf "$work"
  rm -f "$askpass"
  unset GIT_ASKPASS
}

if [[ "$MODE" == "push" ]]; then
  publish_snapshot
  log "publish complete"
else
  log "dry-run complete; no push performed"
fi
# Explicit exit marker for evidence collectors (before EXIT trap / KEEP_SNAPSHOT note)
log "PUBLISH_EXIT=0"
