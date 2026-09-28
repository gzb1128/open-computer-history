#!/bin/zsh
set -euo pipefail

root=${0:A:h:h}
node_bin=$(command -v node) || { print -u2 "Node.js is required for local uninstall."; exit 1; }
"$node_bin" "$root/scripts/local-install.mjs" uninstall "$@"
