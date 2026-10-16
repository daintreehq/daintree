import { execFile } from "child_process";
import { windowsSystemTool } from "./windowsExecutable.js";

/**
 * UNC path pattern for both Windows-side mount points exposed by WSL:
 *   \\wsl$\<distro>\...
 *   \\wsl.localhost\<distro>\...
 * Both forms are equivalent — they expose the WSL distro filesystem at the
 * UNC share root.
 */
const WSL_UNC_RE = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)(.*)/i;

const WSL_LIST_TIMEOUT_MS = 5_000;

export interface WslPathInfo {
  /** WSL distro name as captured from the UNC path (case preserved). */
  distro: string;
  /** POSIX path inside the distro filesystem (always starts with `/`). */
  posixPath: string;
}

/**
 * If `p` is a `\\wsl$\` or `\\wsl.localhost\` UNC path, return the distro name
 * and POSIX path inside that distro. Otherwise return null.
 *
 * The translation is purely string-based — both WSL UNC mount forms expose
 * the Linux filesystem root at the share root, so the path remainder is a
 * direct POSIX path with `\` rewritten to `/`.
 */
export function detectWslPath(p: string): WslPathInfo | null {
  if (typeof p !== "string" || !p) return null;
  const match = WSL_UNC_RE.exec(p);
  if (!match) return null;
  const distro = match[1];
  const remainder = match[2] ?? "";
  const posix = remainder.replace(/\\/g, "/") || "/";
  if (!distro) return null;
  return { distro, posixPath: posix };
}

/**
 * Return the name of the user's default WSL distro: the `wsl.exe --list
 * --verbose` row marked with `*` (see {@link listWslDistros}). On non-Windows
 * or when wsl.exe is unavailable, returns `null`.
 */
export function getDefaultWslDistro(): Promise<string | null> {
  return listWslDistros().then(
    (distros) => distros?.find((distro) => distro.isDefault)?.name ?? null
  );
}

/** One row of `wsl.exe --list --verbose`. */
export interface WslDistroEntry {
  name: string;
  isDefault: boolean;
  /** The WSL version column (1 or 2); null when the row doesn't end in one. */
  version: number | null;
  /** The STATE column as printed. Translated on non-English Windows, so never matched on. */
  state: string;
}

/**
 * WSL has historically emitted UTF-16LE (with BOM); newer Windows builds
 * honour `WSL_UTF8=1`. The encoding is picked heuristically, mirroring the
 * CliAvailabilityService probe.
 */
export function decodeWslOutput(buf: Buffer): string {
  const sample = buf.subarray(0, Math.min(buf.length, 64));
  let nullBytes = 0;
  for (const byte of sample) {
    if (byte === 0) nullBytes++;
  }
  const hasUtf16Bom = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
  const looksUtf16 = hasUtf16Bom || nullBytes > sample.length / 3;
  return looksUtf16 ? buf.toString("utf16le").replace(/^\uFEFF/, "") : buf.toString("utf8");
}

/**
 * Rows of `wsl.exe --list --verbose`. Lines look like:
 *   "* Ubuntu          Running         2"   (default)
 *   "  Debian          Stopped         2"   (non-default)
 * The NAME column is separated from STATE by 2+ spaces, which lets names
 * with internal spaces parse cleanly. The header row is translated, so it is
 * recognised by shape: it is the only row whose last column isn't a number.
 */
export function parseWslListVerbose(text: string): WslDistroEntry[] {
  const entries: WslDistroEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\0/g, "");
    const match = /^(\*|\s)\s*(.+?)\s{2,}(.+?)\s{2,}(\d+)\s*$/.exec(line);
    if (!match) continue;
    const name = match[2]?.trim();
    if (!name) continue;
    entries.push({
      name,
      isDefault: match[1] === "*",
      version: Number(match[4]),
      state: match[3]!.trim(),
    });
  }
  return entries;
}

/**
 * The installed WSL distros, the default one marked. The `*` marker is the
 * only locale-independent signal of the default: the header row and the
 * STATE column are both translated on non-English Windows, and `--list
 * --quiet` neither marks nor orders by it (issue #7944). Null on other
 * platforms or when wsl.exe can't be run; an empty list when WSL has no
 * distro (wsl.exe then exits non-zero with a hint on stdout).
 */
export function listWslDistros(): Promise<WslDistroEntry[] | null> {
  if (process.platform !== "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      windowsSystemTool("wsl.exe"),
      ["--list", "--verbose"],
      {
        env: { ...process.env, WSL_UTF8: "1" },
        timeout: WSL_LIST_TIMEOUT_MS,
        windowsHide: true,
        // Receive raw bytes so the UTF-16LE heuristic can actually run.
        // Without `encoding: "buffer"`, Node's execFile decodes stdout as
        // UTF-8 by default — which on older WSL builds (pre-WSL_UTF8) yields
        // a corrupted string before we ever see the bytes.
        encoding: "buffer",
      },
      (err, stdout) => {
        const buf = Buffer.isBuffer(stdout)
          ? stdout
          : Buffer.from(typeof stdout === "string" ? stdout : "", "utf8");
        if (err) {
          // Spawn failures (no WSL at all) carry a string code; an exit code
          // with no rows is WSL with nothing installed.
          const exitCode = (err as { code?: unknown }).code;
          resolve(typeof exitCode === "number" ? parseWslListVerbose(decodeWslOutput(buf)) : null);
          return;
        }
        resolve(parseWslListVerbose(decodeWslOutput(buf)));
      }
    );
  });
}
