#!/usr/bin/env bash
# Daintree CLI — opens a directory as a project in the Daintree app.
# Usage: daintree [directory]   (defaults to current directory)
set -euo pipefail

resolve_script_path() {
  local source="$1"

  while [[ -h "$source" ]]; do
    local dir=""
    dir="$(cd -P "$(dirname "$source")" >/dev/null 2>&1 && pwd)"
    source="$(readlink "$source")"
    [[ "$source" != /* ]] && source="$dir/$source"
  done

  local source_dir=""
  source_dir="$(cd -P "$(dirname "$source")" >/dev/null 2>&1 && pwd)"
  printf "%s/%s\n" "$source_dir" "$(basename "$source")"
}

# Resolve the real script location (follows symlinks) — needed for
# --version, --help (to read app metadata), and app-path discovery.
SCRIPT_PATH="$(resolve_script_path "${BASH_SOURCE[0]}")"

get_version() {
  # Try reading from the app bundle's Info.plist (macOS packaged)
  if [[ "$SCRIPT_PATH" == *".app/"* ]]; then
    local app_bundle="${SCRIPT_PATH%%.app/*}.app"
    local plist="$app_bundle/Contents/Info.plist"
    if [[ -f "$plist" ]] && command -v /usr/libexec/PlistBuddy &>/dev/null; then
      /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$plist" 2>/dev/null && return
    fi
  fi

  local script_dir
  script_dir="$(dirname "$SCRIPT_PATH")"

  # Packaged Linux: the script sits in resources/ beside app.asar, which carries
  # the build stamp uncompressed (scripts/build-main.mjs). LC_ALL=C because
  # macOS 14's grep matches nothing in a UTF-8 locale once it meets a byte
  # that isn't valid UTF-8, and app.asar is binary.
  if [[ -f "$script_dir/app.asar" ]]; then
    local stamp=""
    stamp="$(LC_ALL=C grep -a -o -m 1 -E '[{]"daintreeBuildInfo":1,"version":"[0-9A-Za-z.+-]+"' "$script_dir/app.asar" 2>/dev/null | head -1)"
    if [[ -n "$stamp" ]]; then
      echo "${stamp##*\"version\":\"}" | tr -d '"'
      return
    fi
  fi

  # Try reading from package.json (development)
  for candidate in "$script_dir/../package.json" "$script_dir/../../package.json"; do
    if [[ -f "$candidate" ]]; then
      # Lightweight JSON parse — avoids dependency on jq/python
      sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$candidate" | head -1
      return
    fi
  done

  echo "unknown"
}

# --- Handle flags before directory resolution ---
case "${1:-}" in
  --help|-h)
    cat <<'USAGE'
Usage: daintree [directory]

Open a directory as a project in Daintree.

Arguments:
  directory    Path to open (defaults to current directory)

Options:
  -h, --help       Show this help message
  -v, --version    Show the Daintree CLI version
  -s, --status     Check if Daintree is running

Examples:
  daintree .             Open the current directory
  daintree ~/projects/my-app   Open a specific project
USAGE
    exit 0
    ;;
  --version|-v)
    echo "daintree $(get_version)"
    exit 0
    ;;
  --status|-s)
    if [[ "$(uname)" == "Darwin" ]]; then
      if pgrep -f "Daintree.app/Contents/MacOS" &>/dev/null; then
        echo "Daintree is running"
        exit 0
      fi
    else
      # The pattern also matches this script (run as /usr/bin/daintree) and any
      # shell whose command line names it; only the app's own binary counts.
      for pid in $(pgrep -f "(/|^)daintree([[:space:]]|$)|daintree-app"); do
        exe="$(readlink "/proc/$pid/exe" 2>/dev/null)" || continue
        exe="${exe% (deleted)}"
        case "${exe##*/}" in
          daintree|daintree-app)
            echo "Daintree is running"
            exit 0
            ;;
        esac
      done
    fi
    echo "Daintree is not running"
    exit 1
    ;;
esac

# --- Resolve target directory ---
TARGET="${1:-.}"
ABSOLUTE_PATH="$(cd -- "$TARGET" 2>/dev/null && pwd -P)" || ABSOLUTE_PATH=""

if [[ -z "$ABSOLUTE_PATH" || ! -d "$ABSOLUTE_PATH" ]]; then
  echo "daintree: '$TARGET' is not a directory" >&2
  exit 1
fi

# --- macOS: locate the Daintree.app bundle ---
if [[ "$(uname)" == "Darwin" ]]; then
  # Prefer deriving the app path from the installed symlink target.
  APP_PATH=""
  if [[ "$SCRIPT_PATH" == *".app/"* ]]; then
    APP_PATH="${SCRIPT_PATH%%.app/*}.app"
  fi

  # Fall back to Spotlight if the script is not installed as an app symlink.
  if [[ -z "$APP_PATH" ]] && command -v mdfind &>/dev/null; then
    APP_PATH="$(mdfind 'kMDItemCFBundleIdentifier == "org.daintree.app"' 2>/dev/null | head -1)"
    [[ -n "$APP_PATH" && ! -d "$APP_PATH" ]] && APP_PATH=""
  fi

  # Fall back to common locations.
  if [[ -z "$APP_PATH" ]]; then
    for candidate in \
      "$HOME/Applications/Daintree.app" \
      "/Applications/Daintree.app"; do
      if [[ -d "$candidate" ]]; then
        APP_PATH="$candidate"
        break
      fi
    done
  fi

  if [[ -z "$APP_PATH" ]]; then
    echo "daintree: Daintree.app not found. Please install Daintree first." >&2
    exit 1
  fi

  # open -a respects single-instance; the app's second-instance handler picks up
  # --cli-path. The single-token `=` form is required: Chromium's command-line
  # reconstruction can slot an injected switch between a bare flag and its
  # value (#11410).
  open -a "$APP_PATH" --args --cli-path="$ABSOLUTE_PATH"
  exit 0
fi

# --- Linux: locate the Daintree binary ---
DAINTREE_BIN=""

for candidate in \
  "$(dirname "$(dirname "$SCRIPT_PATH")")/daintree" \
  "$(dirname "$(dirname "$SCRIPT_PATH")")/daintree-app" \
  "${APPDIR:-}/daintree" \
  "${APPDIR:-}/daintree-app" \
  "/opt/Daintree/daintree" \
  "/opt/Daintree/daintree-app"; do
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    DAINTREE_BIN="$candidate"
    break
  fi
done

# PATH lookup (last resort)
if [[ -z "$DAINTREE_BIN" ]]; then
  for command_name in daintree daintree-app; do
    if command -v "$command_name" &>/dev/null; then
      DAINTREE_BIN="$(command -v "$command_name")"
      break
    fi
  done
fi

if [[ -z "$DAINTREE_BIN" ]]; then
  echo "daintree: Daintree executable not found." >&2
  exit 1
fi

# Single-token `=` form — a warm launch here spawns a real second process, whose
# command line Chromium reconstructs and can inject switches into (#11410).
"$DAINTREE_BIN" --cli-path="$ABSOLUTE_PATH" &
exit 0
