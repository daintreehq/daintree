#!/bin/bash
set -e

# Install AppArmor profile to allow unprivileged user namespaces (Ubuntu 24.04+)
PROFILE_SRC="/opt/Daintree/resources/daintree.apparmor"
PROFILE_DST="/etc/apparmor.d/daintree"

if [ -f "$PROFILE_SRC" ] && command -v apparmor_parser > /dev/null 2>&1; then
  cp "$PROFILE_SRC" "$PROFILE_DST" || true
  apparmor_parser -r -T -W "$PROFILE_DST" || true
fi

# Fix chrome-sandbox SUID permissions (fallback if AppArmor profile isn't loaded)
SANDBOX="/opt/Daintree/chrome-sandbox"
if [ -f "$SANDBOX" ]; then
  chown root:root "$SANDBOX"
  chmod 4755 "$SANDBOX"
fi

# Symlink daintree-app binary into PATH for CLI discovery
ln -sf /opt/Daintree/daintree-app /usr/bin/daintree-app
