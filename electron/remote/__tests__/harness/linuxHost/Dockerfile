# The machine a fresh Host install lands on: sshd and an unprivileged user, git
# for its projects, the libraries Daintree's deb declares
# (electron-builder.config.cjs, deb.depends), and no Daintree. No systemd either: `standins/` answers for it (see systemctl).
FROM ubuntu:24.04 AS host
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    openssh-server ca-certificates curl git procps \
    libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libxkbcommon0 libxrandr2 libxshmfence1 \
    libxss1 libxtst6 libx11-6 libx11-xcb1 libxcb1 libxdamage1 libxfixes3 libatk1.0-0t64 \
    libatk-bridge2.0-0t64 libcups2t64 libdbus-1-3 libdrm2 libexpat1 libnotify4 libnspr4 \
    libsecret-1-0 xdg-utils \
  && rm -rf /var/lib/apt/lists/*
# A password that can't be typed, not a locked account: without PAM, sshd turns locked accounts away.
RUN useradd --create-home --uid 1500 --shell /bin/bash --password '*' daintree-e2e \
  && mkdir -p /run/sshd
COPY standins/systemctl standins/loginctl standins/journalctl /usr/local/bin/
COPY sshd_config /etc/ssh/sshd_config.d/10-e2e.conf
COPY entrypoint.sh /usr/local/sbin/e2e-entrypoint
ENTRYPOINT ["/usr/local/sbin/e2e-entrypoint"]

# The release feed beside it, and the tools that repack a build into a second one.
FROM node:22-slim AS feed
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends squashfs-tools \
  && rm -rf /var/lib/apt/lists/*
COPY feedServer.mjs repackAppImage.mjs /opt/e2e/
ENTRYPOINT ["timeout", "--signal=KILL", "3600", "node", "/opt/e2e/feedServer.mjs"]
