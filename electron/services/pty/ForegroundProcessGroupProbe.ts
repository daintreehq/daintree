import { execFile } from "child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Soft-stale: trigger an async background refresh once the cached snapshot is
// older than this. Hard-max: callers receive null past this age and fall back
// to the legacy prompt path.
const FOREGROUND_SNAPSHOT_SOFT_STALE_MS = 500;
const FOREGROUND_SNAPSHOT_MAX_AGE_MS = 1500;
const FOREGROUND_SNAPSHOT_PROBE_TIMEOUT_MS = 750;

// Sentinel returned on POSIX before the first probe resolves. Returning null
// during the warm-up window would drop into the IdentityWatcher's
// "Windows / unsupported" fallback branch and falsely mark the shell idle for
// demotion. Any value where shellPgid !== foregroundPgid (and both > 0) keeps
// the demotion gate closed; the real probe overwrites this within a few ms.
const INITIAL_FOREGROUND_SENTINEL = Object.freeze({
  shellPgid: 1,
  foregroundPgid: 2,
});

export interface ForegroundSnapshot {
  shellPgid: number;
  foregroundPgid: number;
}

export interface ForegroundProcessGroupProbeHost {
  readonly ptyPid: number | undefined;
  readonly disposed: boolean;
}

/**
 * Stale-while-revalidate cache around a `ps -o pgid=,tpgid=` probe used by
 * the IdentityWatcher to decide whether the shell's foreground group has
 * changed. Probe runs asynchronously so the poll tick never blocks the
 * pty-host event loop.
 */
export class ForegroundProcessGroupProbe {
  private snapshot: ForegroundSnapshot | null = null;
  private updatedAt = 0;
  private refreshing = false;
  private checkId = 0;

  constructor(private readonly host: ForegroundProcessGroupProbeHost) {}

  /**
   * Sync read against the cache. Soft-stale schedules a background refresh;
   * past the hard-max age we return null so callers fall back to the legacy
   * prompt path (matches the pre-existing non-POSIX behavior).
   */
  readSnapshot(): ForegroundSnapshot | null {
    if (process.platform === "win32") {
      return null;
    }

    const ptyPid = this.host.ptyPid;
    if (ptyPid === undefined) {
      return null;
    }

    const hasEverProbed = this.updatedAt > 0;
    const age = hasEverProbed ? Date.now() - this.updatedAt : 0;

    if (!this.refreshing && (!hasEverProbed || age > FOREGROUND_SNAPSHOT_SOFT_STALE_MS)) {
      void this.refresh(ptyPid);
    }

    // Probe pending: keep the demotion gate closed (see sentinel comment).
    if (!hasEverProbed) {
      return INITIAL_FOREGROUND_SENTINEL;
    }

    if (age > FOREGROUND_SNAPSHOT_MAX_AGE_MS) {
      return null;
    }
    return this.snapshot;
  }

  private async refresh(ptyPid: number): Promise<void> {
    this.refreshing = true;
    const checkId = ++this.checkId;
    let nextSnapshot: ForegroundSnapshot | null = null;
    try {
      const { stdout } = await execFileAsync("ps", ["-o", "pgid=,tpgid=", "-p", String(ptyPid)], {
        encoding: "utf8",
        shell: false,
        signal: AbortSignal.timeout(FOREGROUND_SNAPSHOT_PROBE_TIMEOUT_MS),
      });
      const [pgidText, tpgidText] = stdout.trim().split(/\s+/);
      const shellPgid = Number.parseInt(pgidText ?? "", 10);
      const foregroundPgid = Number.parseInt(tpgidText ?? "", 10);
      if (Number.isFinite(shellPgid) && Number.isFinite(foregroundPgid)) {
        nextSnapshot = { shellPgid, foregroundPgid };
      }
    } catch {
      // ps -p races (process exited) and aborts both surface here. Persisting
      // null with a fresh timestamp prevents tight-retry and lets the caller
      // fall back to the legacy prompt path until the next refresh window.
      nextSnapshot = null;
    } finally {
      // Disposed-instance guard: never write back to a torn-down terminal.
      // Stale-write guard via monotonic checkId is belt-and-suspenders given
      // the in-flight boolean, but cheap and matches the repo's checkId
      // pattern (see CliAvailabilityService).
      if (!this.host.disposed && checkId === this.checkId) {
        this.snapshot = nextSnapshot;
        this.updatedAt = Date.now();
      }
      this.refreshing = false;
    }
  }
}
