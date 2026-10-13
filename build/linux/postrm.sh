#!/bin/bash
set -e

# Remove Daintree symlink and AppArmor profile — only on remove or purge, not on upgrade
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
  rm -f /usr/bin/daintree

  PROFILE_DST="/etc/apparmor.d/daintree"
  if [ -f "$PROFILE_DST" ]; then
    if command -v apparmor_parser > /dev/null 2>&1 && ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; }; then
      apparmor_parser -R "$PROFILE_DST" > /dev/null 2>&1 || true
    fi
    rm -f "$PROFILE_DST"
  fi
fi
