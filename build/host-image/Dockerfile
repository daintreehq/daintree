# The machine a container cloud runs as a Daintree Remote Host: sshd on port
# 22, one unprivileged login, and every package a Linux Host needs, with tini
# rather than systemd as PID 1 and no Daintree. Host setup installs Daintree
# over SSH and starts it without systemd or FUSE.
# docs/distribution/host-image.md documents the inputs and how a version is
# published.
#
# Ubuntu 24.04 as it was on 2026-10-25, moved on deliberately.
FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852

# shared/config/linuxHostPackages.ts (LINUX_HOST_PACKAGE_RELATIONS), which a
# test holds this to, plus sshd and an init that reaps the Host's orphans. The
# host keys the package makes go in the same layer: every container would share them.
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get satisfy -y --no-install-recommends \
    'libc6 (>= 2.34), libgtk-3-0, libnss3, libasound2t64 | libasound2, libgbm1, libxkbcommon0, libxrandr2, libxshmfence1, libxss1, libxtst6, libx11-6, libx11-xcb1, libxcb1, libxdamage1, libxfixes3, libatk1.0-0, libatk-bridge2.0-0, libcups2, libdbus-1-3, libdrm2, libexpat1, libnotify4, libnspr4, libsecret-1-0, xdg-utils, fuse3 | fuse, git, ca-certificates, curl, procps' \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server tini \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /etc/ssh/ssh_host_*

COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/sbin/daintree-host-entrypoint
# A password that can't be typed, not a locked account: without PAM, sshd
# turns locked accounts away. The base image's own `ubuntu` login goes.
RUN chmod 755 /usr/local/sbin/daintree-host-entrypoint \
  && (userdel --remove ubuntu 2>/dev/null || true) \
  && useradd --create-home --uid 1500 --user-group --shell /bin/bash --password '*' daintree

LABEL org.opencontainers.image.source="https://github.com/daintreehq/daintree" \
  org.opencontainers.image.title="Daintree Host" \
  org.opencontainers.image.licenses="Apache-2.0"
EXPOSE 22
ENTRYPOINT ["/usr/local/sbin/daintree-host-entrypoint"]
