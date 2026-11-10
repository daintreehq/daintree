#!/bin/sh
# Seeded through `docker cp` once running, so nothing depends on which host
# folders a Docker Desktop or Colima VM can bind mount. A seed that never comes
# ends the container, so a run that died this early leaves nothing behind.
set -eu
i=0
until [ -f /e2e-seed/ready ]; do
  i=$((i + 1))
  [ "$i" -le 3000 ] || exit 1
  sleep 0.1
done
install -m 644 -o root -g root /e2e-seed/authorized_keys /etc/ssh/e2e_authorized_keys
install -m 644 -o root -g root /e2e-seed/ca.crt /usr/local/share/ca-certificates/daintree-e2e.crt
update-ca-certificates >/dev/null
ssh-keygen -A >/dev/null
# What a login session's PAM stack makes on a real machine.
install -d -m 700 -o daintree-e2e -g daintree-e2e /run/user/1500
# A run that crashed before its teardown still goes away.
exec timeout --signal=KILL 3600 /usr/sbin/sshd -D -e
