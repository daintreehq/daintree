#!/bin/bash
set -e

# Install AppArmor profile to allow unprivileged user namespaces (Ubuntu 24.04+)
PROFILE_SRC="/opt/Daintree/resources/daintree.apparmor"
PROFILE_DST="/etc/apparmor.d/daintree"

if [ -f "$PROFILE_SRC" ] && command -v apparmor_parser > /dev/null 2>&1; then
  cp "$PROFILE_SRC" "$PROFILE_DST" || true
  apparmor_parser -r -T -W "$PROFILE_DST" || true
fi

# Symlink Daintree into PATH for CLI discovery
ln -sf /opt/Daintree/daintree /usr/bin/daintree
