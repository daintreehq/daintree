# Project container for spotexec: every `sx` command, and the [deps] install,
# runs in this image on the runner. The worktree is mounted at run time and
# node_modules comes from the [deps] cache, so this holds tools only.
#
#   spotexec container build -r <runner>
#
# Commands run as the runner's non-root user with HOME=/home/spotexec mounted
# per slot: install system-wide, never under /root or /home/spotexec.

# scripts/ci/check-node-version-drift.mjs holds this to .nvmrc.
ARG NODE_IMAGE=node:22.23.2-bookworm

# Bookworm's git is 2.39, which skips the real-git watcher tests gated on 2.48;
# CI's ubuntu-latest runs a current git, so build the same here. Rust is still
# optional before git 3.0 and the base has no cargo. Symlinked builtins and a
# stripped binary keep the copied tree small (COPY flattens hardlinks).
FROM ${NODE_IMAGE} AS git
ARG GIT_VERSION=2.56.1
ARG GIT_SHA256=f0b0bf89264b9bd2e1c640363e7529643989da76281600473c50745cd34a607f
RUN curl -fsSL --retry 5 --retry-all-errors \
      "https://mirrors.edge.kernel.org/pub/software/scm/git/git-${GIT_VERSION}.tar.xz" -o /tmp/git.tar.xz \
 && echo "${GIT_SHA256}  /tmp/git.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/git.tar.xz -C /tmp \
 && cd "/tmp/git-${GIT_VERSION}" \
 && printf '%s\n' prefix=/usr/local sysconfdir=/etc NO_RUST=1 NO_GETTEXT=1 NO_TCLTK=1 \
      NO_PYTHON=1 NO_PERL=1 NO_EXPAT=1 INSTALL_SYMLINKS=1 > config.mak \
 && make -j"$(nproc)" all strip \
 && make DESTDIR=/out install

FROM ${NODE_IMAGE}

# The bookworm base already carries python3, make, g++, procps and
# openssh-client for the postinstall's node-gyp rebuilds and the process-tree
# tests. Electron's binary dynamically links GTK, NSS and friends even under
# ELECTRON_RUN_AS_NODE, which the unit suite uses. vitest.config.ts forces
# LC_ALL=en_US.UTF-8, so that locale must exist. Tests probe for the rest:
# sqlite3 (plugin database CLI interop), zsh, ksh and tcsh's /bin/csh (launch
# prompt quoting and ssh startup noise, which run every shell present, as on a
# Mac), and sshd plus lsof (the DAINTREE_SSH_E2E suites, `sx test-ssh`).
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libgbm1 \
      libgtk-3-0 libnss3 libxcomposite1 libxdamage1 libxkbcommon0 libxrandr2 \
      libxshmfence1 libxss1 locales \
      ksh lsof openssh-server sqlite3 tcsh zsh \
 && rm -rf /var/lib/apt/lists/* \
 && sed -i 's/^# *en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen \
 && locale-gen \
 && rm -f /etc/ssh/ssh_host_* \
 && install -d -m 755 /run/sshd \
 && install -d -m 1777 /run/user

# /usr/local/bin comes first on PATH, ahead of the distro's /usr/bin/git.
COPY --from=git /out/ /
RUN test "$(command -v git)" = /usr/local/bin/git \
 && git --version \
 && test -x /usr/local/libexec/git-core/git-remote-https \
 && ! ldd /usr/local/bin/git /usr/local/libexec/git-core/git-remote-https | grep 'not found'

# GitHub's runners default to C.UTF-8; Debian images to POSIX.
ENV LANG=C.UTF-8 \
    npm_config_audit=false \
    npm_config_fund=false \
    npm_config_update_notifier=false
