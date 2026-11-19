#!/usr/bin/env bash
# Daintree CLI — opens a directory as a project in the Daintree app.
# Usage: daintree [directory]   (defaults to current directory)
set -euo pipefail

resolve_script_path() {
  local source="$1"

  while [[ -h "$source" ]]; do
    local dir=""
    dir="$(CDPATH= cd -P "$(dirname "$source")" >/dev/null 2>&1 && pwd)"
    source="$(readlink "$source")"
    [[ "$source" != /* ]] && source="$dir/$source"
  done

  local source_dir=""
  source_dir="$(CDPATH= cd -P "$(dirname "$source")" >/dev/null 2>&1 && pwd)"
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

# >>> daintree call >>>
# `daintree call`: one call to one of Daintree's MCP tools, as the caller. Inside
# an agent pane that has Daintree MCP, that is the pane's own bearer, which the
# launch puts in DAINTREE_MCP_TOKEN beside DAINTREE_MCP_URL; elsewhere, a
# Settings API key exported by hand, sent to the port the running Daintree
# published in its runtime file unless DAINTREE_MCP_URL names another. It adds
# no tools: tiers, ownership and the audit are the server's, as for any MCP
# client. Each call opens a session and
# closes it again, so a script doesn't hold a slot of the pane's session cap,
# and a pane bearer's ownership belongs to the pane, so a later call can drive
# what an earlier one launched. An API key owns only what it creates in one
# session, so `daintree session start` opens one that later calls continue,
# named by DAINTREE_MCP_SESSION, until `daintree session end`. The block also
# holds `daintree --status`, which reads the same runtime file. Self-contained
# (the AppImage wrapper embeds this block) and limited to bash 3.2, curl and
# POSIX awk: no jq, python or node.

# Never a value from the environment: it is the program every reply and the
# config file are read with.
DTC_AWK=""

daintree_call_usage() {
  cat <<'USAGE'
Usage: daintree call <tool> [--arg key=value]... [--json]
       daintree call <tool> --args '<json object>' [--json]
       daintree call <tool> --args - [--json]    (the object on stdin)

Call one of Daintree's MCP tools from a script or a git hook, with the access
the caller already has.

In an agent pane of a project with Daintree MCP on, the pane's own credential is
used (DAINTREE_MCP_URL and DAINTREE_MCP_TOKEN), so one call can send to an agent
an earlier call launched. Anywhere else, export the key from Settings > MCP
server as DAINTREE_MCP_TOKEN: the running Daintree's port is found by itself,
and DAINTREE_MCP_URL, exported as well, picks a dev build or another profile.
That key owns only what it creates in one session, and each call opens its own
and closes it on exit, unless DAINTREE_MCP_SESSION names a session held open by
daintree session start (see daintree session --help).

Options:
  --arg key=value   A string argument (repeatable; the value may contain '=')
  --args <json>     All arguments as one JSON object, for numbers, booleans,
                    arrays and objects. "-" reads it from stdin, which keeps a
                    prompt out of the process list, where --arg values and an
                    inline --args are visible to other users
  --json            Print the whole tool result as JSON
  -h, --help        Show this help message

Exit status:
  0  the tool succeeded; its text is on stdout
  1  the tool reported an error (its text is on stderr), or Daintree refused
     the call or its session
  2  usage error
  3  no answer: Daintree isn't reachable, or the reply wasn't understood. A
     call that was already sent may have run, so check before repeating it
  4  no usable credential or endpoint: DAINTREE_MCP_TOKEN is missing,
     malformed, or refused, DAINTREE_MCP_URL is malformed, or, without it, no
     running Daintree has published its MCP endpoint
  5  the session in DAINTREE_MCP_SESSION is gone; nothing ran

Examples:
  daintree call actions.search --arg 'query=send to an owned terminal'
  daintree call actions.getSchema --arg actionId=terminal.sendCommandOwned
  daintree call terminal.list --json
USAGE
}

daintree_session_usage() {
  cat <<'USAGE'
Usage: daintree session start
       daintree session end

Hold one session open across separate daintree call processes. The Settings
API key owns only what it creates in the session it is using, so a script that
launches an agent with one call and sends to it with the next needs both calls
in one session:

  handle=$(daintree session start) || exit
  export DAINTREE_MCP_SESSION=$handle
  daintree call agent.launch --arg agentId=claude --json
  daintree call terminal.sendCommandOwned --args - < send.json
  daintree session end && unset DAINTREE_MCP_SESSION

where send.json is {"terminalId": "<the launch's terminalId>", "command": "..."}.

start opens a session with DAINTREE_MCP_TOKEN (and DAINTREE_MCP_URL, or else
the running Daintree's published endpoint, as for daintree call) and prints
its handle, refusing while DAINTREE_MCP_SESSION names one already. Every
daintree call made with the handle in DAINTREE_MCP_SESSION runs in that
session; end closes it. The handle holds no credential and is useless without
the one that opened it.

The session ends with end, after 30 minutes without a call (time asleep
doesn't count), or when Daintree's MCP server stops, restarts or changes its
key. What it created stays where it is, owned by no session, and a later call
with the handle fails (exit 5, or 4 for a changed key, 3 while Daintree isn't
answering) rather than open a new session in its place. Within 120 seconds, a
repeated creation call with the same arguments in the same session can get the
first call's answer back instead of creating again; give each its own
requestKey to create two.

In an agent pane the pane's credential already owns what its calls create, so
a held session adds nothing there. It holds one of the pane's eight sessions
until it ends or the pane exits, and a ninth can evict it.

Exit status:
  0  done; start prints the handle on stdout
  1  Daintree refused the session
  2  usage error: DAINTREE_MCP_SESSION already names a session for start, or
     is missing or malformed for end
  3  no answer: Daintree isn't reachable, or the reply wasn't understood
  4  no usable credential or endpoint, as for daintree call
  5  the session in DAINTREE_MCP_SESSION is gone
USAGE
}

# The diagnostic is written from a subshell: a closed stderr would otherwise
# kill this shell with SIGPIPE before it exits with the status asked for.
daintree_call_fail() {
  (echo "daintree ${DTC_COMMAND:-call}: $2" >&2) || true
  exit "$1"
}

# The JSON string literal for $1, in DTC_QUOTED: no subshell per argument.
daintree_call_quote() {
  local s=$1 oct ch hex
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  if [[ $s == *[$'\001'-$'\037']* ]]; then
    for oct in 001 002 003 004 005 006 007 010 013 014 016 017 020 021 022 023 024 025 026 027 030 031 032 033 034 035 036 037; do
      printf -v ch "\\$oct"
      printf -v hex '\\u%04x' "$((8#$oct))"
      s=${s//$ch/$hex}
    done
  fi
  DTC_QUOTED="\"$s\""
}

# The headers for the next request, written fresh each time so the session id
# is sent exactly once. A file, not argv: argv is visible to other users.
daintree_call_write_headers() {
  local extra=""
  [[ -z $DTC_SESSION ]] || extra="${extra}Mcp-Session-Id: $DTC_SESSION"$'\n'
  [[ -z $DTC_VERSION ]] || extra="${extra}MCP-Protocol-Version: $DTC_VERSION"$'\n'
  printf 'Authorization: Bearer %s\nContent-Type: application/json\nAccept: application/json, text/event-stream\nExpect:\n%s' \
    "$DTC_TOKEN" "$extra" > "$DTC_TMP/request-headers"
}

# One request to the endpoint; with no body, the DELETE that ends the session.
# Run in the background and waited on, so a signal reaches the trap while curl
# is still out instead of after it returns.
daintree_call_request() {
  local body=$1 max_time=$2 headers_out=$3 rc=0 send=--data-binary data="@$1"
  [[ -n $body ]] || { send=-X; data=DELETE; }
  rm -f "$DTC_TMP/reply" "$headers_out" "$DTC_TMP/status"
  daintree_call_write_headers || daintree_call_fail 3 "could not write the request"
  curl -q -sS --noproxy '*' --proto =http --connect-timeout 3 ${max_time:+--max-time "$max_time"} \
    -H @"$DTC_TMP/request-headers" "$send" "$data" \
    -o "$DTC_TMP/reply" -D "$headers_out" -w '%{http_code}' \
    "$DTC_ENDPOINT" > "$DTC_TMP/status" 2> "$DTC_TMP/curl-error" &
  wait "$!" || rc=$?
  DTC_STATUS=$(cat "$DTC_TMP/status" 2>/dev/null || true)
  return "$rc"
}

daintree_call_curl_error() {
  local detail
  detail=$(LC_ALL=C tr -d '\000-\010\013-\037' < "$DTC_TMP/curl-error" 2>/dev/null | head -c 300 || true)
  printf '%s' "${detail:-curl failed}"
}

# What a refusal's body says, cut short and stripped of control characters.
daintree_call_reply_excerpt() {
  LC_ALL=C tr -d '\000-\010\013-\037' < "$DTC_TMP/reply" 2>/dev/null | head -c 300 || true
}

# Files the session the moment its id is known, from whatever headers arrived:
# a pane session has no idle timeout, and one left open counts toward the
# pane's session cap until the pane exits.
daintree_call_adopt_session() {
  local id
  [[ -z $DTC_SESSION && -n $DTC_TMP && -f $DTC_TMP/init-headers ]] || return 0
  id=$(awk '{ sub(/\r$/, ""); i = index($0, ":"); if (i > 1 && tolower(substr($0, 1, i - 1)) == "mcp-session-id") { v = substr($0, i + 1); sub(/^[ \t]+/, "", v); sub(/[ \t]+$/, "", v); id = v } } END { print id }' "$DTC_TMP/init-headers" 2>/dev/null || true)
  [[ $id =~ ^[!-~]+$ ]] || return 0
  DTC_SESSION=$id
}

# The exit trap. It runs to the end whatever arrives meanwhile: cut short, it
# would leave the bearer's file behind or the session open. It closes only a
# session this process opened and hasn't handed over (DTC_CLOSE), never a held
# one.
daintree_call_cleanup() {
  trap '' INT TERM HUP
  local pid
  # The only children are requests; KILL, since one started with TERM ignored
  # would otherwise hold the wait below forever.
  for pid in $(jobs -p); do
    kill -KILL "$pid" 2> /dev/null || true
  done
  wait 2> /dev/null || true
  daintree_call_adopt_session || true
  if [[ ${DTC_CLOSE:-0} -eq 1 && -n $DTC_SESSION && -n $DTC_TMP ]] && daintree_call_pinned &&
    daintree_call_write_headers 2> /dev/null; then
    # Best effort, bounded: a refused DELETE must not read as a failed call.
    curl -q -sS --noproxy '*' --proto =http --connect-timeout 2 --max-time 2 \
      -X DELETE -H @"$DTC_TMP/request-headers" -o /dev/null "$DTC_ENDPOINT" > /dev/null 2>&1 || true
  fi
  if [[ -n $DTC_TMP ]]; then
    rm -rf "$DTC_TMP" 2> /dev/null || true
  fi
  DTC_SESSION=""
  DTC_TMP=""
}

daintree_call_refused() {
  if [[ $DTC_STATUS == 401 ]]; then
    daintree_call_fail 4 "Daintree refused DAINTREE_MCP_TOKEN (HTTP 401). A pane's credential ends with its agent; outside a pane, use the key from Settings > MCP server."
  fi
}

# The server answers 404 for a session it doesn't have, or that another
# credential opened, before the request reaches it.
daintree_call_gone() {
  if [[ $DTC_STATUS == 404 ]]; then
    daintree_call_fail 5 "the session in DAINTREE_MCP_SESSION is gone: it was ended, went 30 minutes without a call, was evicted, was dropped when Daintree's MCP server restarted, or belongs to another credential. Nothing ran, and no new session was opened; unset DAINTREE_MCP_SESSION and start another with daintree session start."
  fi
}

# The session a handle from `daintree session start` names, into
# DTC_HELD_VERSION and DTC_HELD_SESSION: the protocol version negotiated when
# it opened, a colon, then its id.
daintree_call_parse_handle() {
  local handle=$1
  DTC_HELD_VERSION=${handle%%:*}
  DTC_HELD_SESSION=${handle#*:}
  if [[ $handle != *:* || ! $DTC_HELD_VERSION =~ ^[0-9A-Za-z.-]+$ || ! $DTC_HELD_SESSION =~ ^[!-~]+$ ]]; then
    daintree_call_fail 2 "DAINTREE_MCP_SESSION isn't a handle printed by daintree session start"
  fi
}

# A JSON-RPC id no other call in a held session is using. Each call there is a
# process of its own, so nothing can count; 52 random bits with bit 52 set stay
# below 2^53, exact through JSON.parse and awk, and never meet the handshake's 1.
daintree_call_fresh_id() {
  local hex
  hex=$(od -An -N7 -tx1 /dev/urandom 2> /dev/null | tr -d ' \n') || hex=""
  [[ $hex =~ ^[0-9a-f]{14}$ ]] || daintree_call_fail 3 "could not read /dev/urandom for a request id"
  DTC_ID=$(((16#$hex & 0xfffffffffffff) | 0x10000000000000))
}

# The installed app's userData, where it publishes mcp-runtime.json while its
# MCP server serves. A dev build or another profile keeps its own elsewhere and
# is reached through DAINTREE_MCP_URL instead.
daintree_user_data_dir() {
  if [[ $(uname) == Darwin ]]; then
    printf '%s\n' "${HOME:-}/Library/Application Support/Daintree"
  elif [[ ${XDG_CONFIG_HOME:-} == /* ]]; then
    printf '%s\n' "$XDG_CONFIG_HOME/Daintree"
  else
    # A relative XDG_CONFIG_HOME means nothing from another directory.
    printf '%s\n' "${HOME:-}/.config/Daintree"
  fi
}

# Sets DTC_STAMP to when `pid` started, in the form Daintree records it
# (electron/services/mcp-server/discoveryFile.ts), when it is a live Daintree
# app running as this user; fails for anything else. Root's kill -0 reaches
# every process, so the owner is checked as well.
daintree_process_stamp() {
  local pid=$1 out exe stat boot
  DTC_STAMP=""
  kill -0 "$pid" 2> /dev/null || return 1
  if [[ $(uname) == Darwin ]]; then
    out=$(LC_ALL=C TZ=UTC0 ps -ww -o uid= -o lstart= -o comm= -p "$pid" 2> /dev/null) || return 1
    # The owner, five fields of start time, then the executable's path, spaces
    # and all: the app's main executable under whatever its bundle is called.
    set -f
    set -- $out
    set +f
    [[ $# -ge 7 && $1 == "$EUID" ]] || return 1
    DTC_STAMP="$2 $3 $4 $5 $6"
    shift 6
    exe="$*"
    [[ $exe == */*.app/Contents/MacOS/Daintree ]] || return 1
  else
    [[ -O /proc/$pid ]] || return 1
    exe=$(readlink "/proc/$pid/exe" 2> /dev/null) || return 1
    exe=${exe% (deleted)}
    case "${exe##*/}" in
      daintree|daintree-app) ;;
      *) return 1 ;;
    esac
    # The whole record, as Daintree reads it: a command name can hold a newline.
    stat=$(cat "/proc/$pid/stat" 2> /dev/null) || return 1
    IFS= read -r boot 2> /dev/null < /proc/sys/kernel/random/boot_id || return 1
    # Field 22, counted from after the command name, which may hold spaces or
    # parentheses of its own.
    stat=${stat##*") "}
    set -f
    set -- $stat
    set +f
    [[ $# -ge 20 && ${20} =~ ^[0-9]+$ ]] || return 1
    DTC_STAMP="${20}@$boot"
  fi
}

# Sets DTC_FOUND to "pid port stamp" from the runtime file the running Daintree
# published, when that Daintree is still the one that wrote it; fails for a
# missing, malformed or stale file. A crash leaves the file behind, and its port
# may since be another listener's, which would be sent the bearer.
daintree_discover() {
  local file record pid port stamp
  DTC_FOUND=""
  file="$(daintree_user_data_dir)/mcp-runtime.json"
  [[ -f $file && ! -L $file && -O $file ]] || return 1
  daintree_call_load_awk
  record=$(head -c 4096 "$file" 2> /dev/null | LC_ALL=C awk -v mode=runtime "$DTC_AWK" 2> /dev/null) || return 1
  read -r pid port stamp <<< "$record"
  daintree_process_stamp "$pid" || return 1
  [[ $DTC_STAMP == "$stamp" ]] || return 1
  DTC_FOUND="$pid $port $stamp"
}

# Whether a Daintree app is running here, by its processes alone.
daintree_running() {
  local pid exe
  if [[ $(uname) == Darwin ]]; then
    pgrep -f "Daintree.app/Contents/MacOS" > /dev/null 2>&1
    return
  fi
  # The pattern also matches this script (run as /usr/bin/daintree) and any
  # shell whose command line names it; only the app's own binary counts.
  for pid in $(pgrep -f "(/|^)daintree([[:space:]]|$)|daintree-app" 2> /dev/null); do
    exe="$(readlink "/proc/$pid/exe" 2> /dev/null)" || continue
    exe="${exe% (deleted)}"
    case "${exe##*/}" in
      daintree|daintree-app) return 0 ;;
    esac
  done
  return 1
}

# The saved MCP server setting, true or false; fails when it can't be read,
# and for a file past 1 MiB, which awk would take seconds over.
daintree_saved_mcp_enabled() {
  local file
  file="$(daintree_user_data_dir)/config.json"
  [[ -f $file && -r $file ]] || return 1
  daintree_call_load_awk
  head -c 1048576 "$file" 2> /dev/null | LC_ALL=C awk -v mode=enabled "$DTC_AWK" 2> /dev/null
}

# `daintree --status [--json]`: $1 is the version (read only for --json), the
# rest what followed --status. Exits 0 while Daintree runs and 1 otherwise.
daintree_status() {
  local version=$1 running=false enabled=null port=null
  shift
  if [[ ${1:-} != --json ]]; then
    if daintree_running; then
      echo "Daintree is running"
      exit 0
    fi
    echo "Daintree is not running"
    exit 1
  fi
  if [[ $# -gt 1 ]]; then
    echo "daintree: --status --json takes no other arguments" >&2
    exit 2
  fi
  if daintree_discover; then
    running=true
    enabled=true
    port=${DTC_FOUND#* }
    port=${port%% *}
  else
    if daintree_running; then running=true; fi
    enabled=$(daintree_saved_mcp_enabled) || enabled=null
    [[ $enabled == true || $enabled == false ]] || enabled=null
  fi
  daintree_call_quote "$version"
  printf '{"version":%s,"running":%s,"mcpEnabled":%s,"mcpPort":%s}\n' "$DTC_QUOTED" "$running" "$enabled" "$port"
  if [[ $running == true ]]; then exit 0; fi
  exit 1
}

# A discovered endpoint is used only while the record that named it stands:
# once that Daintree stops or moves, its old port may be another listener's.
daintree_call_pinned() {
  [[ -n ${DTC_PINNED:-} ]] || return 0
  daintree_discover && [[ $DTC_FOUND == "$DTC_PINNED" ]]
}

daintree_call_still_pinned() {
  daintree_call_pinned || daintree_call_fail 3 "Daintree's MCP endpoint changed $1"
}

# What every request needs: the bearer from the environment, the endpoint from
# DAINTREE_MCP_URL or else the runtime file, curl, the traps, and the private
# directory the bearer is written to.
daintree_call_setup() {
  local url=${DAINTREE_MCP_URL:-} token=${DAINTREE_MCP_TOKEN:-} pinned="" port
  if [[ -z $token ]]; then
    daintree_call_fail 4 "DAINTREE_MCP_TOKEN is not set. Run it in an agent pane of a project with Daintree MCP on, or export the key from Settings > MCP server as DAINTREE_MCP_TOKEN (with DAINTREE_MCP_URL too, for a dev build or another profile)."
  fi
  if [[ $token == *[$'\001'-$'\037'$'\177']* || $token == *" "* ]]; then
    daintree_call_fail 4 "DAINTREE_MCP_TOKEN is malformed"
  fi
  if [[ -z $url ]]; then
    daintree_discover || daintree_call_fail 4 "DAINTREE_MCP_URL is not set, and no running Daintree has published its MCP endpoint. Turn on Settings > MCP server, or export DAINTREE_MCP_URL for a dev build or another profile."
    pinned=$DTC_FOUND
    port=${pinned#* }
    DTC_ENDPOINT="http://127.0.0.1:${port%% *}/mcp"
  # Loopback only, so the bearer never leaves the machine whatever the env
  # says, and always 127.0.0.1, the address Daintree binds: `localhost` can
  # resolve to ::1, where something else may listen on the same port. Claude's
  # Assistant pane is handed the legacy /sse URL; the same listener and bearer
  # serve Streamable HTTP at /mcp.
  elif [[ $url =~ ^http://(127\.0\.0\.1|localhost):([0-9]{1,5})(/mcp|/sse)?/?$ ]] &&
    ((10#${BASH_REMATCH[2]} >= 1 && 10#${BASH_REMATCH[2]} <= 65535)); then
    DTC_ENDPOINT="http://127.0.0.1:$((10#${BASH_REMATCH[2]}))/mcp"
  else
    daintree_call_fail 4 "DAINTREE_MCP_URL must be Daintree's local endpoint, like http://127.0.0.1:45454/mcp"
  fi
  command -v curl > /dev/null 2>&1 || daintree_call_fail 3 "curl is required"

  DTC_TOKEN=$token
  DTC_TMP=""
  DTC_SESSION=""
  DTC_VERSION=""
  DTC_STATUS=""
  DTC_CLOSE=0
  DTC_PINNED=$pinned
  trap daintree_call_cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  umask 077
  DTC_TMP=$(mktemp -d "${TMPDIR:-/tmp}/daintree-call.XXXXXX") || daintree_call_fail 3 "could not create a private temporary directory"
}

# Opens a session: initialize, then notifications/initialized. Whatever opens
# is closed again on exit unless it is handed over.
daintree_call_open() {
  local version rc=0
  DTC_CLOSE=1
  printf '%s' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"daintree-cli","version":"1.0.0"}}}' > "$DTC_TMP/initialize" ||
    daintree_call_fail 3 "could not write the request"

  daintree_call_request "$DTC_TMP/initialize" 10 "$DTC_TMP/init-headers" || rc=$?
  # Before anything can fail: a session opened with a body that never arrived
  # still has to be closed.
  daintree_call_adopt_session
  daintree_call_refused
  if [[ $rc -ne 0 ]]; then
    daintree_call_fail 3 "could not reach Daintree at $DTC_ENDPOINT: $(daintree_call_curl_error)"
  fi
  if [[ $DTC_STATUS != 200 ]]; then
    # A refused handshake says why in a JSON-RPC error; nothing ran.
    if awk -v mode=refusal "$DTC_AWK" < "$DTC_TMP/reply" > /dev/null 2> "$DTC_TMP/refusal"; then :; elif [[ $? -eq 11 ]]; then
      daintree_call_fail 1 "Daintree refused the session: $(head -c 300 "$DTC_TMP/refusal" 2> /dev/null || true)"
    fi
    daintree_call_fail 3 "Daintree refused the session (HTTP ${DTC_STATUS:-none}): $(daintree_call_reply_excerpt)"
  fi
  rc=0
  version=$(awk -v mode=init -v want=1 "$DTC_AWK" < "$DTC_TMP/reply" 2> "$DTC_TMP/init-error") || rc=$?
  if [[ $rc -eq 11 ]]; then
    daintree_call_fail 1 "Daintree refused the session: $(head -c 300 "$DTC_TMP/init-error" 2> /dev/null || true)"
  fi
  if [[ $rc -ne 0 || -z $version ]]; then
    daintree_call_fail 3 "Daintree's reply to initialize wasn't understood"
  fi
  [[ -n $DTC_SESSION ]] || daintree_call_fail 3 "Daintree opened no session"
  DTC_VERSION=$version

  printf '%s' '{"jsonrpc":"2.0","method":"notifications/initialized"}' > "$DTC_TMP/initialized" ||
    daintree_call_fail 3 "could not write the request"
  daintree_call_still_pinned "while the session was opening, so nothing more was sent to it; nothing ran"
  rc=0
  daintree_call_request "$DTC_TMP/initialized" 10 "$DTC_TMP/reply-headers" || rc=$?
  daintree_call_refused
  if [[ $rc -ne 0 ]]; then
    daintree_call_fail 3 "lost Daintree while opening the session: $(daintree_call_curl_error)"
  fi
  case "$DTC_STATUS" in
    200|202|204) ;;
    *) daintree_call_fail 3 "Daintree refused the session (HTTP ${DTC_STATUS:-none}): $(daintree_call_reply_excerpt)" ;;
  esac
}

daintree_call() {
  local tool="" args_json="" args_given=0 args_stdin=0 pairs="" keys=" " as_json=0 arg key value
  LC_ALL=C
  export LC_ALL
  DTC_COMMAND=call

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help)
        daintree_call_usage
        exit 0
        ;;
      --json) as_json=1 ;;
      --arg|--arg=*)
        if [[ $1 == --arg ]]; then
          [[ $# -ge 2 ]] || daintree_call_fail 2 "--arg needs key=value"
          shift
          arg=$1
        else
          arg=${1#--arg=}
        fi
        [[ $arg == *=* ]] || daintree_call_fail 2 "--arg needs key=value, got '$arg'"
        key=${arg%%=*}
        value=${arg#*=}
        [[ $key =~ ^[A-Za-z0-9_.-]+$ ]] || daintree_call_fail 2 "--arg key '$key' must be letters, digits, '_', '.' or '-' (use --args for anything else)"
        case "$keys" in
          *" $key "*) daintree_call_fail 2 "--arg $key is given twice" ;;
        esac
        keys="$keys$key "
        daintree_call_quote "$value"
        pairs="${pairs:+$pairs,}\"$key\":$DTC_QUOTED"
        ;;
      --args|--args=*)
        [[ $args_given -eq 0 ]] || daintree_call_fail 2 "--args is given twice"
        args_given=1
        if [[ $1 == --args ]]; then
          [[ $# -ge 2 ]] || daintree_call_fail 2 "--args needs a JSON object"
          shift
          args_json=$1
        else
          args_json=${1#--args=}
        fi
        [[ $args_json != - ]] || args_stdin=1
        [[ -n $args_json ]] || daintree_call_fail 2 "--args needs a JSON object"
        ;;
      -*) daintree_call_fail 2 "unknown option '$1' (see daintree call --help)" ;;
      *)
        [[ -z $tool ]] || daintree_call_fail 2 "expected one tool name, got '$tool' and '$1'"
        tool=$1
        ;;
    esac
    shift
  done

  [[ -n $tool ]] || daintree_call_fail 2 "missing the tool to call (see daintree call --help)"
  if [[ $args_given -eq 1 && -n $pairs ]]; then
    daintree_call_fail 2 "use --arg or --args, not both"
  fi
  if [[ $args_stdin -eq 1 ]]; then
    # Bash drops NUL bytes silently; as \001 the validator refuses them.
    args_json=$(tr '\000' '\001') || daintree_call_fail 2 "--args - couldn't read stdin"
    [[ -n $args_json ]] || daintree_call_fail 2 "--args - read no JSON object from stdin"
  fi

  local arguments="{$pairs}"
  [[ $args_given -eq 0 ]] || arguments=$args_json
  daintree_call_load_awk
  daintree_call_send "$tool" "$as_json" "$args_given" "$arguments"
}

# The reply parser, into DTC_AWK, read in once.
daintree_call_load_awk() {
  [[ -z ${DTC_AWK:-} ]] || return 0
  IFS= read -r -d '' DTC_AWK <<'AWK' || true
# Reads one reply body, plain JSON or an SSE stream, and finds the JSON-RPC
# response whose id is `want`. Mode `object` instead checks that the input is
# exactly one JSON object. Exits 0, 10 when the tool reported an error, 11 for a
# JSON-RPC error, 12 when no well-formed response with that id was found.
function fail(msg) { if (perr == "") perr = msg; return 0 }
function ws() { while (p <= n && (C[p] == " " || C[p] == "\t" || C[p] == "\n" || C[p] == "\r")) p++ }
function str(   c) {
  p++; sb = p
  while (p <= n) {
    c = C[p]
    if (c == "\"") { se = p - 1; p++; return 1 }
    if (c == "\\") {
      c = (p < n) ? C[p + 1] : ""
      if (c == "u") {
        if ((C[p + 2] C[p + 3] C[p + 4] C[p + 5]) !~ /^[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]$/) return fail("bad \\u escape")
        p += 6; continue
      }
      if (c == "" || index("\"\\/bfnrt", c) == 0) return fail("bad escape")
      p += 2; continue
    }
    if (c < " ") return fail("control character in a string")
    p++
  }
  return fail("unterminated string")
}
function val(path, depth,   c, k, i, start, lit) {
  if (depth > 200) return fail("nested too deep")
  ws()
  if (p > n) return fail("unexpected end of input")
  c = C[p]; start = p
  if (c == "{") {
    T[path] = "object"; S[path] = p; p++; ws()
    if (p <= n && C[p] == "}") { p++; E[path] = p - 1; return 1 }
    for (;;) {
      ws()
      if (p > n || C[p] != "\"") return fail("expected a key")
      if (!str()) return 0
      k = substr(s, sb, se - sb + 1)
      # A key escaping a control character stays raw: decoded, it could
      # collide with a plain key or with SUBSEP.
      if (index(k, "\\") > 0 && k !~ /\\u00[01]/) k = unesc(k)
      ws()
      if (p > n || C[p] != ":") return fail("expected a colon")
      p++
      if (!val(path SUBSEP k, depth + 1)) return 0
      ws()
      if (p <= n && C[p] == ",") { p++; continue }
      if (p <= n && C[p] == "}") { p++; E[path] = p - 1; return 1 }
      return fail("expected a comma or a closing brace")
    }
  }
  if (c == "[") {
    T[path] = "array"; S[path] = p; p++; ws(); i = 0
    if (p <= n && C[p] == "]") { p++; E[path] = p - 1; N[path] = 0; return 1 }
    for (;;) {
      if (!val(path SUBSEP i, depth + 1)) return 0
      i++; ws()
      if (p <= n && C[p] == ",") { p++; continue }
      if (p <= n && C[p] == "]") { p++; E[path] = p - 1; N[path] = i; return 1 }
      return fail("expected a comma or a closing bracket")
    }
  }
  if (c == "\"") {
    if (!str()) return 0
    T[path] = "string"; S[path] = sb; E[path] = se
    return 1
  }
  while (p <= n && index(" \t\r\n,]}:", C[p]) == 0) p++
  lit = substr(s, start, p - start)
  if (lit == "true" || lit == "false" || lit == "null") T[path] = lit
  else if (lit ~ /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/) T[path] = "number"
  else return fail("unexpected " substr(lit, 1, 20))
  S[path] = start; E[path] = p - 1
  return 1
}
function parse(text) {
  split("", T); split("", S); split("", E); split("", N); split("", C)
  s = text; n = split(s, C, ""); p = 1; perr = ""
  if (!val("$", 0)) return 0
  ws()
  if (p <= n) return fail("unexpected data after the value")
  return 1
}
function raw(path) { return substr(s, S[path], E[path] - S[path] + 1) }
function put(x) { if (toerr) printf "%s", x > "/dev/stderr"; else printf "%s", x }
function hexval(h,   i, v, d) {
  v = 0
  for (i = 1; i <= 4; i++) {
    d = index("0123456789abcdef", tolower(substr(h, i, 1)))
    if (d == 0) return -1
    v = v * 16 + d - 1
  }
  return v
}
# A code point as UTF-8. NUL is dropped: awk can't carry it portably.
function cpstr(cp) {
  if (cp == 0) return ""
  if (cp < 128 || wide) return sprintf("%c", cp)
  if (cp < 2048) return sprintf("%c%c", 192 + int(cp / 64), 128 + cp % 64)
  if (cp < 65536) return sprintf("%c%c%c", 224 + int(cp / 4096), 128 + int(cp / 64) % 64, 128 + cp % 64)
  return sprintf("%c%c%c%c", 240 + int(cp / 262144), 128 + int(cp / 4096) % 64, 128 + int(cp / 64) % 64, 128 + cp % 64)
}
# Decodes a raw string body, writing it out piece by piece or, with `keep`,
# returning it. Split on the backslash it stays linear: an empty part is an
# escaped backslash, and the part after one is literal.
function decode(r, keep,   parts, m, i, part, c, cp, lo, out, piece) {
  m = split(r, parts, "\\")
  out = ""
  if (keep) out = parts[1]; else put(parts[1])
  for (i = 2; i <= m; i++) {
    part = parts[i]
    if (part == "" && i < m) { piece = "\\" parts[i + 1]; i++ }
    else {
      c = substr(part, 1, 1)
      if (c == "u") {
        cp = hexval(substr(part, 2, 4))
        part = substr(part, 6)
        if (cp >= 55296 && cp < 56320 && part == "" && i < m && substr(parts[i + 1], 1, 1) == "u") {
          lo = hexval(substr(parts[i + 1], 2, 4))
          if (lo >= 56320 && lo < 57344) {
            cp = 65536 + (cp - 55296) * 1024 + (lo - 56320)
            i++; part = substr(parts[i], 6)
          }
        }
        if (cp >= 55296 && cp < 57344) cp = 65533
        piece = cpstr(cp) part
      } else {
        if (c == "n") c = "\n"
        else if (c == "t") c = "\t"
        else if (c == "r") c = "\r"
        else if (c == "b") c = "\b"
        else if (c == "f") c = "\f"
        piece = c substr(part, 2)
      }
    }
    if (keep) out = out piece; else put(piece)
  }
  return out
}
function unesc(r) { return decode(r, 1) }
function emitstr(path) { decode(raw(path), 0) }
function sval(path,   r) {
  if (T[path] != "string") return ""
  r = raw(path)
  return index(r, "\\") > 0 ? unesc(r) : r
}
function event(data,   id) {
  if (found || data == "") return
  if (!parse(data)) return
  if (T["$"] != "object" || sval("$" SUBSEP "jsonrpc") != "2.0") return
  id = "$" SUBSEP "id"
  if (T[id] != "number" || raw(id) + 0 != want + 0) return
  if ((T["$" SUBSEP "result"] == "object") == (T["$" SUBSEP "error"] == "object")) return
  found = 1
}
# Every text block of the result, in order; the count written.
function texts(   ct, i, item, shown) {
  ct = rs SUBSEP "content"
  shown = 0
  if (T[ct] != "array") return 0
  for (i = 0; i < N[ct]; i++) {
    item = ct SUBSEP i
    if (sval(item SUBSEP "type") == "text" && T[item SUBSEP "text"] == "string") {
      emitstr(item SUBSEP "text")
      put("\n")
      shown++
    } else if (!toerr && T[item SUBSEP "type"] == "string") {
      printf "daintree call: %s content not shown; use --json to see it\n", sval(item SUBSEP "type") > "/dev/stderr"
    }
  }
  return shown
}
function rpcerror(   er) {
  er = "$" SUBSEP "error"
  toerr = 1
  if (T[er SUBSEP "message"] == "string") emitstr(er SUBSEP "message"); else put("JSON-RPC error")
  if (T[er SUBSEP "code"] == "number") put(" (code " raw(er SUBSEP "code") ")")
  put("\n")
}
BEGIN { wide = (sprintf("%c", 233) == "\303\251") }
{ sub(/\r$/, ""); lines[++nl] = $0 }
END {
  if (mode == "object") {
    body = ""
    for (i = 1; i <= nl; i++) body = body (i > 1 ? "\n" : "") lines[i]
    if (!parse(body)) { print perr > "/dev/stderr"; exit 1 }
    if (T["$"] != "object") { print "not a JSON object" > "/dev/stderr"; exit 1 }
    exit 0
  }
  # A refused handshake: one JSON body carrying an error, whatever its id.
  if (mode == "refusal") {
    body = ""
    for (i = 1; i <= nl; i++) body = body (i > 1 ? "\n" : "") lines[i]
    if (!parse(body) || T["$"] != "object" || sval("$" SUBSEP "jsonrpc") != "2.0") exit 12
    if (T["$" SUBSEP "error"] != "object" || T["$" SUBSEP "error" SUBSEP "message"] != "string") exit 12
    rpcerror()
    exit 11
  }
  # The runtime file Daintree publishes while its MCP server serves: its pid,
  # port and start stamp on one line, or exit 1 for anything malformed.
  if (mode == "runtime") {
    body = ""
    for (i = 1; i <= nl; i++) body = body (i > 1 ? "\n" : "") lines[i]
    if (!parse(body) || T["$"] != "object") exit 1
    pid = "$" SUBSEP "pid"; port = "$" SUBSEP "port"; st = "$" SUBSEP "startedAt"
    if (T[pid] != "number" || raw(pid) !~ /^[1-9][0-9]*$/ || length(raw(pid)) > 10) exit 1
    if (T[port] != "number" || raw(port) !~ /^[1-9][0-9]*$/ || raw(port) + 0 > 65535) exit 1
    if (T[st] != "string" || raw(st) !~ /^[0-9A-Za-z :@.-]+$/ || length(raw(st)) > 80) exit 1
    print raw(pid) " " raw(port) " " raw(st)
    exit 0
  }
  # The saved MCP server setting in Daintree's config.json: true or false, or
  # exit 1 when it can't be read. Silent either way: the file holds the API key.
  if (mode == "enabled") {
    body = ""
    for (i = 1; i <= nl; i++) body = body (i > 1 ? "\n" : "") lines[i]
    if (!parse(body)) exit 1
    v = T["$" SUBSEP "mcpServer" SUBSEP "enabled"]
    if (T["$" SUBSEP "mcpServer"] != "object" || (v != "true" && v != "false")) exit 1
    print v
    exit 0
  }
  sse = 0
  for (i = 1; i <= nl; i++) if (lines[i] ~ /^(data|event|id|retry):/) { sse = 1; break }
  if (!sse) {
    body = ""
    for (i = 1; i <= nl; i++) body = body (i > 1 ? "\n" : "") lines[i]
    event(body)
  } else {
    data = ""; has = 0
    for (i = 1; i <= nl && !found; i++) {
      line = lines[i]
      if (line == "") { if (has) event(data); data = ""; has = 0; continue }
      if (line ~ /^data:/) {
        sub(/^data: ?/, "", line)
        data = has ? data "\n" line : line; has = 1
      }
    }
    if (!found && has) event(data)
  }
  if (!found) exit 12
  if (T["$" SUBSEP "error"] == "object") { rpcerror(); exit 11 }
  rs = "$" SUBSEP "result"
  failed = T[rs SUBSEP "isError"] == "true"
  if (mode == "init") {
    version = T[rs SUBSEP "protocolVersion"] == "string" ? raw(rs SUBSEP "protocolVersion") : ""
    if (version !~ /^[0-9A-Za-z.-]+$/) exit 12
    print version
    exit 0
  }
  if (mode == "json") {
    print raw(rs)
    if (failed) { toerr = 1; texts() }
    exit failed ? 10 : 0
  }
  toerr = failed
  if (texts() == 0) put(raw(rs) "\n")
  exit failed ? 10 : 0
}
AWK
}

daintree_call_send() {
  local tool=$1 as_json=$2 args_given=$3 arguments=$4 handle=${DAINTREE_MCP_SESSION:-} id=2 err rc=0
  if [[ $args_given -eq 1 ]]; then
    err=$(printf '%s' "$arguments" | awk -v mode=object "$DTC_AWK" 2>&1 > /dev/null) || rc=$?
    if [[ $rc -ne 0 ]]; then
      daintree_call_fail 2 "--args must be one JSON object: $(printf '%s' "$err" | head -c 200)"
    fi
  fi
  [[ -z $handle ]] || daintree_call_parse_handle "$handle"

  daintree_call_setup
  if [[ -z $handle ]]; then
    daintree_call_open
  else
    DTC_SESSION=$DTC_HELD_SESSION
    DTC_VERSION=$DTC_HELD_VERSION
    daintree_call_fresh_id
    id=$DTC_ID
  fi

  daintree_call_quote "$tool"
  printf '{"jsonrpc":"2.0","id":%s,"method":"tools/call","params":{"name":%s,"arguments":%s}}' "$id" "$DTC_QUOTED" "$arguments" > "$DTC_TMP/call" ||
    daintree_call_fail 3 "could not write the request"
  daintree_call_still_pinned "before the call to $tool was sent, so it didn't run"
  # No time limit: a call can wait on an approval dialog or on an agent.
  rc=0
  daintree_call_request "$DTC_TMP/call" "" "$DTC_TMP/reply-headers" || rc=$?
  daintree_call_refused
  [[ -z $handle ]] || daintree_call_gone
  if [[ $rc -ne 0 ]]; then
    daintree_call_fail 3 "the call to $tool was sent, but its answer was lost ($(daintree_call_curl_error)); it may have run"
  fi
  if [[ $DTC_STATUS != 200 ]]; then
    # Refused before it ran (a body over the size limit): a JSON-RPC error says why.
    if awk -v mode=refusal "$DTC_AWK" < "$DTC_TMP/reply" > /dev/null 2> "$DTC_TMP/refusal"; then :; elif [[ $? -eq 11 ]]; then
      daintree_call_fail 1 "Daintree refused the call to $tool: $(head -c 300 "$DTC_TMP/refusal" 2> /dev/null || true)"
    fi
    daintree_call_fail 3 "Daintree didn't answer the call to $tool (HTTP ${DTC_STATUS:-none}): $(daintree_call_reply_excerpt)"
  fi
  rc=0
  # awk's diagnostics go through a file: an unwritable stderr would make awk
  # fail, and its status is the tool's.
  if [[ $as_json -eq 1 ]]; then
    awk -v mode=json -v want="$id" "$DTC_AWK" < "$DTC_TMP/reply" 2> "$DTC_TMP/tool-error" || rc=$?
  else
    awk -v mode=text -v want="$id" "$DTC_AWK" < "$DTC_TMP/reply" 2> "$DTC_TMP/tool-error" || rc=$?
  fi
  (cat "$DTC_TMP/tool-error" >&2) || true
  case "$rc" in
    0) exit 0 ;;
    10|11) exit 1 ;;
    12) daintree_call_fail 3 "the call to $tool was sent, but no answer to it was found in Daintree's reply; it may have run" ;;
    *) daintree_call_fail 3 "the reply to $tool couldn't be read (awk exited $rc); it may have run" ;;
  esac
}

