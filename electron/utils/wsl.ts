import { execFile } from "child_process";

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
 * Return the name of the first WSL distro listed by `wsl.exe --list --quiet`.
 * On non-Windows or when wsl.exe is unavailable, returns `null`.
 *
 * Encoding handling mirrors the CliAvailabilityService probe: WSL has
 * historically emitted UTF-16LE (with BOM); newer Windows builds honour
 * `WSL_UTF8=1`. We pick the encoding heuristically.
 */
export function listFirstWslDistro(): Promise<string | null> {
  if (process.platform !== "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      "wsl.exe",
      ["--list", "--quiet"],
      {
        env: { ...process.env, WSL_UTF8: "1" },
        timeout: WSL_LIST_TIMEOUT_MS,
        windowsHide: true,
        // Receive raw bytes so the UTF-16LE heuristic below can actually run.
        // Without `encoding: "buffer"`, Node's execFile decodes stdout as
        // UTF-8 by default — which on older WSL builds (pre-WSL_UTF8) yields
        // a corrupted string before we ever see the bytes.
        encoding: "buffer",
      },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const buf = Buffer.isBuffer(stdout)
          ? stdout
          : Buffer.from(typeof stdout === "string" ? stdout : "", "utf8");

        const sample = buf.subarray(0, Math.min(buf.length, 64));
        let nullBytes = 0;
        for (const byte of sample) {
          if (byte === 0) nullBytes++;
        }
        const hasUtf16Bom = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
        const looksUtf16 = hasUtf16Bom || nullBytes > sample.length / 3;

        const decoded = looksUtf16
          ? buf.toString("utf16le").replace(/^\uFEFF/, "")
          : buf.toString("utf8");

        const lines = decoded
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        resolve(lines[0] ?? null);
      }
    );
  });
}
