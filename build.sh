#!/usr/bin/env bash
# Build the loadable extension (dist/) + a Tampermonkey userscript, from src/.
# Re-run whenever src/engine.js or src/panel.js changes — it stamps the engine hash into both so the
# panel's drift guard can verify it's running the matching engine.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE="$DIR/src/engine.js"
PANEL="$DIR/src/panel.js"
[ -f "$ENGINE" ] && [ -f "$PANEL" ] || { echo "build: src/engine.js or src/panel.js missing" >&2; exit 1; }
HASH="$(shasum -a 256 "$ENGINE" | cut -c1-16)"
VER="$(jq -r .version "$DIR/manifest.json" 2>/dev/null || sed -n 's/.*"version"[: ]*"\([^"]*\)".*/\1/p' "$DIR/manifest.json")"

mkdir -p "$DIR/dist/icons"
# panel.js with the drift-guard hash stamped to match this engine
sed "s/var ENGINE_HASH = '[a-f0-9]*'/var ENGINE_HASH = '$HASH'/" "$PANEL" > "$DIR/dist/panel.js"
# engine.js + the stamped __engineHash the panel checks against
cp "$ENGINE" "$DIR/dist/engine.js"
printf '\nwindow.TC && (window.TC.__engineHash=%s);\n' "'$HASH'" >> "$DIR/dist/engine.js"
cp "$DIR/manifest.json" "$DIR/dist/manifest.json"
cp "$DIR/icons/icon-16.png" "$DIR/icons/icon-48.png" "$DIR/icons/icon-128.png" "$DIR/dist/icons/"

# Loadable package — a zip of the unpacked extension for direct download → unzip → Load unpacked
# (e.g. to attach to a GitHub Release). NOT a store upload. Unzips to a taskcall-oncall-toolkit/ folder
# containing ONLY the extension files (manifest at the folder root).
PKG="$DIR/taskcall-oncall-toolkit"
ZIP="$DIR/taskcall-oncall-toolkit-v$VER.zip"
rm -rf "$PKG" "$ZIP"
mkdir -p "$PKG/icons"
cp "$DIR/dist/manifest.json" "$DIR/dist/engine.js" "$DIR/dist/panel.js" "$PKG/"
cp "$DIR/dist/icons/"*.png "$PKG/icons/"
( cd "$DIR" && zip -qr "taskcall-oncall-toolkit-v$VER.zip" "taskcall-oncall-toolkit" )
rm -rf "$PKG"

# Tampermonkey single-file build (engine + panel concatenated, page MAIN world via @grant none)
{
  cat <<HDR
// ==UserScript==
// @name         On-Call Toolkit for TaskCall
// @namespace    taskcall.oncall.toolkit
// @version      $VER
// @description  View, edit & override TaskCall on-call schedules — swaps, covers, override-safe rotation editor
// @match        https://*.taskcallapp.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
HDR
  echo
  echo "// ---- engine (TaskCall on-call console, build-stamped) ----"
  cat "$ENGINE"
  printf '\nwindow.TC && (window.TC.__engineHash=%s);\n' "'$HASH'"
  echo
  echo "// ---- panel ----"
  sed "s/var ENGINE_HASH = '[a-f0-9]*'/var ENGINE_HASH = '$HASH'/" "$PANEL"
} > "$DIR/dist/taskcall-oncall-toolkit.user.js"

echo "built v$VER (engine $HASH):"
echo "  dist/{manifest.json,engine.js,panel.js,icons/}   -> chrome://extensions → Developer mode → Load unpacked → dist/"
echo "  taskcall-oncall-toolkit-v$VER.zip              -> download → unzip → Load unpacked (e.g. a GitHub Release)"
echo "  dist/taskcall-oncall-toolkit.user.js           -> install in Tampermonkey"
