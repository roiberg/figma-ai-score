#!/bin/sh
# Installed shim that postinstall symlinks to ~/.local/bin/figma-ai-score
# (and attempts /usr/local/bin/figma-ai-score). Execs the bundled Node binary
# against cli.js so users don't need a system Node install.

INSTALL_ROOT="$HOME/Library/Application Support/figma-ai-score/cli"
NODE_BIN="$INSTALL_ROOT/node"
CLI_JS="$INSTALL_ROOT/cli.js"

if [ ! -x "$NODE_BIN" ]; then
  echo '{"error":"figma-ai-score install is corrupted: bundled Node missing","code":"INSTALL_BROKEN"}' >&2
  exit 1
fi
if [ ! -f "$CLI_JS" ]; then
  echo '{"error":"figma-ai-score install is corrupted: cli.js missing","code":"INSTALL_BROKEN"}' >&2
  exit 1
fi

exec "$NODE_BIN" "$CLI_JS" "$@"
