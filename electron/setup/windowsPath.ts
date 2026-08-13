// Windows PATH resolution, read straight from the registry.
//
// Kept separate from the heavy `environment.ts` (which runs `app.getPath`/
// `setPath`, `app.commandLine`, fs, and SQLite work at module load) so
// importers that only need a PATH refresh — the terminal spawn handler — don't
// pull that startup machinery into their graph. Same rationale as
// `runtimeFlags.ts` and `deepLinkUrlQueue.ts`. Node builtins only.
//
// `deduplicatePath` lives here rather than in `environment.ts` because this is
// the dependency-free leaf: `environment.ts` imports it back for its POSIX
// branch, and the reverse direction would be a cycle.

import { execFile } from "child_process";
import { existsSync } from "fs";
import os from "os";
import path from "path";

// A terminal spawn re-reads the registry at most this often. `reg.exe` is two
// process spawns (30-100ms+ each on Windows once Defender inspects them), which
// is real latency on the spawn path, so a burst — a recipe opening six panes, a
// session restore replaying a grid — collapses onto one read. Anything longer
// than a few seconds and "install a tool, open a terminal" would still miss it,
// which is the whole point of #11773.
const SPAWN_PATH_REFRESH_TTL_MS = 5_000;

// Single-flight for the registry read itself, shared by every caller (startup
// refresh, CLI availability probes, terminal spawns). Cleared on settlement so
// a later call re-queries rather than pinning a stale answer.
let registryReadPromise: Promise<string | null> | null = null;

// When the last registry read *settled*, success or failure. Stamped on both
// outcomes on purpose: this is a short cooldown so a failing `reg.exe` can't be
// hammered once per pane, not a success cache. `null` means "never read".
//
// `performance.now()` rather than `Date.now()`: the wall clock can step
// backwards (NTP correction, the user fixing their timezone), which would make
// the elapsed comparison negative and suppress every refresh until real time
// caught up — a stale PATH for as long as the jump.
let lastRegistryReadAt: number | null = null;

function deduplicatePath(pathStr: string, caseInsensitive: boolean): string {
  const entries = pathStr.split(path.delimiter).filter(Boolean);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const entry of entries) {
    const key = caseInsensitive ? entry.toLowerCase() : entry;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(entry);
    }
  }
  return unique.join(path.delimiter);
}

export function expandWindowsEnvVars(str: string): string {
  return str.replace(/%([^%]+)%/g, (match, name: string) => process.env[name] ?? match);
}

function getWindowsExtraPaths(): string[] {
  const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const chocoInstall = process.env["ChocolateyInstall"] || "C:\\ProgramData\\chocolatey";
  const home = os.homedir();

  const paths = [
    path.join(home, "AppData", "Roaming", "npm"),
    path.join(home, "AppData", "Local", "Programs", "Git", "cmd"),
    path.join(programFiles, "Git", "cmd"),
    path.join(programFilesX86, "Git", "cmd"),
    path.join(home, "scoop", "shims"),
    path.join(chocoInstall, "bin"),
  ];

  // Volta: env var first, hardcoded fallback
  if (process.env["VOLTA_HOME"]) {
    paths.push(path.join(process.env["VOLTA_HOME"], "bin"));
  } else {
    paths.push(path.join(home, "AppData", "Local", "Volta", "bin"));
  }

  // pnpm: env var only
  if (process.env["PNPM_HOME"]) {
    paths.push(process.env["PNPM_HOME"]);
  }

  // fnm: env var only (dynamic per session)
  if (process.env["FNM_MULTISHELL_PATH"]) {
    paths.push(process.env["FNM_MULTISHELL_PATH"]);
  }

  // nvm-windows: env var only
  if (process.env["NVM_SYMLINK"]) {
    paths.push(process.env["NVM_SYMLINK"]);
  }

  return paths;
}

