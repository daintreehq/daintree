#!/usr/bin/env bash
# Verify the macOS ZIPs we actually ship still contain a validly signed bundle
# AFTER a round trip through the archive.
#
# The pre-zip "Verify macOS signing audit" step audits release/mac*/Daintree.app
# — the directories on disk. Those are NOT the bytes users receive. electron-
# builder produces the shipped ZIP through its own archive path
# (app-builder-lib sets `preserveSymlinks: isMac`, which selects Info-ZIP
# `/usr/bin/zip -q -r -y`), whereas notarize-macos.cjs submits a SEPARATE
# `ditto`-built archive to Apple. So notarization proves nothing about the
# integrity of the upload, and until this gate existed nothing re-opened the
# shipped ZIP at all (#11481).
#
# Extraction uses `ditto -x -k` because that is what both Squirrel's ShipIt and
# a user double-clicking in Finder use — verifying via any other extractor would
# audit a code path nobody runs.
set -euo pipefail

EXPECTED_TEAM_ID="${1:?Usage: $0 <expected_team_id> <archive.zip> [archive.zip ...]}"
shift

if [[ ! "$EXPECTED_TEAM_ID" =~ ^[A-Za-z0-9]{10}$ ]]; then
  echo "::error::Expected Team ID must be a 10-character alphanumeric string, got: '$EXPECTED_TEAM_ID'"
  exit 1
fi

if [[ $# -eq 0 ]]; then
  echo "::error::No archives supplied — refusing to pass a release gate that verified nothing"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Scoped to the single archive being processed, and reset per iteration so the
# trap can never target a stale (or empty) path. Peak disk stays at one extracted
# bundle: the runner is already holding three .app dirs, three DMGs and three
# ZIPs, so extracting all of them at once would risk filling it.
WORK_DIR=""
cleanup() {
  local dir="$WORK_DIR"
  # Clear first so a re-entrant call (or a later trap) can't target a path this
  # invocation is already deleting.
  WORK_DIR=""
  if [[ -n "$dir" && -d "$dir" ]]; then
    rm -rf "$dir"
  fi
}
trap cleanup EXIT
# A bash signal trap does not itself terminate the script — without re-raising,
# a cancelled CI job would run the handler and then carry on verifying.
# Re-raising with the default disposition exits, which fires the EXIT trap.
for sig in INT TERM; do
  # shellcheck disable=SC2064 # expand $sig now, at trap-registration time
  trap "trap - $sig EXIT; cleanup; kill -s $sig \$\$" "$sig"
done

failed=0
verified=0

for archive in "$@"; do
  echo "::group::Verify shipped archive — $archive"

  if [[ ! -f "$archive" ]]; then
    echo "::error::Archive does not exist: $archive"
    failed=$((failed + 1))
    echo "::endgroup::"
    continue
  fi

  cleanup
  WORK_DIR="$(mktemp -d)"

  if ! ditto -x -k "$archive" "$WORK_DIR"; then
    echo "::error::FAIL: ditto could not extract $archive — the shipped archive is corrupt"
    failed=$((failed + 1))
    echo "::endgroup::"
    continue
  fi

  # `ditto -c -k --keepParent` (and electron-builder's equivalent) stores exactly
  # one top-level .app. Anything else means the archive layout changed and the
  # updater would not find the bundle where it expects it.
  app_count=$(find "$WORK_DIR" -maxdepth 1 -name '*.app' -type d | wc -l | tr -d ' ')
  if [[ "$app_count" -ne 1 ]]; then
    echo "::error::FAIL: expected exactly 1 top-level .app in $archive, found $app_count"
    find "$WORK_DIR" -maxdepth 1 -print
    failed=$((failed + 1))
    echo "::endgroup::"
    continue
  fi

  app="$(find "$WORK_DIR" -maxdepth 1 -name '*.app' -type d)"
  archive_failed=0

  # The load-bearing check: --deep --strict is the ONLY one of these that detects
  # a broken CodeResources seal. `stapler validate` and `codesign -dvvv` both
  # report a damaged bundle as healthy.
  echo "--- codesign --verify --deep --strict: $app"
  if ! codesign --verify --deep --strict --verbose=4 "$app"; then
    echo "::error::FAIL: extracted bundle from $archive does not pass codesign --verify --deep --strict"
    archive_failed=1
  fi

  # Re-run the same signing audits the pre-zip step applies, so the extracted
  # payload is held to exactly one standard rather than a weaker one.
  if ! "$SCRIPT_DIR/verify-team-identifier.sh" "$app" "$EXPECTED_TEAM_ID"; then
    archive_failed=1
  fi
  if ! "$SCRIPT_DIR/verify-hardened-runtime.sh" "$app"; then
    archive_failed=1
  fi
  if ! "$SCRIPT_DIR/verify-helper-entitlements.sh" "$app"; then
    archive_failed=1
  fi

  if [[ $archive_failed -ne 0 ]]; then
    echo "::error::Verification FAILED for shipped archive: $archive"
    failed=$((failed + 1))
  else
    echo "  PASS: $archive"
    verified=$((verified + 1))
  fi

  echo "::endgroup::"
done

cleanup
WORK_DIR=""

echo "--------------------------------------------------------"
echo "Shipped archives verified: $verified"

if [[ $failed -ne 0 ]]; then
  echo "::error::Verification FAILED: $failed shipped archive(s) contain an invalid bundle"
  exit 1
fi

echo "Verification SUCCESS: All $verified shipped archive(s) contain a validly signed bundle"
