#!/bin/bash
# Builds the figma-ai-score.pkg installer for macOS.
#
# Usage: ./build-pkg.sh
# Output: ../figma-ai-score.pkg

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MCP_DIR="$PROJECT_DIR/mcp-server"
PKG_OUT="$PROJECT_DIR/figma-ai-score.pkg"
PKG_ID="com.figma-ai-score.mcp"
PKG_VERSION="0.1.0"

echo "=== Building figma-ai-score.pkg ==="

# ── 1. Prepare payload ──
echo "Preparing payload ..."
PAYLOAD="$SCRIPT_DIR/payload"
rm -rf "$PAYLOAD"
mkdir -p "$PAYLOAD/mcp-server"

# Copy only source files (not node_modules — npm install runs at install time)
cp "$MCP_DIR/index.js" "$PAYLOAD/mcp-server/"
cp "$MCP_DIR/package.json" "$PAYLOAD/mcp-server/"
cp "$MCP_DIR/package-lock.json" "$PAYLOAD/mcp-server/"

# ── 2. Make scripts executable ──
chmod +x "$SCRIPT_DIR/scripts/preinstall"
chmod +x "$SCRIPT_DIR/scripts/postinstall"

# ── 3. Build the component pkg ──
echo "Building package ..."
pkgbuild \
  --root "$PAYLOAD" \
  --scripts "$SCRIPT_DIR/scripts" \
  --identifier "$PKG_ID" \
  --version "$PKG_VERSION" \
  --install-location "/tmp/figma-ai-score-pkg" \
  "$PKG_OUT"

echo ""
echo "=== Done: $PKG_OUT ==="
echo "Distribute this file. Double-click to install."