daintree_session() {
  LC_ALL=C
  export LC_ALL
  DTC_COMMAND=session
  case "${1:-}" in
    -h|--help)
      daintree_session_usage
      exit 0
      ;;
    start|end)
      [[ $# -eq 1 ]] || daintree_call_fail 2 "expected start or end alone, got '$*'"
      ;;
    *) daintree_call_fail 2 "expected start or end (see daintree session --help)" ;;
  esac
  if [[ $1 == start ]]; then
    daintree_session_start
  else
    daintree_session_end
  fi
}

daintree_session_start() {
  if [[ -n ${DAINTREE_MCP_SESSION:-} ]]; then
    daintree_call_fail 2 "DAINTREE_MCP_SESSION already names a session: end it first, or clear it for a second one (DAINTREE_MCP_SESSION= daintree session start)"
  fi
  daintree_call_load_awk
  daintree_call_setup
  daintree_call_open
  # The handoff runs to the end: a signal once the handle is out would close a
  # session the script already holds. Printed from a subshell, so a closed
  # stdout fails the print instead of killing this shell before it closes the
  # session no one was told about.
  trap '' INT TERM HUP PIPE
  if (printf '%s:%s\n' "$DTC_VERSION" "$DTC_SESSION") 2> /dev/null; then
    DTC_CLOSE=0
    exit 0
  fi
  daintree_call_fail 3 "could not print the session's handle; closing the session again"
}

