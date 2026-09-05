import { execFile } from "child_process";
import { promisify } from "node:util";
import { readlink } from "node:fs/promises";

const execFileAsync = promisify(execFile);

// The probe timeout caps lsof/readlink time per PID.
const IMAGE_PATH_PROBE_TIMEOUT_MS = 750;
// Eviction TTL keeps idle PIDs out of the map so it cannot grow unbounded
// across long sessions with many short-lived children. ProcessDetector also
// evicts disappeared child PIDs proactively so PID reuse cannot return a
// stale prior-process basename.
const IMAGE_PATH_EVICTION_TTL_MS = 30_000;
// Negative-result backoff. A probe that resolves nothing is not retried until
// the delay has passed, and the delay doubles on each consecutive failure from
// 3s to a 48s ceiling. ProcessDetector reads every shallow PID on every
// ProcessTreeCache poll, so without this a PID the probe can never read costs
// one `lsof`/PowerShell start per poll for as long as the process lives.
// Every step is a whole multiple of the 1500ms poll interval rather than a
// value near it, so a retry cannot land between two polls and slip a whole
// interval (#8794). The resulting ladder — probes at 0s, 3s, 9s, 21s, 45s —
// is 5 starts a minute against the 40 a 1.5s poll used to produce.
export const IMAGE_PATH_RETRY_BASE_MS = 3_000;
export const IMAGE_PATH_RETRY_MAX_MS = 48_000;

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
  /** When the last probe SETTLED. Paired with `retryDelayMs` it gates retries. */
  updatedAt: number;
  lastReadAt: number;
  refreshing: boolean;
  checkId: number;
  /**
   * How long after `updatedAt` the next probe of a null result may run. Zero
   * until a probe has failed, so a fresh entry probes immediately, and back to
   * zero on success. Lives on the entry rather than beside the map so
   * `evict()` — which deletes the whole object — resets it for free, and a
   * recycled PID starts from an unthrottled probe.
   */
  retryDelayMs: number;
}

/** Doubling backoff, capped. `0` is the unthrottled state a fresh entry is in. */
function nextRetryDelayMs(currentMs: number): number {
  if (currentMs <= 0) return IMAGE_PATH_RETRY_BASE_MS;
  return Math.min(currentMs * 2, IMAGE_PATH_RETRY_MAX_MS);
}

/**
 * Resolves the on-disk executable image basename for a given PID. The image
 * path is immune to `process.title` / `setproctitle` rewrites (an agent CLI
 * that renames itself to "Claude Code" still has `/opt/homebrew/bin/claude`
 * as its image), so it gives `ProcessDetector` a third identity signal that
 * survives the title-rewriting case the kernel `comm` and argv columns fail.
 *
 * Async-fill per PID so the synchronous `detectAgent()` contract stays
 * synchronous — the first call schedules an async resolution and returns
 * null; once a probe succeeds the basename is returned permanently, with
 * failed probes retried on a doubling backoff until one succeeds.
 * `evict()` drops exited PIDs so PID reuse cannot serve a stale
 * prior-process basename.
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
   * basename (lowercased, extension stripped), or null while the PID is
   * unresolved. Schedules an async refresh when the entry is missing, and
   * when a previous probe resolved nothing and its backoff has elapsed.
   * Eviction TTL: unreferenced entries drop after 30s.
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
        retryDelayMs: 0,
      };
      this.entries.set(pid, entry);
      this.scheduleRefresh(pid, entry);
      this.evictStale(now);
      return null;
    }

    // Read-time bookkeeping, kept independent of the retry gate: a read whose
    // retry is suppressed still counts as a reference, so a PID being polled
    // every 1.5s is never swept by the eviction TTL just because it is failing.
    entry.lastReadAt = now;

    // Once a probe has returned a non-null result for a PID we serve it
    // unconditionally: a process that has exec'd a different image is a
    // different program under the same number, and ProcessDetector evicts a
    // PID the moment it leaves probe range, so the entry cannot outlive the
    // process it describes. A null result is retried, but only once the
    // backoff earned by the previous failures has elapsed — `retryDelayMs` is
    // 0 on a fresh entry, so the first probe of a PID is never delayed.
    if (
      entry.basename === null &&
      !entry.refreshing &&
      now >= entry.updatedAt + entry.retryDelayMs
    ) {
      this.scheduleRefresh(pid, entry);
    }

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
    // Two-argument `then` rather than `.then().catch()`: `refresh()` already
    // swallows every resolver error into a null result, so the rejection arm
    // is only reachable if the probe itself breaks — and chaining a `.catch()`
    // after the fulfilment arm would also route a bug in `settle()` there.
    void this.refresh(pid).then(
      (basename) => this.settle(pid, checkId, basename),
      () => this.settle(pid, checkId, null)
    );
  }

  /**
   * Write one probe's outcome back into the cache and set the next retry gate.
   *
   * Both completion arms land here so the backoff cannot be advanced on one
   * path and skipped on the other. A null result is the ordinary failure
   * shape, not the exceptional one: every platform resolver catches its own
   * errors and returns null, and an empty `lsof`/CIM answer is null too.
   */
  private settle(pid: number, checkId: number, basename: string | null): void {
    if (this.disposed) return;
    const current = this.entries.get(pid);
    // Stale-write guard: another refresh may have superseded this one if
    // the entry was evicted and recreated in the meantime.
    if (!current || current.checkId !== checkId) return;
    current.basename = basename;
    current.updatedAt = Date.now();
    current.refreshing = false;
    current.retryDelayMs = basename === null ? nextRetryDelayMs(current.retryDelayMs) : 0;
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
    // getProcessIconMap() lookups.
    const stripped = lower.replace(/\.(exe|cmd|bat|com|ps1)$/u, "");
    return stripped || null;
  }
}
