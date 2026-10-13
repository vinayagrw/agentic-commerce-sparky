#!/usr/bin/env python3
"""Check that every rendered .drawio PNG is newer than its .drawio source.

Walks a folder looking for <name>.drawio / <name>.png pairs. Exits 1 and lists
every PNG that is older than its source .drawio file (a stale render that no
longer matches what's shipped); exits 0 when every pair is fresh or no pairs
exist.

Usage:
    python3 scripts/check_diagram_freshness.py [root]

`root` defaults to the repository root, which ships no .drawio sources -- so the
check is a no-op here and passes. Pass a path (or set DIAGRAM_ROOT) to check a
separate documents folder that does hold .drawio/.png pairs.
"""
import os
import sys

# Directories we should never walk into: dependency trees, VCS metadata, etc.
SKIP_DIR_NAMES = {
    "node_modules", ".git", "__pycache__", ".venv", "venv",
    "dist", "build", ".next", ".turbo", ".cache",
}


def default_root() -> str:
    """The repo root, unless DIAGRAM_ROOT points somewhere else.

    This used to default to the grandparent directory, on the assumption that the
    repo sat inside a documents folder holding the .drawio sources. That is true
    on one machine and nowhere else: in a clone it walks whatever happens to be
    two levels up. Default to the repo and let the caller opt in to a wider root.
    """
    env = os.environ.get("DIAGRAM_ROOT")
    if env:
        return env
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def find_stale_pngs(root: str):
    stale = []
    checked = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIR_NAMES]
        drawio_files = {f for f in filenames if f.endswith(".drawio")}
        for f in drawio_files:
            base = f[: -len(".drawio")]
            png_name = base + ".png"
            if png_name not in filenames:
                continue  # no rendered PNG shipped for this source -- not this script's concern
            drawio_path = os.path.join(dirpath, f)
            png_path = os.path.join(dirpath, png_name)
            checked += 1
            try:
                drawio_mtime = os.path.getmtime(drawio_path)
                png_mtime = os.path.getmtime(png_path)
            except OSError as e:
                print(f"warning: could not stat {e.filename}: {e}", file=sys.stderr)
                continue
            if png_mtime < drawio_mtime:
                stale.append((drawio_path, png_path, drawio_mtime, png_mtime))
    return stale, checked


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else default_root()
    root = os.path.abspath(root)
    if not os.path.isdir(root):
        print(f"error: root '{root}' is not a directory", file=sys.stderr)
        return 2

    stale, checked = find_stale_pngs(root)

    if stale:
        print(f"Stale diagram renders found under {root}:\n")
        for drawio_path, png_path, dmtime, pmtime in sorted(stale):
            rel_drawio = os.path.relpath(drawio_path, root)
            rel_png = os.path.relpath(png_path, root)
            age = dmtime - pmtime
            print(f"  {rel_png}")
            print(f"    is older than {rel_drawio} by {age:.0f}s -- re-render it")
        print(f"\n{len(stale)} stale PNG(s) out of {checked} drawio/png pair(s) checked.")
        return 1

    print(f"OK: all {checked} drawio/png pair(s) under {root} are up to date.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
