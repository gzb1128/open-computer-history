#!/bin/zsh
set -euo pipefail

root=${0:A:h:h}
configuration=${1:-release}
case "$configuration" in
  release|debug) ;;
  *) print -u2 "Usage: $0 [release|debug]"; exit 2 ;;
esac

mkdir -p "$root/collector/.build"
build_dir=$(mktemp -d "$root/collector/.build/local-$configuration.XXXXXX")
trap 'rm -rf "$build_dir"' ERR

if swift build --package-path "$root/collector" -c "$configuration" \
  --scratch-path "$build_dir/swiftpm" >"$build_dir/swiftpm.log" 2>&1; then
  bin_dir=$(swift build --package-path "$root/collector" -c "$configuration" \
    --scratch-path "$build_dir/swiftpm" --show-bin-path)
  for name in open-history open-history-menu open-history-fixture open-history-fixture-driver; do
    cp "$bin_dir/$name" "$build_dir/$name"
  done
  print "$build_dir"
  exit
fi
if ! grep -Eq 'SwiftBridging|PackageDescription|module\.modulemap' "$build_dir/swiftpm.log"; then
  cat "$build_dir/swiftpm.log" >&2
  print -u2 "SwiftPM build failed for a source error; local toolchain fallback was not attempted."
  exit 1
fi
print -u2 "SwiftPM encountered an incompatible local Command Line Tools module; compiling a fresh source build with a scoped VFS overlay."

overlay_flags=()
obsolete_map=/Library/Developer/CommandLineTools/usr/include/swift/module.modulemap
replacement_map=/Library/Developer/CommandLineTools/usr/include/swift/bridging.modulemap
if [[ -f "$obsolete_map" && -f "$replacement_map" ]] &&
  grep -q 'module SwiftBridging' "$obsolete_map" &&
  grep -q 'module SwiftBridging' "$replacement_map"; then
  : >"$build_dir/empty.modulemap"
  node -e 'const fs=require("node:fs"); const [output, obsolete, empty]=process.argv.slice(1); fs.writeFileSync(output, JSON.stringify({version:0,roots:[{type:"file",name:obsolete,"external-contents":empty}]}));' \
    "$build_dir/overlay.json" "$obsolete_map" "$build_dir/empty.modulemap"
  overlay_flags=(-vfsoverlay "$build_dir/overlay.json" -Xcc -ivfsoverlay -Xcc "$build_dir/overlay.json")
fi

optimization=()
if [[ "$configuration" == release ]]; then
  optimization=(-O)
fi
target="$(uname -m)-apple-macosx14.0"

# Compile from source in a fresh directory. This avoids stale SwiftPM manifest
# interfaces in mixed Command Line Tools installs without changing the toolchain.
swiftc -target "$target" -swift-version 5 -parse-as-library "${optimization[@]}" "${overlay_flags[@]}" \
  -emit-module -emit-library -static -module-name HistoryCore \
  -emit-module-path "$build_dir/HistoryCore.swiftmodule" \
  -o "$build_dir/libHistoryCore.a" \
  "$root"/collector/Sources/HistoryCore/*.swift

swiftc -target "$target" -swift-version 5 "${optimization[@]}" "${overlay_flags[@]}" \
  -I "$build_dir" -L "$build_dir" -lHistoryCore \
  -framework AppKit -framework ApplicationServices -framework CoreGraphics \
  -o "$build_dir/open-history" "$root"/collector/Sources/OpenHistory/*.swift

swiftc -target "$target" -swift-version 5 -parse-as-library "${optimization[@]}" "${overlay_flags[@]}" \
  -I "$build_dir" -L "$build_dir" -lHistoryCore \
  -framework AppKit -framework SwiftUI \
  -o "$build_dir/open-history-menu" "$root"/collector/Sources/OpenHistoryMenu/*.swift

swiftc -target "$target" -swift-version 5 -parse-as-library "${optimization[@]}" "${overlay_flags[@]}" \
  -framework AppKit -framework SwiftUI \
  -o "$build_dir/open-history-fixture" "$root"/collector/Sources/OpenHistoryFixture/*.swift

swiftc -target "$target" -swift-version 5 -parse-as-library "${optimization[@]}" "${overlay_flags[@]}" \
  -framework AppKit -framework ApplicationServices -framework CoreGraphics \
  -o "$build_dir/open-history-fixture-driver" \
  "$root"/collector/Sources/OpenHistoryFixtureDriver/*.swift

print "$build_dir"
