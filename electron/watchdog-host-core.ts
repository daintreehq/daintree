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
}

export interface WatchdogMessage {
  type: "ping" | "sleep" | "wake" | "dispose";
}

export interface WatchdogState {
  isArmed: boolean;
  isPaused: boolean;
  missedBeats: number;
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
  const state: WatchdogState = {
    isArmed: false,
    isPaused: false,
    missedBeats: 0,
  };

  function tick(): void {
    if (!state.isArmed || state.isPaused) return;

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
