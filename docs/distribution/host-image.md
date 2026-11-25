# Host container image

`ghcr.io/daintreehq/daintree-host` is the container a container cloud runs as a Daintree Remote Host: sshd on port 22, one unprivileged login that takes Daintree's SSH key when the container starts, and every package a Linux Host needs, already installed. It holds no Daintree: Host setup installs Daintree over SSH as it does on any Linux machine, and starts it without systemd or FUSE. Nothing in it is specific to one provider; the deployment that runs it belongs to that provider's integration.

The source is [`build/host-image/`](../../build/host-image/), and [`publish-host-image.yml`](../../.github/workflows/publish-host-image.yml) publishes it.

## Referencing it

Reference the image by digest, never by tag:

```
ghcr.io/daintreehq/daintree-host@sha256:<digest>
```

Each version is published once, under its version tag (`1.0.0`) and nothing else. There is no `latest` and no floating tag such as `1` or `1.0`. The publish run's summary gives the full `@sha256:` reference, and so does its `host-image-record` artifact (`host-image.json`, with the version, source commit and platform). A build-provenance attestation ties that digest to the commit and the run, and `gh attestation verify oci://ghcr.io/daintreehq/daintree-host@sha256:<digest> --repo daintreehq/daintree` checks it.

Only `linux/amd64` is published.

## Inputs

The container reads two inputs when it starts. Each comes from an environment variable, or a file a `_FILE` variable names, or a secret file mounted at its default path, in that order. Setting a variable and its `_FILE` together is refused.

| Input | Variable | File variable | Default secret file | Required |
| --- | --- | --- | --- | --- |
| Public keys the login accepts, one per line, in `authorized_keys` format | `DAINTREE_AUTHORIZED_KEYS` | `DAINTREE_AUTHORIZED_KEYS_FILE` | `/run/secrets/daintree_authorized_keys` | Yes |
| The SSH host private key, unencrypted, in OpenSSH or PEM format | `DAINTREE_SSH_HOST_KEY` | `DAINTREE_SSH_HOST_KEY_FILE` | `/run/secrets/daintree_ssh_host_key` | No |

- **As given or base64.** A value is used as given when it reads as a key, and base64-decoded otherwise, for an environment that can't carry the lines a key spans. Either form is checked with `ssh-keygen` before sshd starts.
- **Refused starts.** The container exits non-zero, saying which input is wrong and never echoing it, when there's no authorized key, when an input is set but empty, when a `_FILE` names a file it can't read, when the authorized keys hold no public key (or hold a private one), or when the host key is encrypted or isn't a key.
- **The host key.** With a host key given, sshd serves that key and no other, so a client that pinned it before the first connection reaches exactly that machine. A bad key given at a restart stops the start even when a good one from an earlier start is still on disk. Without one, the container generates an ed25519 key on its first start, keeps it across restarts that keep the filesystem, and prints its fingerprint to the container log for a person checking a first connection. A container started on a fresh filesystem generates a different key.
- **Every start replaces the authorized keys** with exactly what it was given.

Prefer a mounted secret to an environment variable where the runtime has one: an environment variable stays in the container's settings, where `docker inspect` and `docker exec` can read it. The entrypoint clears both variables before sshd starts, so no SSH login inherits them, and a mounted private key file should be readable only by root.

## The login

| Setting | Value |
| --- | --- |
| User | `daintree`, uid and gid 1500, home `/home/daintree`, shell `/bin/bash`, no sudo |
| Authentication | Public key only. Password, keyboard-interactive and empty-password logins are off, root can't log in, and no other user is allowed |
| Port | 22 |
| Forwarding | TCP and Unix socket forwarding are on: the link reaches the Host's socket through `ssh -O forward -L` |
| Locale | Sessions get `LANG=C.UTF-8`, and sshd accepts no locale or other variables from the client |

The authorized keys live in `/etc/ssh/daintree/authorized_keys`, owned by root, so nothing running as the login can add a key of its own.

## What runs

The entrypoint installs the keys, checks sshd's configuration, then hands PID 1 to `tini`, with `sshd -D` beneath it in the foreground. The container lives as long as sshd. tini reaps the processes a Host leaves behind when the SSH login that started it ends.

There's no init system: systemd's package is installed (Ubuntu's `openssh-server` depends on it) but never runs, and there's no `/run/user/1500` or `/dev/fuse`. Host setup sees PID 1 isn't systemd, so it starts Host mode on connect, in a session of its own, with its socket under `~/.cache/daintree/run` and its output in `~/.cache/daintree/host.log`. A connection that finds it stopped, after a container restart for example, starts it again. The AppImage runs extracted, since there's no FUSE. None of this needs `--privileged`, an added capability or `--init`.

The image is Ubuntu 24.04, pinned by digest in the Dockerfile, plus the packages in [`linuxHostPackages.ts`](../../shared/config/linuxHostPackages.ts) (a test holds the Dockerfile to that list), `openssh-server` and `tini`.

## Running it by hand

```bash
docker run --detach --publish 2222:22 \
  --env DAINTREE_AUTHORIZED_KEYS="$(cat ~/.ssh/id_ed25519.pub)" \
  ghcr.io/daintreehq/daintree-host@sha256:<digest>
ssh -p 2222 daintree@localhost
```

Then add it from Settings → Hosts as an SSH host.

## Publishing a version

1. Land the change on `develop`, and wait for it to reach `main` with a release.
2. Tag the commit on `main` as `host-image-vX.Y.Z` with the next version, and push the tag. A version that already holds another image is refused, so a fix needs a new version.
3. `publish-host-image.yml` builds the image for `linux/amd64`, packages an AppImage from the same commit, runs the container suite against the image (from a bare machine through Host setup to a started Host and a working terminal), and pushes exactly the bytes it tested.
4. Copy the `@sha256:` reference from the run's summary into whatever pins it.

A manual run of the workflow, from any branch, builds and tests the image without publishing anything. Re-running a tag's failed jobs is safe: a run that finds its own image already under the version records it instead of pushing again.

The first version creates the package, and GHCR makes new packages private. Providers pull without credentials, so a person makes the package public once, in the package's settings on GitHub. The publish run warns until it is.

## Testing it locally

`npm run test:host-install -- image` runs the container suite against the image built from `build/host-image/` on the local Docker daemon. `docs/development.md` covers what it needs.
