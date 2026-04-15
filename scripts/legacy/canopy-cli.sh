#!/usr/bin/env bash
# Canopy CLI (legacy variant) — opens a directory as a project in the Canopy app.
# Usage: canopy-app [directory]   (defaults to current directory)
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

SCRIPT_PATH="$(resolve_script_path "${BASH_SOURCE[0]}")"

get_version() {
  if [[ "$SCRIPT_PATH" == *".app/"* ]]; then
    local app_bundle="${SCRIPT_PATH%%.app/*}.app"
    local plist="$app_bundle/Contents/Info.plist"
    if [[ -f "$plist" ]] && command -v /usr/libexec/PlistBuddy &>/dev/null; then
      /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$plist" 2>/dev/null && return
    fi
  fi

  local script_dir
  script_dir="$(dirname "$SCRIPT_PATH")"
  for candidate in "$script_dir/../package.json" "$script_dir/../../package.json"; do
    if [[ -f "$candidate" ]]; then
      sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$candidate" | head -1
      return
    fi
  done

  echo "unknown"
}

case "${1:-}" in
  --help|-h)
    cat <<'USAGE'
Usage: canopy-app [directory]

Open a directory as a project in Canopy.

Arguments:
  directory    Path to open (defaults to current directory)

Options:
  -h, --help       Show this help message
  -v, --version    Show the Canopy CLI version
  -s, --status     Check if Canopy is running

Note: Canopy is a legacy build. New installs should use Daintree (https://daintree.org).

Examples:
  canopy-app .                   Open the current directory
  canopy-app ~/projects/my-app   Open a specific project
USAGE
    exit 0
    ;;
  --version|-v)
    echo "canopy-app $(get_version)"
    exit 0
    ;;
  --status|-s)
    if [[ "$(uname)" == "Darwin" ]]; then
      if pgrep -f "Canopy.app/Contents/MacOS" &>/dev/null; then
        echo "Canopy is running"
        exit 0
      fi
    else
      if pgrep -f "(/|^)canopy-app([[:space:]]|$)" &>/dev/null; then
        echo "Canopy is running"
        exit 0
      fi
    fi
    echo "Canopy is not running"
    exit 1
    ;;
esac

TARGET="${1:-.}"
ABSOLUTE_PATH="$(cd -- "$TARGET" 2>/dev/null && pwd -P)" || ABSOLUTE_PATH=""

if [[ -z "$ABSOLUTE_PATH" || ! -d "$ABSOLUTE_PATH" ]]; then
  echo "canopy-app: '$TARGET' is not a directory" >&2
  exit 1
fi

if [[ "$(uname)" == "Darwin" ]]; then
  APP_PATH=""
  if [[ "$SCRIPT_PATH" == *".app/"* ]]; then
    APP_PATH="${SCRIPT_PATH%%.app/*}.app"
  fi

  if [[ -z "$APP_PATH" ]] && command -v mdfind &>/dev/null; then
    APP_PATH="$(mdfind 'kMDItemCFBundleIdentifier == "com.canopyide.app"' 2>/dev/null | head -1)"
    [[ -n "$APP_PATH" && ! -d "$APP_PATH" ]] && APP_PATH=""
  fi

  if [[ -z "$APP_PATH" ]]; then
    for candidate in \
      "$HOME/Applications/Canopy.app" \
      "/Applications/Canopy.app"; do
      if [[ -d "$candidate" ]]; then
        APP_PATH="$candidate"
        break
      fi
    done
  fi

  if [[ -z "$APP_PATH" ]]; then
    echo "canopy-app: Canopy.app not found. Please install Canopy first." >&2
    exit 1
  fi

  open -a "$APP_PATH" --args --cli-path "$ABSOLUTE_PATH"
  exit 0
fi

CANOPY_BIN=""

for candidate in \
  "$(dirname "$(dirname "$SCRIPT_PATH")")/canopy-app" \
  "${APPDIR:-}/canopy-app" \
  "/opt/Canopy/canopy-app"; do
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    CANOPY_BIN="$candidate"
    break
  fi
done

if [[ -z "$CANOPY_BIN" ]]; then
  if command -v canopy-app &>/dev/null; then
    CANOPY_BIN="$(command -v canopy-app)"
  fi
fi

if [[ -z "$CANOPY_BIN" ]]; then
  echo "canopy-app: Canopy executable not found." >&2
  exit 1
fi

"$CANOPY_BIN" --cli-path "$ABSOLUTE_PATH" &
exit 0