function readWindowsRegistryPath(): Promise<string> {
  const keys = [
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
    "HKCU\\Environment",
  ];

  return Promise.all(
    keys.map(
      (key) =>
        new Promise<string>((resolve) => {
          // windowsHide, as everywhere else this repo shells out: `reg.exe` is a
          // console-subsystem binary and a GUI Electron process has no console
          // to inherit, so without it Windows opens a real window. Tolerable
          // once at startup; this now runs per terminal-open.
          const options = { timeout: 3_000, windowsHide: true };
          execFile("reg", ["query", key, "/v", "Path"], options, (err, stdout) => {
            if (err || !stdout) return resolve("");
            const match = stdout.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
            resolve(expandWindowsEnvVars(match?.[1]?.trim() ?? ""));
          });
        })
    )
  ).then((paths) => paths.filter(Boolean).join(path.delimiter));
}

export function applyWindowsExtraPaths(currentPath: string): string {
  const extraPaths = getWindowsExtraPaths();
  const existingEntries = currentPath.split(path.delimiter).map((e) => e.toLowerCase());
  const missing = extraPaths.filter(
    (p) => !existingEntries.includes(p.toLowerCase()) && existsSync(p)
  );

  return missing.length ? [...missing, currentPath].join(path.delimiter) : currentPath;
}

async function runResolveWindowsRegistryPath(): Promise<string | null> {
  try {
    const registryPath = await readWindowsRegistryPath();
    if (!registryPath) return null;
    return deduplicatePath(applyWindowsExtraPaths(registryPath), true);
  } finally {
    // Inside the run, not on a `.then` chain hung off it: a derived promise's
    // handler lands a microtask AFTER the awaiting caller resumes, which would
    // leave the settled read installed as "in flight" long enough for the very
    // next call to join it and get the previous answer.
    lastRegistryReadAt = performance.now();
    registryReadPromise = null;
  }
}

/**
 * Read the machine + user PATH out of the registry and merge it with the
 * version-manager shim dirs that never appear there.
 *
 * Returns the merged value; does NOT write `process.env`. Callers decide
 * whether to adopt it — `refreshPath()` has a timeout race to honour first.
 * `null` means the registry read yielded nothing (both keys errored or were
 * empty), in which case the caller keeps whatever PATH it already had.
 *
 * Single-flight: concurrent callers share one `reg.exe` pair.
 */
export function resolveWindowsRegistryPath(): Promise<string | null> {
  if (registryReadPromise) return registryReadPromise;

  const promise = runResolveWindowsRegistryPath();
  registryReadPromise = promise;
  // Swallow on a detached branch so a rejection can't surface as an unhandled
  // rejection when the only awaiter is a caller that already try/catches.
  void promise.catch(() => null);
  return promise;
}

/**
 * Refresh `process.env.PATH` from the registry on behalf of a terminal spawn.
 *
 * The pty-host is forked with a one-time spread of Main's `process.env`
 * (`PtyHostLifecycle.start`), so a PATH that changed after that fork is
 * invisible to every terminal the host spawns — installing a tool and opening a
 * new pane surfaced nothing until the app was restarted (#11773). Main re-reads
 * the registry here and `PtyClient` stamps the result onto each spawn message,
 * which is what actually crosses the process boundary.
 *
 * No-op off Windows: macOS/Linux resolve their PATH through the shell probe at
 * startup and have no equivalent registry to drift against.
 *
 * Never throws and never rejects — a registry read that fails must degrade to
 * "spawn with the PATH we already have", not block terminal creation.
 */
export async function refreshWindowsPathForSpawn(): Promise<void> {
  if (process.platform !== "win32") return;

  // Join an in-flight read before consulting the TTL: a refresh that started
  // moments ago is strictly fresher than the timestamp it hasn't stamped yet,
  // and skipping on the old stamp would hand this spawn the previous answer.
  if (
    !registryReadPromise &&
    lastRegistryReadAt !== null &&
    performance.now() - lastRegistryReadAt < SPAWN_PATH_REFRESH_TTL_MS
  ) {
    return;
  }

  try {
    const resolved = await resolveWindowsRegistryPath();
    if (resolved) process.env.PATH = resolved;
  } catch {
    // Keep the existing PATH.
  }
}

/** Test seam — module-level single-flight and TTL state outlive `vi.resetModules()` consumers. */
export function __resetWindowsPathStateForTests(): void {
  registryReadPromise = null;
  lastRegistryReadAt = null;
}
