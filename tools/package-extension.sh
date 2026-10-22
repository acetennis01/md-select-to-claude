#!/usr/bin/env bash
# Builds dist/md-select-to-claude-<version>.zip for upload to the Chrome Web
# Store developer dashboard.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p "require('./extension/manifest.json').version")
mkdir -p dist
out="dist/md-select-to-claude-$version.zip"
rm -f "$out"
(cd extension && zip -qr "../$out" . -x '.DS_Store' '*/.DS_Store')
echo "wrote $out"
unzip -l "$out"
