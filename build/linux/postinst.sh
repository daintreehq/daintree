#!/bin/bash
set -e

# Install AppArmor profile to allow unprivileged user namespaces (Ubuntu 24.04+)
PROFILE_SRC="/opt/Canopy/resources/canopy.apparmor"
PROFILE_DST="/etc/apparmor.d/canopy"

if [ -f "$PROFILE_SRC" ] && command -v apparmor_parser > /dev/null 2>&1; then
  cp "$PROFILE_SRC" "$PROFILE_DST" || true
  apparmor_parser -r -T -W "$PROFILE_DST" || true
fi

# Fix chrome-sandbox SUID permissions (fallback if AppArmor profile isn't loaded)
SANDBOX="/opt/Canopy/chrome-sandbox"
if [ -f "$SANDBOX" ]; then
  chown root:root "$SANDBOX"
  chmod 4755 "$SANDBOX"
fi
