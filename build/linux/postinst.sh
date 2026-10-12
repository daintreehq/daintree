#!/bin/bash
set -e

# Install AppArmor profile to allow unprivileged user namespaces (Ubuntu 24.04+).
# AppArmor 3 (Ubuntu 22.04) can't parse the profile's abi/4.0 and doesn't need it,
# so dry-run it first: a copy that fails to parse errors on every profile load.
PROFILE_SRC="/opt/Daintree/resources/daintree.apparmor"
PROFILE_DST="/etc/apparmor.d/daintree"

if [ -f "$PROFILE_SRC" ] && command -v apparmor_parser > /dev/null 2>&1; then
  if apparmor_parser --skip-kernel-load --debug "$PROFILE_SRC" > /dev/null 2>&1; then
    cp -f "$PROFILE_SRC" "$PROFILE_DST" || true
    if ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; }; then
      apparmor_parser -r -T -W "$PROFILE_DST" || true
    fi
  else
    # An earlier install may have left an unparseable copy behind
    rm -f "$PROFILE_DST"
  fi
fi

# `daintree [dir]` on PATH is the CLI script, not the binary: the binary ignores a
# bare folder argument, while the script resolves it and passes --cli-path.
ln -sf /opt/Daintree/resources/daintree-cli.sh /usr/bin/daintree
