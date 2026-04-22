#!/bin/bash
# Builds the figma-ai-score.pkg installer for macOS (arm64, self-contained).
#
# The pkg bundles:
#   - The MCP server source (index.js, package.json, package-lock.json)
#   - Its production node_modules (installed at build time)
#   - The official Node.js binary for darwin-arm64 (downloaded + cached)
#
# This means the installed user needs nothing pre-installed — no Homebrew,
# no Node.js, no npm. Just double-click the pkg.
#
# Usage: ./build-pkg.sh
# Output: ../figma-ai-score.pkg

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MCP_DIR="$PROJECT_DIR/mcp-server"
PKG_OUT="$PROJECT_DIR/figma-ai-score.pkg"
PKG_ID="com.figma-ai-score.mcp"
PKG_VERSION="0.3.0"

# Node.js version to bundle. Pinned for reproducibility; bump when
# shipping security updates.
NODE_VERSION="20.18.1"
NODE_ARCH="darwin-arm64"
NODE_TARBALL="node-v${NODE_VERSION}-${NODE_ARCH}.tar.gz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"

CACHE_DIR="$SCRIPT_DIR/.cache"
PAYLOAD="$SCRIPT_DIR/payload"

echo "=== Building figma-ai-score.pkg v${PKG_VERSION} (self-contained, ${NODE_ARCH}) ==="

# ── 1. Download Node (cached between builds) ──
mkdir -p "$CACHE_DIR"
if [ ! -f "$CACHE_DIR/$NODE_TARBALL" ]; then
  echo "Downloading Node.js $NODE_VERSION (${NODE_ARCH}) ..."
  curl -fSL --progress-bar "$NODE_URL" -o "$CACHE_DIR/$NODE_TARBALL.tmp"
  mv "$CACHE_DIR/$NODE_TARBALL.tmp" "$CACHE_DIR/$NODE_TARBALL"
else
  echo "Using cached Node.js $NODE_VERSION tarball."
fi

# ── 2. Extract the node binary ──
NODE_EXTRACT_DIR="$CACHE_DIR/extracted"
rm -rf "$NODE_EXTRACT_DIR"
mkdir -p "$NODE_EXTRACT_DIR"
tar -xzf "$CACHE_DIR/$NODE_TARBALL" -C "$NODE_EXTRACT_DIR"
NODE_BIN="$NODE_EXTRACT_DIR/node-v${NODE_VERSION}-${NODE_ARCH}/bin/node"
if [ ! -x "$NODE_BIN" ]; then
  echo "ERROR: Node binary not found at $NODE_BIN" >&2
  exit 1
fi

# ── 3. Prepare payload ──
echo "Preparing payload ..."
rm -rf "$PAYLOAD"
mkdir -p "$PAYLOAD/mcp-server"

cp "$MCP_DIR/index.js" "$PAYLOAD/mcp-server/"
cp "$MCP_DIR/package.json" "$PAYLOAD/mcp-server/"
cp "$MCP_DIR/package-lock.json" "$PAYLOAD/mcp-server/"

# Bake node_modules into the payload so the installer doesn't need to
# touch the network or the user's npm.
echo "Installing MCP server dependencies (baked into pkg) ..."
(cd "$PAYLOAD/mcp-server" && npm install --omit=dev --silent 2>&1 | tail -5)

# Bundle the Node.js binary next to the server.
cp "$NODE_BIN" "$PAYLOAD/mcp-server/node"
chmod +x "$PAYLOAD/mcp-server/node"

# ── 4. Make scripts executable ──
chmod +x "$SCRIPT_DIR/scripts/preinstall"
chmod +x "$SCRIPT_DIR/scripts/postinstall"

# ── 5. Build the component pkg ──
echo "Building package ..."
pkgbuild \
  --root "$PAYLOAD" \
  --scripts "$SCRIPT_DIR/scripts" \
  --identifier "$PKG_ID" \
  --version "$PKG_VERSION" \
  --install-location "/tmp/figma-ai-score-pkg" \
  "$PKG_OUT"

# ── 6. Report ──
PKG_SIZE="$(du -h "$PKG_OUT" | awk '{print $1}')"
echo ""
echo "=== Done: $PKG_OUT ($PKG_SIZE) ==="
echo "Self-contained: users need NO prerequisites (no Node.js, no Homebrew)."
echo "Distribute this file. Double-click to install."