daintree_session_end() {
  local handle=${DAINTREE_MCP_SESSION:-} rc=0
  [[ -n $handle ]] || daintree_call_fail 2 "DAINTREE_MCP_SESSION is not set, so there is no session to end"
  daintree_call_parse_handle "$handle"
  daintree_call_setup
  DTC_SESSION=$DTC_HELD_SESSION
  DTC_VERSION=$DTC_HELD_VERSION
  daintree_call_request "" 10 "$DTC_TMP/reply-headers" || rc=$?
  daintree_call_refused
  daintree_call_gone
  # The status alone settles it: the server closes the session before it
  # answers, so a reply cut short after a 2xx still ended it.
  case "$DTC_STATUS" in
    200|202|204) exit 0 ;;
  esac
  if [[ $rc -ne 0 ]]; then
    daintree_call_fail 3 "could not reach Daintree at $DTC_ENDPOINT to end the session: $(daintree_call_curl_error)"
  fi
  daintree_call_fail 3 "Daintree didn't end the session (HTTP ${DTC_STATUS:-none}): $(daintree_call_reply_excerpt)"
}
# <<< daintree call <<<

# --- Handle flags before directory resolution ---
# `--json --status` asks the same as `--status --json`.
if [[ ${1:-} == --json && ( ${2:-} == --status || ${2:-} == -s ) ]]; then
  set -- "$2" "$1" "${@:3}"
