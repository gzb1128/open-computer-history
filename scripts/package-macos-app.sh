#!/bin/zsh
set -euo pipefail

root=${0:A:h:h}
configuration=${1:-release}
build_dir=$("$root/scripts/build-collector-local.sh" "$configuration")
app="$root/dist/Open Computer History.app"
fixture_app="$root/dist/Open History Fixture.app"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

cp "$build_dir/open-history-menu" "$app/Contents/MacOS/Open Computer History"
cp "$build_dir/open-history" "$app/Contents/MacOS/open-history"

cat >"$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Open Computer History</string>
  <key>CFBundleExecutable</key>
  <string>Open Computer History</string>
  <key>CFBundleIdentifier</key>
  <string>dev.opencomputerhistory.app</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Open Computer History</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.2.0</string>
  <key>CFBundleVersion</key>
  <string>2</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSAppleEventsUsageDescription</key>
  <string>Open Computer History may activate applications during user-requested verification.</string>
  <key>NSHumanReadableCopyright</key>
  <string>Copyright 2026 Open Computer History contributors</string>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$app"

rm -rf "$fixture_app"
mkdir -p "$fixture_app/Contents/MacOS"
cp "$build_dir/open-history-fixture" \
  "$fixture_app/Contents/MacOS/Open History Fixture"
cp "$build_dir/open-history-fixture-driver" \
  "$fixture_app/Contents/MacOS/Open History Fixture Driver"
cat >"$fixture_app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Open History Fixture</string>
  <key>CFBundleExecutable</key>
  <string>Open History Fixture</string>
  <key>CFBundleIdentifier</key>
  <string>dev.opencomputerhistory.fixture</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Open History Fixture</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.2.0</string>
  <key>CFBundleVersion</key>
  <string>2</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>NSHumanReadableCopyright</key>
  <string>Copyright 2026 Open Computer History contributors</string>
</dict>
</plist>
PLIST
codesign --force --deep --sign - "$fixture_app"

print "$app"
print "$fixture_app"
