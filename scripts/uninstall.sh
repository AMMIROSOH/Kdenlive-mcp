#!/usr/bin/env sh
set -eu
INSTALL_DIR=${KDENLIVE_MCP_INSTALL_DIR:-"$HOME/.local/share/kdenlive-mcp"}
rm -rf "$INSTALL_DIR"
printf 'Removed %s. Project directories and MCP client configuration were not deleted.\n' "$INSTALL_DIR"
