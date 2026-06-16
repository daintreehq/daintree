#!/usr/bin/env bash
# Verify every standalone Mach-O executable in a macOS .app bundle carries the
# hardened runtime flag. Apple's notary service rejects unhardened executables,
# but `codesign --verify --deep --strict` does NOT assert the runtime flag, so an
# unhardened helper binary can slip through. Dylibs and .node addons are exempt:
# they are loaded into a host process rather than spawned, so they carry no
# process-level execution flags. node-pty's spawn-helper IS a standalone
# executable and must NOT be exempt (see issue #2391).
set -euo pipefail

# Lock `file` output to a stable English description across runner locales.
export LC_ALL=C

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

echo "Verifying hardened runtime on all Mach-O executables in '$APP_BUNDLE'"

executable_count=0
failed=0

while IFS= read -r -d '' file; do
  filetype=$(file -b "$file")
  if ! grep -q "Mach-O" <<<"$filetype"; then
    continue
  fi

  # Dylibs and .node addons are dlopen'd into a host process, not spawned, so
  # they legitimately lack the process-level hardened runtime flag.
  if grep -qE "dynamically linked shared library|bundle" <<<"$filetype"; then
    echo "  SKIP (loaded, not spawned): $file"
    continue
  fi

  executable_count=$((executable_count + 1))

  # `codesign -dv` displays only the host's native architecture slice, so a
  # universal binary whose non-native slice lacks the flag would pass silently.
  # Enumerate every slice with `lipo -archs` and inspect each explicitly.
  archs=$(lipo -archs "$file" 2>/dev/null || true)
  unsigned=0
  missing=""
  checked=0

  for arch in $archs; do
    checked=$((checked + 1))
    info=$(codesign -dv --arch "$arch" "$file" 2>&1) || true
    if grep -q "code object is not signed at all" <<<"$info"; then
      unsigned=1
      break
    fi
    # The CodeDirectory flags line reads e.g. `flags=0x10000(runtime)`; multiple
    # flags appear comma-separated inside the parens, so match `runtime` anywhere
    # within them rather than the exact `(runtime)` substring.
    if ! grep -qE 'flags=0x[0-9a-fA-F]+\([^)]*runtime[^)]*\)' <<<"$info"; then
      missing="$missing $arch"
    fi
  done

  if [[ $checked -eq 0 ]]; then
    echo "::error::FAIL: Could not enumerate architectures (lipo failed): $file"
    failed=$((failed + 1))
  elif [[ $unsigned -eq 1 ]]; then
    echo "::error::FAIL: Unsigned executable: $file"
    failed=$((failed + 1))
  elif [[ -n "$missing" ]]; then
    echo "::error::FAIL: Missing hardened runtime flag on arch(s)$missing: $file"
    failed=$((failed + 1))
  else
    echo "  PASS: $file"
  fi
done < <(find "$APP_BUNDLE" -type f -print0)

if [[ $executable_count -eq 0 ]]; then
  echo "::error::FAIL: No Mach-O executables found in $APP_BUNDLE — bundle is structurally broken"
  exit 1
fi

echo "--------------------------------------------------------"
echo "Mach-O executables scanned: $executable_count"

if [[ $failed -ne 0 ]]; then
  echo "::error::Verification FAILED: $failed executable(s) missing the hardened runtime flag"
  exit 1
fi

echo "Verification SUCCESS: All $executable_count Mach-O executables carry the hardened runtime flag"
