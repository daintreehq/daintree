#!/bin/bash
set -e

# Remove Daintree symlink — only on remove or purge, not on upgrade
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
  rm -f /usr/bin/daintree
fi
