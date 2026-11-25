#!/bin/sh
# Installs the login's authorized keys and the SSH host key this container was
# given, then hands PID 1 to tini with sshd in the foreground beneath it.
# docs/distribution/host-image.md documents the inputs.
set -eu

dir=/etc/ssh/daintree
host_key="$dir/ssh_host_key"
authorized_keys="$dir/authorized_keys"
secrets=/run/secrets

fail() {
  echo "daintree-host: $*" >&2
  exit 1
}

# Writes input NAME to stdout: from $NAME, else the file $NAME_FILE names, else
# the secret file `default` when there is one; nothing when there's none of them.
read_input() {
  name=$1
  default=$2
  eval "given=\${$name+set} value=\${$name:-} file_given=\${${name}_FILE+set} file=\${${name}_FILE:-}"
  if [ -n "$given" ] && [ -n "$file_given" ]; then
    fail "set $name or ${name}_FILE, not both"
  fi
  if [ -n "$given" ]; then
    [ -n "$value" ] || fail "$name is set but empty"
  else
    if [ -n "$file_given" ]; then
      [ -f "$file" ] && [ -r "$file" ] || fail "${name}_FILE names ${file:-nothing}, which isn't a file it can read"
    elif [ -e "$default" ] || [ -L "$default" ]; then
      # A secret mounted wrong stops the start rather than reading as no secret.
      [ -f "$default" ] && [ -r "$default" ] || fail "$default isn't a file it can read"
      file=$default
    else
      return 0
    fi
    value=$(cat "$file")
    [ -n "$value" ] || fail "$file is empty"
  fi
  printf '%s\n' "$value"
}

# Writes `value` to `out` as given when `check` accepts that, else base64-decoded
# when `check` accepts that, for environments that can't carry the lines a key
# spans. Fails when it's neither. Called where `set -e` doesn't hold, so every
# step says how it went.
write_checked() {
  value=$1
  out=$2
  shift 2
  printf '%s\n' "$value" > "$out" || return 1
  "$@" "$out" > /dev/null 2>&1 && return 0
  decoded=$(printf '%s' "$value" | base64 -d 2>/dev/null) || return 1
  printf '%s\n' "$decoded" > "$out" || return 1
  "$@" "$out" > /dev/null 2>&1
}

# Public keys only, each line one on its own: ssh-keygen -l reads a private key
# too, and passes a file when any one line is a key, and the login can read this
# file. Blank lines and comments are allowed; at least one key is required.
public_keys() {
  found=""
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      "" | "#"*) continue ;;
      *"PRIVATE KEY"*) return 1 ;;
    esac
    printf '%s\n' "$line" > "$1.line" || return 1
    if ! ssh-keygen -l -f "$1.line" > /dev/null 2>&1; then
      rm -f "$1.line"
      return 1
    fi
    found=yes
  done < "$1"
  rm -f "$1.line"
  [ -n "$found" ]
}

umask 077
mkdir -p "$dir" /run/sshd
# sshd reads authorized keys as the user logging in.
chmod 755 "$dir"

keys=$(read_input DAINTREE_AUTHORIZED_KEYS "$secrets/daintree_authorized_keys")
[ -n "$keys" ] || fail "no authorized key: set DAINTREE_AUTHORIZED_KEYS or mount $secrets/daintree_authorized_keys"
if ! write_checked "$keys" "$authorized_keys.new" public_keys; then
  rm -f "$authorized_keys.new"
  fail "DAINTREE_AUTHORIZED_KEYS isn't public keys sshd can read, one per line, as given or base64-decoded"
fi
chmod 644 "$authorized_keys.new"
mv -f "$authorized_keys.new" "$authorized_keys"

provided=$(read_input DAINTREE_SSH_HOST_KEY "$secrets/daintree_ssh_host_key")
if [ -n "$provided" ]; then
  # A bad key stops the start even with a good one from an earlier start on disk:
  # a client pinning the key it gave would only be turned away later.
  if ! write_checked "$provided" "$host_key.new" ssh-keygen -y -P "" -f; then
    rm -f "$host_key.new"
    fail "DAINTREE_SSH_HOST_KEY isn't an unencrypted private key sshd can read, as given or base64-decoded"
  fi
  ssh-keygen -y -P "" -f "$host_key.new" > "$host_key.pub.new"
  mv -f "$host_key.new" "$host_key"
  mv -f "$host_key.pub.new" "$host_key.pub"
elif [ -e "$host_key" ]; then
  # Kept across a restart that keeps the filesystem, so a client that already trusts it still does.
  ssh-keygen -y -P "" -f "$host_key" > "$host_key.pub" 2>/dev/null \
    || fail "the host key from an earlier start, $host_key, can't be read"
else
  ssh-keygen -q -t ed25519 -N "" -C "" -f "$host_key"
fi
chmod 644 "$host_key.pub"
echo "daintree-host: host key $(ssh-keygen -l -f "$host_key.pub")"

unset DAINTREE_AUTHORIZED_KEYS DAINTREE_AUTHORIZED_KEYS_FILE DAINTREE_SSH_HOST_KEY DAINTREE_SSH_HOST_KEY_FILE
/usr/sbin/sshd -t || fail "sshd refused its configuration"
# tini reaps the Host's processes, which the SSH login that started them leaves behind;
# -s keeps that working under a runtime that puts an init of its own at PID 1.
exec /usr/bin/tini -s -- /usr/sbin/sshd -D -e
