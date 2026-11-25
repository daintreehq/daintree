/**
 * What a Daintree Host on Linux needs from apt: the release deb's own
 * dependencies (electron-builder.config.cjs, `deb.depends`, which a test holds
 * this to), plus FUSE's mount helper for the AppImage and the tools a host's
 * projects use. Written as `apt-get satisfy` relations, so an alternative
 * keeps the order the deb gives it.
 */
export const LINUX_HOST_PACKAGES: readonly string[] = [
  "libc6 (>= 2.34)",
  "libgtk-3-0",
  "libnss3",
  "libasound2t64 | libasound2",
  "libgbm1",
  "libxkbcommon0",
  "libxrandr2",
  "libxshmfence1",
  "libxss1",
  "libxtst6",
  "libx11-6",
  "libx11-xcb1",
  "libxcb1",
  "libxdamage1",
  "libxfixes3",
  "libatk1.0-0",
  "libatk-bridge2.0-0",
  "libcups2",
  "libdbus-1-3",
  "libdrm2",
  "libexpat1",
  "libnotify4",
  "libnspr4",
  "libsecret-1-0",
  "xdg-utils",
  "fuse3 | fuse",
  "git",
  "ca-certificates",
  "curl",
  "procps",
];

/** {@link LINUX_HOST_PACKAGES} as one single-quoted shell word for `apt-get satisfy`. */
export const LINUX_HOST_PACKAGE_RELATIONS = `'${LINUX_HOST_PACKAGES.join(", ").replace(/'/g, `'"'"'`)}'`;

/** The line a person runs as root on a Debian or Ubuntu host to install every package the Host needs. */
export const HOST_PACKAGES_COMMAND = `apt-get update && apt-get satisfy -y --no-install-recommends ${LINUX_HOST_PACKAGE_RELATIONS}`;

/**
 * How a refused start hands {@link HOST_PACKAGES_COMMAND} on in its message.
 * The renderer finds the command by this exact text, wherever the message
 * travelled, and shows it as a command to copy rather than inside a sentence.
 */
export const HOST_PACKAGES_INSTRUCTION = `On Debian or Ubuntu, run this there as root, then try again: ${HOST_PACKAGES_COMMAND}`;

/**
 * `text` cut to at most `max` characters, ending in "…" where it was cut.
 * Where it carries {@link HOST_PACKAGES_INSTRUCTION} whole, the words before
 * it are cut instead, and anything after it dropped, so the command stays
 * whole and can still be offered.
 */
export function clipKeepingHostPackagesFix(text: string, max: number): string {
  if (text.length <= max) return text;
  const at = text.indexOf(HOST_PACKAGES_INSTRUCTION);
  const tail = ` ${HOST_PACKAGES_INSTRUCTION}`;
  if (at < 0 || tail.length >= max) return `${text.slice(0, max - 1)}…`;
  return `${text
    .slice(0, at)
    .trimEnd()
    .slice(0, max - tail.length - 1)}…${tail}`;
}
