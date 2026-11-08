#!/bin/sh
# Seeded through `docker cp` before the start, so nothing depends on which host
# folders a Docker Desktop or Colima VM can bind mount.
set -eu
install -m 644 -o root -g root /e2e-seed/authorized_keys /etc/ssh/e2e_authorized_keys
install -m 644 -o root -g root /e2e-seed/ca.crt /usr/local/share/ca-certificates/daintree-e2e.crt
update-ca-certificates >/dev/null
ssh-keygen -A >/dev/null
# What a login session's PAM stack makes on a real machine.
install -d -m 700 -o daintree-e2e -g daintree-e2e /run/user/1500
# A run that crashed before its teardown still goes away.
exec timeout --signal=KILL 3600 /usr/sbin/sshd -D -e
