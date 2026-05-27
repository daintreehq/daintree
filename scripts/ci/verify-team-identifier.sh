#!/usr/bin/env bash
# Verify every Mach-O binary in a macOS .app bundle shares the expected Team ID.
# Used as a CI gate on release builds to canary the eventual removal of the
# com.apple.security.cs.disable-library-validation entitlement.
set -euo pipefail

APP_BUNDLE="${1:?Usage: $0 <app_bundle_path> <expected_team_id>}"
EXPECTED_TEAM_ID="${2:?Usage: $0 <app_bundle_path> <expected_team_id>}"

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "::error::App bundle directory does not exist: $APP_BUNDLE"
  exit 1
fi

if [[ "$APP_BUNDLE" != *.app ]]; then
  echo "::error::Path does not end in .app: $APP_BUNDLE"
  exit 1
fi

if [[ -z "$EXPECTED_TEAM_ID" || ! "$EXPECTED_TEAM_ID" =~ ^[A-Za-z0-9]{10}$ ]]; then
  echo "::error::Expected Team ID must be a 10-character alphanumeric string, got: '$EXPECTED_TEAM_ID'"
  exit 1
fi

echo "Verifying all Mach-O binaries in '$APP_BUNDLE' share Team ID: $EXPECTED_TEAM_ID"

macho_count=0
failed=0

while IFS= read -r -d '' file; do
  if ! file -b "$file" | grep -q "Mach-O"; then
    continue
  fi

  macho_count=$((macho_count + 1))
  info=$(codesign -dv "$file" 2>&1) || true

  if echo "$info" | grep -q "code object is not signed at all"; then
    echo "::error::FAIL: Unsigned binary: $file"
    failed=$((failed + 1))
    continue
  fi

  team_id=$(echo "$info" | grep '^TeamIdentifier=' | cut -d'=' -f2)

  if [[ "$team_id" == "$EXPECTED_TEAM_ID" ]]; then
    echo "  PASS: $file"
  elif [[ -z "$team_id" ]]; then
    echo "::error::FAIL: No TeamIdentifier in signature: $file"
    failed=$((failed + 1))
  else
    echo "::error::FAIL: Mismatched Team ID on $file (got '$team_id', expected '$EXPECTED_TEAM_ID')"
    failed=$((failed + 1))
  fi
done < <(find "$APP_BUNDLE" -type f -print0)

if [[ $macho_count -eq 0 ]]; then
  echo "::error::FAIL: No Mach-O binaries found in $APP_BUNDLE — bundle is structurally broken"
  exit 1
fi

echo "--------------------------------------------------------"
echo "Mach-O binaries scanned: $macho_count"

if [[ $failed -ne 0 ]]; then
  echo "::error::Verification FAILED: $failed binary(s) have missing or mismatched Team ID"
  exit 1
fi

echo "Verification SUCCESS: All $macho_count Mach-O binaries match Team ID '$EXPECTED_TEAM_ID'"