fi
case "${1:-}" in
  --help|-h)
    cat <<'USAGE'
Usage: daintree [directory]
       daintree call <tool> [options]
       daintree session start|end

Open a directory as a project in Daintree, or call one of its tools from a
script.

Arguments:
  directory    Path to open (defaults to current directory). To open a
               folder named "call" or "session", write it as ./call or
               ./session

Commands:
  call <tool>        Call a Daintree MCP tool (see daintree call --help)
  session start|end  Hold one session across calls (see daintree session --help)

Options:
  -h, --help       Show this help message
  -v, --version    Show the Daintree CLI version
  -s, --status     Check if Daintree is running (exit 0 if it is, 1 if not)
  --status --json  The same, as one JSON object: version, running, mcpEnabled
                   (null when it can't be told) and mcpPort (null when the MCP
                   server isn't serving)

Examples:
  daintree .             Open the current directory
  daintree ~/projects/my-app   Open a specific project
  daintree call terminal.list  List terminals, from an agent pane
USAGE
    exit 0
    ;;
  call)
    shift
    daintree_call "$@"
    ;;
  session)
    shift
    daintree_session "$@"
    ;;
  --version|-v)
    echo "daintree $(get_version)"
    exit 0
    ;;
  --status|-s)
    shift
    version=""
    [[ ${1:-} != --json ]] || version=$(get_version)
    daintree_status "$version" "$@"
    ;;
