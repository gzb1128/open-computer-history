#!/bin/zsh
set -euo pipefail

root=${0:A:h:h}
bundle="$root/dist/Open Computer History Bundle"
runtime="$bundle/runtime"

if [[ ! -x "$root/node_modules/.bin/mcp-use" || ! -x "$root/node_modules/.bin/esbuild" ]]; then
  print -u2 "Project dependencies are missing. Run npm ci before building a local bundle."
  exit 1
fi

npm --prefix "$root" run build >&2
"$root/scripts/package-macos-app.sh" release >/dev/null

rm -rf "$bundle"
mkdir -p "$runtime/bin" "$runtime/.mcp-use" "$runtime/scripts" "$bundle/scripts"
ditto "$root/dist/Open Computer History.app" "$bundle/Open Computer History.app"
ditto "$root/.mcp-use/build" "$runtime/.mcp-use/build"
ditto "$root/node_modules" "$runtime/node_modules"
cp "$root/package.json" "$runtime/package.json"
for name in install-local.sh uninstall-local.sh local-install.mjs local-service-manifest.mjs; do
  cp "$root/scripts/$name" "$bundle/scripts/$name"
done
for name in uninstall-local.sh local-install.mjs local-service-manifest.mjs; do
  cp "$root/scripts/$name" "$runtime/scripts/$name"
done
"$root/node_modules/.bin/esbuild" "$root/scripts/native-ipc.ts" \
  --bundle --platform=node --format=esm --target=node22 \
  --outfile="$runtime/bin/native-ipc.mjs"
"$root/node_modules/.bin/esbuild" "$root/scripts/pipeline.ts" \
  --bundle --platform=node --format=esm --target=node22 \
  --outfile="$runtime/bin/pipeline.mjs"
"$root/node_modules/.bin/esbuild" "$root/scripts/doctor.ts" \
  --bundle --platform=node --format=esm --target=node22 \
  --outfile="$runtime/bin/doctor.mjs"

print "$bundle"
