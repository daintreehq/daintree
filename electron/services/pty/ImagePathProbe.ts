import { execFile } from "child_process";
import { promisify } from "node:util";
import { readlink } from "node:fs/promises";

const execFileAsync = promisify(execFile);

// Stale-while-revalidate windows. Soft-stale (500ms) triggers a background
// refresh on the next read; the cached basename is still returned so the
// detector keeps a continuous signal across polls. Hard-max (5000ms) is
// 3-4× the 1500ms ProcessTreeCache poll interval — using anything close to
// the poll interval causes every poll to fall past max-age in setTimeout
// jitter, blanking the basename and defeating hysteresis. Eviction TTL keeps
// idle PIDs out of the map so it cannot grow unbounded across a long session
// of short-lived children; ProcessDetector also evicts disappeared child
// PIDs proactively so PID reuse can't return a stale prior-process basename.
const IMAGE_PATH_SOFT_STALE_MS = 500;
const IMAGE_PATH_MAX_AGE_MS = 5000;
const IMAGE_PATH_PROBE_TIMEOUT_MS = 750;
const IMAGE_PATH_EVICTION_TTL_MS = 30_000;

// `lsof -Fn` on macOS lists every memory-mapped text segment for the process —
// the actual executable, plus dylibs/frameworks/system libs that share the
// `txt` fd class. Filter those out so we land on the real binary rather than
// the first system library the process loaded.
// Narrow to `/System/Library/` (not bare `/System/`) so apps installed under
// `/System/Applications/Foo.app/Contents/MacOS/Foo` are still picked up as the
// executable rather than misclassified as a system library.
const MACOS_SYSTEM_PATH_PREFIXES = ["/System/Library/", "/usr/lib/", "/Library/Apple/"];
const MACOS_LIBRARY_SUFFIXES = [".dylib", ".framework", ".bundle"];

interface CacheEntry {
  basename: string | null;
  updatedAt: number;
  lastReadAt: number;
  refreshing: boolean;
  checkId: number;
}

/**
 * Resolves the on-disk executable image basename for a given PID. The image
 * path is immune to `process.title` / `setproctitle` rewrites (an agent CLI
 * that renames itself to "Claude Code" still has `/opt/homebrew/bin/claude`
 * as its image), so it gives `ProcessDetector` a third identity signal that
 * survives the title-rewriting case the kernel `comm` and argv columns fail.
 *
 * Stale-while-revalidate per PID so the synchronous `detectAgent()` contract
 * stays synchronous — first call schedules an async resolution, subsequent
 * calls within the freshness window return the cached basename, calls past
 * the soft-stale window trigger a refresh while still returning the cached
 * value. Past hard-max we return null until the refresh completes.
 *
 * Platform dispatch:
 *  - Linux: `readlink /proc/<pid>/exe` (pure Node, ~instant)
 *  - macOS: `lsof -a -d txt -p <pid> -Fn` filtered to skip system libs
 *  - Windows: PowerShell `Get-CimInstance Win32_Process … ExecutablePath`
 *  - Other: returns null (no probe scheduled)
 *
 * All probe failures are swallowed — image-path is a supplementary signal,
 * not a primary one, so falling back to the existing comm/argv path is
 * always safe.
 */
export class ImagePathProbe {
  private readonly entries = new Map<number, CacheEntry>();
  private disposed = false;
  // Probe-wide monotonic counter so a refresh that resolves AFTER its entry
  // was evicted-and-recreated cannot overwrite the new entry — the new entry
  // will have a different checkId from the in-flight one. A per-entry counter
  // would reset to 0 on recreation and collide with the in-flight value.
  private nextCheckId = 0;

  /**
   * Sync read against the per-PID cache. Returns the cached executable
   * basename (lowercased, extension stripped) or null when unknown / past
   * the hard-max age. Schedules an async refresh when the entry is missing
   * or past soft-stale. Eviction TTL: unreferenced entries drop after 30s.
   */
  readBasename(pid: number): string | null {
    if (this.disposed) return null;
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (!this.isPlatformSupported()) return null;

    const now = Date.now();
    let entry = this.entries.get(pid);

    if (!entry) {
      entry = {
        basename: null,
        updatedAt: 0,
        lastReadAt: now,
        refreshing: false,
        checkId: this.nextCheckId,
      };
      this.entries.set(pid, entry);
      this.scheduleRefresh(pid, entry);
      this.evictStale(now);
      return null;
    }

    entry.lastReadAt = now;

    const hasEverProbed = entry.updatedAt > 0;
    const age = hasEverProbed ? now - entry.updatedAt : 0;

    if (!entry.refreshing && (!hasEverProbed || age > IMAGE_PATH_SOFT_STALE_MS)) {
      this.scheduleRefresh(pid, entry);
    }

    if (!hasEverProbed) return null;
    if (age > IMAGE_PATH_MAX_AGE_MS) return null;

    return entry.basename;
  }

  /**
   * Drop a PID immediately. Call this when a child process is known to have
   * exited so a recycled PID does not return the prior process's basename.
   */
  evict(pid: number): void {
    this.entries.delete(pid);
  }

  /**
   * Tear down the probe. After dispose all reads return null and no further
   * refreshes are scheduled.
   */
  dispose(): void {
    this.disposed = true;
    this.entries.clear();
  }

