#!/usr/bin/env bash
# Verify every Mach-O binary in a macOS .app bundle is signed with the
# hardened runtime flag. Addresses the gap where `codesign --verify --deep`
# only checks the main executable — embedded helpers, frameworks, and XPC
# services that ship without `--options runtime` pass every standard check
# and only surface on user machines.
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

echo "Verifying hardened runtime flag on all Mach-O binaries in '$APP_BUNDLE'"

macho_count=0
failed=0

while IFS= read -r -d '' file; do
  if ! file -b "$file" | grep -q "Mach-O"; then
    continue
  fi

  macho_count=$((macho_count + 1))
  info=$(codesign -dvvv "$file" 2>&1) || true

  if echo "$info" | grep -q "code object is not signed at all"; then
    echo "::error::FAIL: Unsigned binary: $file"
    failed=$((failed + 1))
    continue
  fi

  if echo "$info" | grep -q "CodeDirectory.*flags=.*runtime"; then
    echo "  PASS: $file"
  else
    echo "::error::FAIL: Hardened runtime flag missing: $file"
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
  echo "::error::Verification FAILED: $failed binary(s) missing hardened runtime flag"
  exit 1
fi

echo "Verification SUCCESS: All $macho_count Mach-O binaries have hardened runtime enabled"