esac

# --- Resolve target directory ---
# One folder only: `daintree my project` would otherwise open "my" and drop the rest.
if [[ $# -gt 1 ]]; then
  echo "daintree: expected one directory, got $# arguments (quote a path that contains spaces)" >&2
  echo "Usage: daintree [directory]" >&2
  exit 2
fi

TARGET="${1:-.}"
ABSOLUTE_PATH="$(CDPATH= cd -- "$TARGET" 2>/dev/null && pwd -P)" || ABSOLUTE_PATH=""

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
# `-ef` follows symlinks and compares device and inode, so the installed name (a
# symlink to this script, or a copy of it) is never taken for the app: launching
# it would re-run this script with `--cli-path=…` as its directory argument,
# fail there, and still leave this process exiting 0.
is_app_binary() {
  [[ -n "$1" && -x "$1" ]] && ! [[ "$1" -ef "$SCRIPT_PATH" ]]
}

DAINTREE_BIN=""

for candidate in \
  "$(dirname "$(dirname "$SCRIPT_PATH")")/daintree" \
  "$(dirname "$(dirname "$SCRIPT_PATH")")/daintree-app" \
  "${APPDIR:-}/daintree" \
  "${APPDIR:-}/daintree-app" \
  "/opt/Daintree/daintree" \
  "/opt/Daintree/daintree-app"; do
  if is_app_binary "$candidate"; then
    DAINTREE_BIN="$candidate"
    break
  fi
done

# PATH lookup (last resort). Every match is checked, not just the first one
# `command -v` returns, so a wrapper earlier on PATH doesn't shadow the app.
WRAPPER_ON_PATH=""
if [[ -z "$DAINTREE_BIN" ]]; then
  for command_name in daintree daintree-app; do
    while IFS= read -r candidate; do
      if is_app_binary "$candidate"; then
        DAINTREE_BIN="$candidate"
        break 2
      fi
      if [[ "$candidate" -ef "$SCRIPT_PATH" ]]; then
        WRAPPER_ON_PATH="$candidate"
      fi
    done < <(type -aP "$command_name" 2>/dev/null || true)
  done
fi

if [[ -z "$DAINTREE_BIN" ]]; then
  if [[ -n "$WRAPPER_ON_PATH" ]]; then
    echo "daintree: the only match on PATH is this CLI wrapper ($WRAPPER_ON_PATH), not the Daintree app." >&2
    echo "daintree: Install Daintree under /opt/Daintree, or put its daintree or daintree-app executable on PATH." >&2
  else
    echo "daintree: Daintree executable not found." >&2
  fi
  exit 1
fi

# Single-token `=` form — a warm launch here spawns a real second process, whose
# command line Chromium reconstructs and can inject switches into (#11410).
"$DAINTREE_BIN" --cli-path="$ABSOLUTE_PATH" &
exit 0
