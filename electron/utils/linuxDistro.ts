import fs from "fs";

/**
 * The package-manager family an install hint is written for. `fedora` is
 * Fedora itself and its direct derivatives (DNF5, current repos); `rhel` is
 * the enterprise line (DNF4, older AppStream defaults).
 */
export type LinuxDistroFamily = "debian" | "fedora" | "rhel" | "arch" | "suse";

/** os-release locations in lookup order, per os-release(5). */
const OS_RELEASE_PATHS = ["/etc/os-release", "/usr/lib/os-release"];

/** Exact `ID` values, checked before `ID_LIKE`. */
const FAMILY_BY_ID: Record<string, LinuxDistroFamily> = {
  debian: "debian",
  ubuntu: "debian",
  fedora: "fedora",
  rhel: "rhel",
  centos: "rhel",
  rocky: "rhel",
  almalinux: "rhel",
  ol: "rhel",
  amzn: "rhel",
  arch: "arch",
  sles: "suse",
  sled: "suse",
  suse: "suse",
};

/**
 * `ID_LIKE` tokens. A distro that is merely like Fedora (Ultramarine, say)
 * tracks Fedora closely enough to take Fedora's commands; one that lists
 * `rhel` first (Nobara) is on the enterprise line. Enterprise rebuilds that
 * only claim `fedora` (Oracle's `ol`, Amazon's `amzn`) are caught by `ID`.
 */
const FAMILY_BY_LIKE: Record<string, LinuxDistroFamily> = {
  debian: "debian",
  ubuntu: "debian",
  fedora: "fedora",
  rhel: "rhel",
  centos: "rhel",
  arch: "arch",
  suse: "suse",
};

/**
 * Parses os-release(5) content into its fields. Values may be unquoted or
 * wrapped in single or double quotes; inside double quotes `\"`, `\\`, `` \` ``
 * and `\$` are escapes. Comments and malformed lines are skipped.
 */
export function parseOsRelease(content: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\(["\\`$])/g, "$1");
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    fields[match[1]] = value;
  }
  return fields;
}

/** Own keys only: an `ID=constructor` must not resolve to Object.prototype's. */
function ownFamily(
  table: Record<string, LinuxDistroFamily>,
  key: string
): LinuxDistroFamily | null {
  return Object.hasOwn(table, key) ? table[key] : null;
}

/**
 * The family whose install commands fit this system, or null when nothing in
 * `ID` or `ID_LIKE` is recognised. `ID` wins; then `ID_LIKE` in its own order,
 * which os-release defines as closest relative first.
 */
export function classifyLinuxDistro(fields: Record<string, string>): LinuxDistroFamily | null {
  const id = fields.ID?.trim().toLowerCase() ?? "";
  if (id) {
    const exact = ownFamily(FAMILY_BY_ID, id);
    if (exact) return exact;
    if (id.startsWith("opensuse")) return "suse";
  }
  for (const token of (fields.ID_LIKE ?? "").toLowerCase().split(/\s+/)) {
    if (!token) continue;
    const like = ownFamily(FAMILY_BY_LIKE, token);
    if (like) return like;
    if (token.startsWith("opensuse")) return "suse";
  }
  return null;
}

/**
 * Reads and classifies the running system's os-release. Fail-soft: a missing
 * or unreadable file means "unknown distro", never an error.
 */
export function readLinuxDistroFamily(
  readFile: (filePath: string) => string = (filePath) => fs.readFileSync(filePath, "utf8")
): LinuxDistroFamily | null {
  for (const filePath of OS_RELEASE_PATHS) {
    let content: string;
    try {
      content = readFile(filePath);
    } catch {
      continue;
    }
    return classifyLinuxDistro(parseOsRelease(content));
  }
  return null;
}

let cachedFamily: LinuxDistroFamily | null | undefined;

/** {@link readLinuxDistroFamily}, read once per process. */
export function getLinuxDistroFamily(): LinuxDistroFamily | null {
  if (cachedFamily === undefined) cachedFamily = readLinuxDistroFamily();
  return cachedFamily;
}

/** Test seam — forgets the cached family. */
export function resetLinuxDistroFamilyCache(): void {
  cachedFamily = undefined;
}
