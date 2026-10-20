// eager-import-allow: reads/writes the watchdog heartbeat via sync fs in the host process
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

// 24 misses × 5s = ~120s once there is evidence of memory pressure (#13528).
// A main stalled on page-ins recovers by itself, while a kill takes the
// pty-host and every running agent down with it, so the deadline stretches —
// but stays bounded, so a real deadlock under pressure is still caught.
// Counted in beats rather than elapsed time: Node folds the intervals a
// starved watchdog missed into one callback, so a stall that also freezes the
// watchdog stretches the deadline instead of firing it on the first tick the
// watchdog gets, before it has read the pings queued behind its own stall.
export const MAX_MISSED_UNDER_PRESSURE = 24;

// A tick this long after the previous one means the watchdog itself could not
// run for a full interval: the machine stalled, not just main.
export const LATE_TICK_GAP_MS = HEARTBEAT_INTERVAL_MS * 2;

// How long a late tick counts as evidence of a machine-wide stall. Long enough
// to still hold when a silence that begins just after it reaches MAX_MISSED.
export const STALL_EVIDENCE_MS = 30_000;

// Below this share of memory available to it, the watchdog's own read counts
// as pressure (#13636). It covers pressure that builds after main's last
// sample, while main is too stalled to say so.
export const LOW_AVAILABLE_MEMORY_RATIO = 0.05;

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
  /** The share of memory available to the watchdog, read at the moment a
   * silence reaches MAX_MISSED. Null or absent when no trustworthy reading
   * exists: on macOS the free count leaves out cached pages and reads low on
   * a healthy machine. Must not spawn — it runs on the kill decision path. */
  readAvailableMemoryRatio?: () => number | null;
}

