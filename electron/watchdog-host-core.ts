/**
 * Pure watchdog logic, extracted for testability. The runtime entry point
 * (watchdog-host.ts) is a thin wrapper that injects the real ping/timer/
 * kill primitives.
 */

export const HEARTBEAT_INTERVAL_MS = 5000;

// 3 misses × 5s = ~15s of unresponsiveness before kill. Conservative floor:
// V8 major GC and synchronous better-sqlite3 ops can pause main for several
// seconds, so anything under ~10s risks false positives.
export const MAX_MISSED = 3;

export interface WatchdogDeps {
  /** Send SIGKILL (or equivalent) to the main process. The watchdog never
   * calls this directly — it's injected so tests can observe and so the
   * runtime can layer in a PID-validity check before firing. */
  killMain: () => void;
  /** Optional log sink. Defaults to console.error in the runtime entry. */
  logError?: (msg: string) => void;
  /** Monotonic clock seam. Defaults to `performance.now`. Used to detect
   * stale ticks that were queued before a "wake" message landed: when the
   * OS schedules `setInterval` callbacks during sleep, they fire as a
   * burst at wake — without a monotonic check, those queued ticks would
   * each increment `missedBeats` and cross the kill threshold before the
   * arming ping has a chance to reset the counter. `performance.now` is
   * required (not `Date.now`) because it's immune to wall-clock jumps
   * from NTP adjustments and user time changes. */
  now?: () => number;
}

export interface WatchdogMessage {
  type: "ping" | "sleep" | "wake" | "dispose";
}

export interface WatchdogState {
  isArmed: boolean;
  isPaused: boolean;
  missedBeats: number;
  /** Monotonic timestamp of the most recent "wake" message, used by `tick`
   * to suppress queued-during-sleep ticks that fire as a burst at wake.
   * Zero means "no wake observed yet" — the grace window only applies
   * after a real wake event, so it never masks a frozen-at-boot main. */
  lastWakeTimestamp: number;
}

export interface Watchdog {
  readonly state: Readonly<WatchdogState>;
  /** Advance one heartbeat interval. Increments the missed counter and
   * fires kill when the threshold is crossed. No-op if not armed or paused. */
  tick(): void;
  /** Apply an inbound message from main. Returns true if the message was
   * recognised and applied, false otherwise. */
  handleMessage(msg: WatchdogMessage | null | undefined): boolean;
  /** Force-disarm the watchdog. Used during dispose so an in-flight tick
   * can't fire after the interval has been cleared. */
  disarm(): void;
}

export function createWatchdog(deps: WatchdogDeps): Watchdog {
  const log = deps.logError ?? ((msg) => console.error(msg));
  const now = deps.now ?? (() => performance.now());
  const state: WatchdogState = {
    isArmed: false,
    isPaused: false,
    missedBeats: 0,
    lastWakeTimestamp: 0,
  };

  function tick(): void {
    if (!state.isArmed || state.isPaused) return;

    // Suppress ticks that were queued during sleep and burst-fire on wake.
    // macOS and Windows both deliver suspended `setInterval` callbacks as a
    // packed sequence at resume, which would each increment `missedBeats`
    // before the post-wake arming ping has a chance to reset it. The grace
    // is exactly one heartbeat interval — long enough to absorb the burst,
    // short enough to never mask a real deadlock on the awake system.
    if (state.lastWakeTimestamp > 0 && now() - state.lastWakeTimestamp < HEARTBEAT_INTERVAL_MS) {
      return;
    }

    state.missedBeats += 1;

    if (state.missedBeats >= MAX_MISSED) {
      log(
        `[WatchdogHost] Main process unresponsive for ${state.missedBeats * HEARTBEAT_INTERVAL_MS}ms (${state.missedBeats} missed beats). Firing kill.`
      );
      try {
        deps.killMain();
      } catch (err) {
        log(`[WatchdogHost] killMain threw: ${String(err)}`);
      }
      // Disarm so the next tick can't re-fire before main's relaunch sends
      // its first ping. CrashRecoveryService will respawn main; it must
      // explicitly re-arm us by sending a ping.
      state.missedBeats = 0;
      state.isArmed = false;
    }
  }

  function handleMessage(msg: WatchdogMessage | null | undefined): boolean {
    if (!msg || typeof msg.type !== "string") return false;
    switch (msg.type) {
      case "ping":
        state.isArmed = true;
        state.missedBeats = 0;
        return true;
      case "sleep":
        state.isPaused = true;
        state.missedBeats = 0;
        return true;
      case "wake":
        state.isPaused = false;
        state.missedBeats = 0;
        state.lastWakeTimestamp = now();
        return true;
      case "dispose":
        state.isArmed = false;
        return true;
      default:
        return false;
    }
  }

  function disarm(): void {
    state.isArmed = false;
  }

  return { state, tick, handleMessage, disarm };
}

/** Name of the sidecar flag file the watchdog writes synchronously before
 * SIGKILL. CrashRecoveryService reads + unlinks it on next launch to
 * attribute the crash as a deadlock kill rather than "unknown". */
export const WATCHDOG_KILL_FLAG_NAME = "watchdog-kill.flag";

export interface WatchdogKillPayload {
  killedAt: number;
  missedBeats: number;
  mainPid: number;
}

/** Pure builder for the flag-file payload. Extracted from watchdog-host.ts so
 * the JSON shape can be tested without touching disk or the UtilityProcess
 * runtime. The host wraps this in a try/catch synchronous write so the
 * fail-open guarantee on the SIGKILL path is preserved. */
export function buildWatchdogKillPayload(
  missedBeats: number,
  mainPid: number
): WatchdogKillPayload {
  return { killedAt: Date.now(), missedBeats, mainPid };
}

export interface WriteWatchdogKillFlagDeps {
  /** Synchronous write. Defaults are injected by the host; tests inject
   * a stub (including throw-cases) to verify fail-open behaviour. */
  writeFileSync: (path: string, data: string) => void;
  /** Path join shim — only needed so tests don't pull in node:path. */
  joinPath: (userData: string, name: string) => string;
}

/** Write the sidecar flag the next-launch crash recovery reads to attribute
 * SIGKILL-by-watchdog. Fail-open: any error is swallowed silently so the
 * SIGKILL path is never delayed or aborted by a disk failure.
 *
 * Returns true on success, false on any failure (missing userData, write
 * failure). Callers MUST treat the return value as advisory only — the
 * SIGKILL must fire regardless.
 */
export function writeWatchdogKillFlag(
  userData: string | null,
  missedBeats: number,
  mainPid: number,
  deps: WriteWatchdogKillFlagDeps
): boolean {
  if (!userData) return false;
  try {
    const flagPath = deps.joinPath(userData, WATCHDOG_KILL_FLAG_NAME);
    const payload = buildWatchdogKillPayload(missedBeats, mainPid);
    deps.writeFileSync(flagPath, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/** Parse the `--main-pid=<pid>` flag out of argv. Returns null if missing
 * or malformed — Chromium injects positional arguments into `process.argv`,
 * so the named flag is the only reliable transport. Strict parsing: rejects
 * partial-numeric strings like "123abc" (which `parseInt` would silently
 * truncate to 123). The PID we send SIGKILL to must be exactly the PID main
 * intended us to watch. */
export function parseMainPid(argv: readonly string[]): number | null {
  const arg = argv.find((a) => a.startsWith("--main-pid="));
  if (!arg) return null;
  const raw = arg.slice("--main-pid=".length);
  if (!/^\d+$/.test(raw)) return null;
  const pid = Number(raw);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}
