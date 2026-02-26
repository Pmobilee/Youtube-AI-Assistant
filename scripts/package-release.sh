#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OS_LABEL="${1:-}"
VERSION="${2:-}"

if [[ -z "$OS_LABEL" ]]; then
  echo "Usage: ./scripts/package-release.sh <linux|windows|macos> [version]" >&2
  exit 2
fi

if [[ -z "$VERSION" ]]; then
  VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo '0.0.0')"
fi

cd "$REPO_DIR"

mkdir -p dist

PYTHON_BIN="$(command -v python3 || command -v python || true)"
if [[ -z "$PYTHON_BIN" ]]; then
  echo "Python runtime not found (need python3 or python)." >&2
  exit 1
fi

"$PYTHON_BIN" - <<'PY' "$REPO_DIR" "$OS_LABEL" "$VERSION"
import os
import pathlib
import shutil
import sys

repo = pathlib.Path(sys.argv[1]).resolve()
os_label = sys.argv[2]
version = sys.argv[3]

build_dir = repo / 'dist' / f'youtube-ai-assistant-{version}-{os_label}'
if build_dir.exists():
    shutil.rmtree(build_dir)
build_dir.mkdir(parents=True)

include_paths = [
    'server.js',
    'src',
    'references',
    'package.json',
    'package-lock.json',
    '.env.example',
    'README.md',
    'public',
    'views',
    'data',
    'scripts',
    'node_modules',
]

exclude_dirs = {
    '.git',
    '.github',
    'uploads',
    'backups',
    '.data',
    '.implementation-notes',
    '.implementation-status',
    '.features',
    '.feature-status',
}

exclude_globs = [
    '*.db',
    '*.db-wal',
    '*.db-shm',
    '*.log',
    '*.bak',
    '*.backup',
    '*.pre-*.bak',
]

def should_skip(path: pathlib.Path) -> bool:
    name = path.name
    rel = path.relative_to(repo)

    if any(part in exclude_dirs for part in rel.parts):
        return True

    for pat in exclude_globs:
        if path.match(pat):
            return True
    return False

for rel in include_paths:
    src = repo / rel
    if not src.exists():
        continue
    dst = build_dir / rel

    if src.is_dir():
        for root, dirs, files in os.walk(src):
            root_path = pathlib.Path(root)
            rel_root = root_path.relative_to(repo)
            if should_skip(root_path):
                dirs[:] = []
                continue

            # prune dirs in-place
            dirs[:] = [d for d in dirs if not should_skip(root_path / d)]

            target_root = build_dir / rel_root
            target_root.mkdir(parents=True, exist_ok=True)

            for f in files:
                src_file = root_path / f
                if should_skip(src_file):
                    continue
                dst_file = target_root / f
                shutil.copy2(src_file, dst_file)
    else:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)

# Ensure start helpers exist
start_sh = build_dir / 'start.sh'
start_bat = build_dir / 'start.bat'
start_sh.write_text('#!/usr/bin/env bash\nset -euo pipefail\nPORT="${PORT:-3000}" npm start\n', encoding='utf-8')
start_bat.write_text('@echo off\nif "%PORT%"=="" set PORT=3000\ncall npm start\n', encoding='utf-8')

zip_base = repo / 'dist' / f'youtube-ai-assistant-{version}-{os_label}'
zip_path = shutil.make_archive(str(zip_base), 'zip', root_dir=build_dir)
print(zip_path)
PY