export interface WatchdogMessage {
  type: "ping" | "sleep" | "wake" | "dispose";
  /** On a ping, main's latest memory-pressure reading: true when elevated,
   * false when clear, null when main has no fresh reading (boot, E2E, failed
   * probes). Null earns the longer deadline too: a main that cannot see the
   * machine is given the benefit of the doubt. Absent or malformed reads as
   * clear. */
  memoryPressure?: boolean | null;
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
  /** The last ping's `memoryPressure`, normalised to true, false or null. It
   * stands through the silence that follows: main's last word before it
   * stalled. */
  mainPressure: boolean | null;
  /** Monotonic timestamp of the last armed tick that arrived late, or null. */
  lastLateTickAt: number | null;
  /** Monotonic timestamp of the last ping that arrived a full beat late, or
   * null. A main whose pings slow down before it goes quiet is struggling, as
   * it does under page-in thrash, rather than wedged (#13636). */
  lastLatePingAt: number | null;
  /** The current silence reached MAX_MISSED with pressure evidence, so the
   * kill waits for MAX_MISSED_UNDER_PRESSURE. Latched until main is heard
   * from again, so evidence ageing out mid-stall can't pull the deadline in. */
  killDeferred: boolean;
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
    mainPressure: false,
    lastLateTickAt: null,
    lastLatePingAt: null,
    killDeferred: false,
  };
  // The runtime starts its interval as it creates the watchdog. Updated on
  // every tick, armed or not, so the first tick after a pause isn't read as
  // the watchdog itself having stalled.
  let lastTickAt = now();
  let killHeld = false;
  // Null whenever the gap to the next ping would span a disarmed or suspended
  // stretch, which says nothing about how main is keeping up.
  let lastPingAt: number | null = null;

  function lowAvailableMemory(): string | null {
    if (!deps.readAvailableMemoryRatio) return null;
    let ratio: number | null;
    try {
      ratio = deps.readAvailableMemoryRatio();
    } catch {
      return null;
    }
    if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0) return null;
    if (ratio >= LOW_AVAILABLE_MEMORY_RATIO) return null;
    return `only ${(ratio * 100).toFixed(1)}% of memory is available`;
  }

  function pressureEvidence(t: number): string | null {
    if (state.mainPressure === true) return "main reported memory pressure";
    if (state.mainPressure === null) return "main had no memory-pressure reading";
    if (state.lastLateTickAt !== null && t - state.lastLateTickAt <= STALL_EVIDENCE_MS) {
      return "the watchdog itself stalled";
    }
    if (state.lastLatePingAt !== null && t - state.lastLatePingAt <= STALL_EVIDENCE_MS) {
      return "main's pings were already arriving late";
    }
    return lowAvailableMemory();
  }

  function tick(): void {
    const t = now();
    const gapMs = t - lastTickAt;
    lastTickAt = t;
    if (!state.isArmed || state.isPaused) return;

    // Suppress ticks that were queued during sleep and burst-fire on wake.
    // macOS and Windows both deliver suspended `setInterval` callbacks as a
    // packed sequence at resume, which would each increment `missedBeats`
    // before the post-wake arming ping has a chance to reset it. The grace
    // is exactly one heartbeat interval — long enough to absorb the burst,
    // short enough to never mask a real deadlock on the awake system.
    if (state.lastWakeTimestamp > 0 && t - state.lastWakeTimestamp < HEARTBEAT_INTERVAL_MS) {
      return;
    }

    const late = gapMs >= LATE_TICK_GAP_MS;
    if (late) state.lastLateTickAt = t;

    state.missedBeats += 1;
    if (state.missedBeats < MAX_MISSED) return;

    if (!state.killDeferred) {
      const evidence = pressureEvidence(t);
      if (evidence !== null) {
        state.killDeferred = true;
        log(
          `[WatchdogHost] Main process unresponsive for ${state.missedBeats} missed beats, but ${evidence}. Deferring kill until ${MAX_MISSED_UNDER_PRESSURE} missed beats.`
        );
      }
    }
    if (state.killDeferred && state.missedBeats < MAX_MISSED_UNDER_PRESSURE) return;
    // A late tick can run before the pings queued behind the watchdog's own
    // stall have been read, so it never fires the kill itself: the next tick
    // does if main is still silent. One beat of slack, never more.
    if (late && !killHeld) {
      killHeld = true;
      return;
    }

    log(
      `[WatchdogHost] Main process unresponsive for at least ${state.missedBeats * HEARTBEAT_INTERVAL_MS}ms (${state.missedBeats} missed beats). Firing kill.`
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
    state.killDeferred = false;
    killHeld = false;
    state.isArmed = false;
    lastPingAt = null;
    state.lastLatePingAt = null;
  }

  function handleMessage(msg: WatchdogMessage | null | undefined): boolean {
    if (!msg || typeof msg.type !== "string") return false;
    switch (msg.type) {
      case "ping": {
        const t = now();
        if (lastPingAt !== null && t - lastPingAt >= LATE_TICK_GAP_MS) state.lastLatePingAt = t;
        lastPingAt = state.isPaused ? null : t;
        if (state.killDeferred) {
          log(
            `[WatchdogHost] Main process responded after ${state.missedBeats} missed beats; deferred kill cancelled.`
          );
        }
        state.isArmed = true;
        state.missedBeats = 0;
        state.killDeferred = false;
        killHeld = false;
        state.mainPressure =
          msg.memoryPressure === true ? true : msg.memoryPressure === null ? null : false;
        return true;
      }
      case "sleep":
        state.isPaused = true;
        lastPingAt = null;
        state.missedBeats = 0;
        state.killDeferred = false;
        killHeld = false;
        return true;
      case "wake":
        state.isPaused = false;
        state.missedBeats = 0;
        state.killDeferred = false;
        killHeld = false;
        state.lastWakeTimestamp = now();
        // Neither the suspend gap nor a stall seen before it says anything
        // about the machine now.
        lastTickAt = state.lastWakeTimestamp;
        state.lastLateTickAt = null;
        state.lastLatePingAt = null;
        lastPingAt = null;
        return true;
      case "dispose":
        state.isArmed = false;
        lastPingAt = null;
        return true;
      default:
        return false;
    }
  }

  function disarm(): void {
    state.isArmed = false;
    lastPingAt = null;
  }

  return { state, tick, handleMessage, disarm };
}

/** The share of memory available, for {@link WatchdogDeps.readAvailableMemoryRatio}.
 * A positive constraint (a cgroup or job limit) caps the total, but never
 * beyond physical memory: libuv may report "unlimited" as a huge figure. */
export function availableMemoryRatio(
  availableBytes: number,
  totalBytes: number,
  constrainedBytes: number
): number | null {
  const total = constrainedBytes > 0 ? Math.min(totalBytes, constrainedBytes) : totalBytes;
  if (!(total > 0) || !Number.isFinite(availableBytes)) return null;
  return availableBytes / total;
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
