import crypto from "node:crypto";
import { LINUX_HOST_PACKAGES } from "../../client/linuxHostLibraries.js";

/** The unprivileged login a Droplet is prepared with; the Host runs as this user, never as root. */
export const DROPLET_SSH_USER = "daintree";

const KEY_TYPES = new Set([
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "ssh-rsa",
]);

/** An OpenSSH public key's type and base64 blob, without its comment. */
export interface ParsedPublicKey {
  type: string;
  blob: string;
}

/** The type and blob of `type base64 [comment]`; null for anything else. */
export function parsePublicKey(publicKey: string): ParsedPublicKey | null {
  const [type, blob] = publicKey.trim().split(/\s+/);
  if (!type || !blob || !KEY_TYPES.has(type)) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) return null;
  // The blob names its own type first: one that disagrees isn't the key it claims to be.
  const decoded = Buffer.from(blob, "base64");
  if (decoded.length < 4) return null;
  const length = decoded.readUInt32BE(0);
  if (decoded.subarray(4, 4 + length).toString("latin1") !== type) return null;
  return { type, blob };
}

/** The MD5 fingerprint DigitalOcean files an account key under: colon-separated hex of the decoded blob. */
export function md5Fingerprint(key: ParsedPublicKey): string {
  const digest = crypto.createHash("md5").update(Buffer.from(key.blob, "base64")).digest("hex");
  return digest.match(/../g)!.join(":");
}

/**
 * The first-boot script a Droplet runs as root (cloud-init runs user data
 * that starts with `#!` as a script once, after the image's own setup).
 *
 * DigitalOcean puts the key on root too, since a create can only name a key
 * that way; that authorization is taken off first, so Daintree's key never
 * keeps root access, whether or not the rest succeeds. Then the script makes
 * the `daintree` user, installs what the Host needs, keeps that user's
 * services running without a login, and as its very last step lets the key
 * log in as it. So a successful login is also the sign the machine is ready:
 * until then, sshd answers but turns the key away.
 */
export function dropletUserData(key: ParsedPublicKey): string {
  const user = DROPLET_SSH_USER;
  const packages = LINUX_HOST_PACKAGES.join(", ");
  return [
    "#!/bin/sh",
    "# Prepared by Daintree: a user for its Host, the libraries the Host needs, then that user's SSH key.",
    "set -eu",
    "export DEBIAN_FRONTEND=noninteractive",
    `U=${user}`,
    `KEY_TYPE='${key.type}'`,
    `BLOB='${key.blob}'`,
    // Replaced whole, keeping the file's owner and mode. Only a line whose key is this one goes: its
    // first two fields, or the two after a leading options field.
    "R=/root/.ssh/authorized_keys",
    'if [ -f "$R" ]; then',
    "  T=$(mktemp /root/.ssh/.authorized_keys.XXXXXX)",
    '  awk -v t="$KEY_TYPE" -v b="$BLOB" \'($1 == t && $2 == b) || ($2 == t && $3 == b) { next } { print }\' "$R" > "$T"',
    '  chown --reference="$R" "$T"',
    '  chmod --reference="$R" "$T"',
    '  mv -f "$T" "$R"',
    "fi",
    // A password nobody can type rather than a locked account: sshd without PAM turns locked accounts away.
    `id "$U" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --password '*' "$U"`,
    // First boot often runs unattended-upgrades alongside, holding apt's locks for minutes: keep trying
    // for about ten, and count an index that failed to download as a failure, not a stale success.
    "n=0",
    `until apt-get -o DPkg::Lock::Timeout=600 --error-on=any update && apt-get -o DPkg::Lock::Timeout=600 satisfy -y --no-install-recommends '${packages}'; do`,
    '  n=$((n + 1)); [ "$n" -ge 30 ] && exit 1; sleep 20',
    "done",
    // Chromium's sandbox needs user namespaces, which Ubuntu 24.04's AppArmor only grants a profiled
    // /opt install; the Host runs from an AppImage in its home, on a machine that exists for it.
    "if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then",
    "  printf 'kernel.apparmor_restrict_unprivileged_userns=0\\n' > /etc/sysctl.d/60-daintree-host.conf",
    "  sysctl -q -p /etc/sysctl.d/60-daintree-host.conf",
    "fi",
    'loginctl enable-linger "$U"',
    'H=$(getent passwd "$U" | cut -d: -f6)',
    'install -d -m 700 -o "$U" -g "$U" "$H/.ssh"',
    'K=$(mktemp "$H/.ssh/.authorized_keys.XXXXXX")',
    'printf \'%s %s\\n\' "$KEY_TYPE" "$BLOB" > "$K"',
    'chown "$U:$U" "$K"',
    'chmod 600 "$K"',
    // Last, and atomic: nothing can log in as the user until everything above is done.
    'mv -f "$K" "$H/.ssh/authorized_keys"',
    "",
  ].join("\n");
}
