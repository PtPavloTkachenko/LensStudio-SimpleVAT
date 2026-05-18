#!/usr/bin/env bash
# Rebuild BlenderAddon.zip from the current BlenderAddon/ sources.
# Run this whenever you change files under BlenderAddon/, then commit
# the updated zip so end-users can install without re-zipping themselves.
set -euo pipefail

cd "$(dirname "$0")"

OUT="BlenderAddon.zip"
SRC="BlenderAddon"

if [[ ! -d "$SRC" ]]; then
    echo "✗ $SRC/ not found"
    exit 1
fi

rm -f "$OUT"

# Zip the folder itself (so Blender's "Install from Disk" sees BlenderAddon/
# as the top-level entry — Blender 4.2+ extensions expect this layout).
# Exclude .DS_Store and Python bytecode.
zip -r "$OUT" "$SRC" \
    -x "*.DS_Store" "*__pycache__*" "*.pyc" "*.pyo"

echo "✓ Built $OUT ($(du -h "$OUT" | cut -f1))"
echo ""
echo "To install in Blender:"
echo "  Edit > Preferences > Get Extensions > Install from Disk -> pick $OUT"
