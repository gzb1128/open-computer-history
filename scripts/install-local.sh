#!/bin/zsh
set -euo pipefail

root=${0:A:h:h}
node_bin=$(command -v node) || { print -u2 "Node.js 22.22.2 or newer is required."; exit 1; }
args=("$@")

if [[ "${args[1]:-}" == "--plan" || "${args[1]:-}" == "--dry-run" ]]; then
  args=("${(@)args[2,-1]}")
  "$node_bin" "$root/scripts/local-install.mjs" plan "${args[@]}"
  exit
fi

has_bundle=false
for arg in "${args[@]}"; do
  if [[ "$arg" == "--from-bundle" ]]; then
    has_bundle=true
    break
  fi
done
if [[ "$has_bundle" == false ]]; then
  if [[ -d "$root/runtime" && -d "$root/Open Computer History.app" ]]; then
    bundle="$root"
  else
    bundle=$("$root/scripts/build-local-bundle.sh")
  fi
  args+=(--from-bundle "$bundle")
fi
"$node_bin" "$root/scripts/local-install.mjs" install "${args[@]}"
