#!/bin/bash
set -e

# Remove daintree-app symlink — only on remove or purge, not on upgrade
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
  rm -f /usr/bin/daintree-app
fi