  private isPlatformSupported(): boolean {
    return (
      process.platform === "linux" || process.platform === "darwin" || process.platform === "win32"
    );
  }

  private evictStale(now: number): void {
    for (const [pid, entry] of this.entries) {
      if (now - entry.lastReadAt > IMAGE_PATH_EVICTION_TTL_MS && !entry.refreshing) {
        this.entries.delete(pid);
      }
    }
  }

  private scheduleRefresh(pid: number, entry: CacheEntry): void {
    entry.refreshing = true;
    const checkId = ++this.nextCheckId;
    entry.checkId = checkId;
    void this.refresh(pid)
      .then((basename) => {
        if (this.disposed) return;
        const current = this.entries.get(pid);
        // Stale-write guard: another refresh may have superseded this one if
        // the entry was evicted and recreated in the meantime.
        if (!current || current.checkId !== checkId) return;
        current.basename = basename;
        current.updatedAt = Date.now();
        current.refreshing = false;
      })
      .catch(() => {
        if (this.disposed) return;
        const current = this.entries.get(pid);
        if (!current || current.checkId !== checkId) return;
        // Persisting null with a fresh timestamp matches ForegroundProcessGroupProbe:
        // prevents tight-retry while the underlying failure is still active.
        current.basename = null;
        current.updatedAt = Date.now();
        current.refreshing = false;
      });
  }

  private async refresh(pid: number): Promise<string | null> {
    try {
      const platform = process.platform;
      if (platform === "linux") return await this.resolveLinux(pid);
      if (platform === "darwin") return await this.resolveMacOS(pid);
      if (platform === "win32") return await this.resolveWindows(pid);
      return null;
    } catch {
      return null;
    }
  }

  private async resolveLinux(pid: number): Promise<string | null> {
    try {
      const target = await readlink(`/proc/${pid}/exe`);
      return this.toBasename(this.stripDeletedSuffix(target));
    } catch {
      return null;
    }
  }

  private async resolveMacOS(pid: number): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        "lsof",
        ["-a", "-d", "txt", "-p", String(pid), "-Fn"],
        {
          encoding: "utf8",
          shell: false,
          signal: AbortSignal.timeout(IMAGE_PATH_PROBE_TIMEOUT_MS),
        }
      );
      return this.parseLsofOutput(stdout);
    } catch {
      return null;
    }
  }

  private async resolveWindows(pid: number): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ExecutablePath`,
        ],
        {
          encoding: "utf8",
          shell: false,
          signal: AbortSignal.timeout(IMAGE_PATH_PROBE_TIMEOUT_MS),
        }
      );
      const trimmed = stdout.trim();
      if (!trimmed) return null;
      return this.toBasename(trimmed);
    } catch {
      return null;
    }
  }

  private parseLsofOutput(stdout: string): string | null {
    // `lsof -Fn` emits per-fd records. Each record's `n`-prefixed line is the
    // mapped path. We may see several `n` lines (the executable plus every
    // dylib/framework it has mapped). Take the first path that is absolute,
    // not under a system library prefix, and not itself a library file.
    let fallback: string | null = null;
    for (const rawLine of stdout.split("\n")) {
      if (!rawLine.startsWith("n")) continue;
      const filePath = rawLine.slice(1).trim();
      if (!filePath) continue;
      if (!filePath.startsWith("/")) continue;
      if (!fallback) fallback = filePath;
      if (this.isMacOSLibraryPath(filePath)) continue;
      return this.toBasename(filePath);
    }
    return fallback ? this.toBasename(fallback) : null;
  }

  private isMacOSLibraryPath(filePath: string): boolean {
    for (const prefix of MACOS_SYSTEM_PATH_PREFIXES) {
      if (filePath.startsWith(prefix)) return true;
    }
    const lower = filePath.toLowerCase();
    for (const suffix of MACOS_LIBRARY_SUFFIXES) {
      if (lower.endsWith(suffix)) return true;
      // Inside a bundle: `.../Foo.framework/Versions/A/Foo` is still a library
      // (the executable inside a framework), not the program we want.
      if (lower.includes(`${suffix}/`)) return true;
    }
    return false;
  }

  private stripDeletedSuffix(target: string): string {
    // procfs readlink appends ` (deleted)` when the original file has been
    // unlinked while the process is still running (e.g. upgrade-in-place).
    return target.replace(/\s+\(deleted\)\s*$/u, "");
  }

  private toBasename(fullPath: string): string | null {
    const trimmed = fullPath.trim();
    if (!trimmed) return null;
    // Split on both POSIX and Windows separators so a Windows-style path
    // resolves correctly when this code runs on macOS/Linux (tests, dev
    // boxes). path.basename respects the running platform's separator only.
    const baseRaw = trimmed.split(/[\\/]/).pop() || trimmed;
    const lower = baseRaw.toLowerCase();
    // Strip Windows executable extensions so the basename lines up with the
    // lowercase keys the candidate builder uses for AGENT_CLI_NAMES /
    // PROCESS_ICON_MAP lookups.
    const stripped = lower.replace(/\.(exe|cmd|bat|com|ps1)$/u, "");
    return stripped || null;
  }
}
