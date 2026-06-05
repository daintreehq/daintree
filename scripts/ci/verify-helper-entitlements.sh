#!/usr/bin/env bash
# Verify the spawned helper executables (spawn-helper, daintree_pty_supervisor)
# carry NO entitlements. electron-builder signs them via mac.binaries[] with the
# full app plist inherited, which leaks the restricted
# com.apple.security.device.audio-input entitlement onto them. On macOS 26
# (Tahoe) amfid kills any spawned executable claiming a restricted entitlement
# without an embedded provisioning profile (#9775). resign-helpers-macos.cjs
# re-signs them with an empty entitlement set; this gate confirms that stuck.
set -euo pipefail

APP_BUNDLE="${1:?Usage: $0 <app_bundle_path>}"
APP_BUNDLE="${APP_BUNDLE%/}"

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "::error::App bundle directory does not exist: $APP_BUNDLE"
  exit 1
fi

if [[ "$APP_BUNDLE" != *.app ]]; then
  echo "::error::Path does not end in .app: $APP_BUNDLE"
  exit 1
fi

# Paths mirror mac.binaries[] in electron-builder.config.cjs.
HELPERS=(
  "Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper"
  "Contents/Resources/app.asar.unpacked/node_modules/posix-pty-reaper/build/Release/daintree_pty_supervisor"
)

echo "Verifying spawned helpers carry no entitlements in '$APP_BUNDLE'"

failed=0

for rel in "${HELPERS[@]}"; do
  helper="$APP_BUNDLE/$rel"
  if [[ ! -f "$helper" ]]; then
    echo "::error::FAIL: Helper executable not found: $helper"
    failed=$((failed + 1))
    continue
  fi

  # `codesign -d --entitlements -` prints the embedded entitlements as a plist
  # (or nothing when there are none). An empty <dict/> has no <key> elements;
  # any <key> means an entitlement leaked through and amfid will kill the helper.
  # Capture the exit code separately so a codesign failure (unsigned/corrupt
  # binary, unsupported flag) fails closed instead of reading as "no entitlements".
  set +e
  entitlements=$(codesign -d --entitlements - --xml "$helper" 2>/dev/null)
  cs_status=$?
  set -e

  if [[ $cs_status -ne 0 ]]; then
    echo "::error::FAIL: codesign could not read entitlements (exit $cs_status): $helper"
    failed=$((failed + 1))
    continue
  fi

  if echo "$entitlements" | grep -q "<key>"; then
    echo "::error::FAIL: $helper carries entitlements (expected none):"
    echo "$entitlements"
    failed=$((failed + 1))
  else
    echo "  PASS: $helper (no entitlements)"
  fi
done

if [[ $failed -ne 0 ]]; then
  echo "::error::Verification FAILED: $failed helper(s) carry unexpected entitlements"
  exit 1
fi

echo "Verification SUCCESS: All helpers carry no entitlements"
