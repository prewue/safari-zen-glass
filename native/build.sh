#!/bin/sh
# Builds native/SafariZenGlass.dylib (arm64 + x86_64) with Xcode's toolchain;
# the macOS 26 SDK is needed for NSGlassEffectView. DEV.md §12.
set -e
cd "$(dirname "$0")"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
OUT=SafariZenGlass.dylib
TMP=$(mktemp -d)
for arch in arm64 x86_64; do
  xcrun swiftc -O -parse-as-library -emit-library \
    -module-name SafariZenGlass \
    -target "$arch-apple-macos12.0" \
    -framework AppKit -framework QuartzCore \
    -Xlinker -install_name -Xlinker "@loader_path/$OUT" \
    -o "$TMP/$arch.dylib" src/SafariZenGlass.swift
done
xcrun lipo -create "$TMP/arm64.dylib" "$TMP/x86_64.dylib" -output "$OUT"
codesign --force --sign - "$OUT"
rm -rf "$TMP"
xcrun lipo -info "$OUT"
