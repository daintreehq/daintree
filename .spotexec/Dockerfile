# Project container for spotexec: every `sx` command, and the [deps] install,
# runs in this image on the runner. The worktree is mounted at run time and
# node_modules comes from the [deps] cache, so this holds tools only.
#
#   spotexec container build -r <runner>
#
# Commands run as the runner's non-root user with HOME=/home/spotexec mounted
# per slot: install system-wide, never under /root or /home/spotexec.

# .nvmrc pins the same version.
FROM node:22.23.2-bookworm

# The bookworm base already carries git, python3, make and g++ for the
# postinstall's node-gyp rebuilds. Electron's binary dynamically links GTK,
# NSS and friends even under ELECTRON_RUN_AS_NODE, which the unit suite uses.
# vitest.config.ts forces LC_ALL=en_US.UTF-8, so that locale must exist.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libgbm1 \
      libgtk-3-0 libnss3 libxcomposite1 libxdamage1 libxkbcommon0 libxrandr2 \
      libxshmfence1 libxss1 locales \
 && rm -rf /var/lib/apt/lists/* \
 && sed -i 's/^# *en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen \
 && locale-gen
