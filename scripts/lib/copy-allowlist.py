#!/usr/bin/env python3
"""Fail-closed allowlist copy for publish.sh. Rejects symlinks and path escape."""
from __future__ import annotations

import fnmatch
import os
import shutil
import sys
from pathlib import Path


def main() -> int:
    root = Path(sys.argv[1]).resolve()
    allow_path = Path(sys.argv[2])
    dest_root = Path(sys.argv[3]).resolve()

    includes: list[str] = []
    excludes: list[str] = []
    for raw in allow_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("!"):
            excludes.append(line[1:])
        else:
            includes.append(line)

    def is_excluded(rel: str) -> bool:
        for pat in excludes:
            if fnmatch.fnmatch(rel, pat):
                return True
            if pat.endswith("/**"):
                prefix = pat[:-3]
                if rel == prefix or rel.startswith(prefix + "/"):
                    return True
        return False

    def match_include(rel: str) -> bool:
        for pat in includes:
            if fnmatch.fnmatch(rel, pat):
                return True
            if pat.endswith("/**"):
                prefix = pat[:-3]
                if rel == prefix or rel.startswith(prefix + "/"):
                    return True
            elif pat.endswith("/*"):
                prefix = pat[:-2]
                if rel.startswith(prefix + "/") and "/" not in rel[len(prefix) + 1 :]:
                    return True
        return False

    copied = 0
    skipped_missing: list[str] = []

    # Prefer git ls-files when available so ignored build artifacts (e.g.
    # apps/agent/bin/) never enter the public snapshot from a dirty worktree.
    tracked: set[str] | None = None
    try:
        import subprocess

        proc = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z"],
            check=True,
            capture_output=True,
        )
        tracked = {p for p in proc.stdout.decode("utf-8", "replace").split("\0") if p}
    except Exception:
        tracked = None

    # Walk entire tree once; include filter decides membership.
    for dirpath, dirnames, filenames in os.walk(root):
        # never descend into .git / node_modules / .next
        dirnames[:] = [
            d
            for d in dirnames
            if d not in {".git", "node_modules", ".next"}
            and not is_excluded(
                (Path(dirpath) / d).resolve().relative_to(root).as_posix()
            )
        ]
        for name in filenames:
            p = Path(dirpath) / name
            if p.is_symlink():
                print(f"fail-closed: symlink rejected: {p}", file=sys.stderr)
                return 2
            if not p.is_file():
                continue
            try:
                rel = p.resolve().relative_to(root).as_posix()
            except ValueError:
                print(f"fail-closed: path escapes repo: {p}", file=sys.stderr)
                return 2
            if is_excluded(rel):
                continue
            if tracked is not None and rel not in tracked:
                continue
            if not match_include(rel):
                continue
            out = dest_root / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, out)
            copied += 1

    for pat in includes:
        # warn on exact-file patterns that never matched
        if "*" in pat or "?" in pat:
            continue
        if not (dest_root / pat).exists() and not (root / pat).exists():
            skipped_missing.append(pat)

    for m in skipped_missing:
        print(f"warning: allowlist miss (skipped): {m}", file=sys.stderr)

    if copied == 0:
        print("fail-closed: allowlist copied 0 files", file=sys.stderr)
        return 2
    print(f"copied {copied} files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
