/**
 * Main-side manager for the external watchdog UtilityProcess.
 *
 * Forks `watchdog-host-bootstrap.js` with this process's PID, sends a "ping"
 * every PING_INTERVAL_MS, and restarts the watchdog with exponential backoff
 * if it crashes. Sleep/wake handling routes "sleep"/"wake" messages through
 * to the subprocess and stops/restarts the ping interval — both paths
 * (interval-stop and explicit "sleep") so the watchdog can't fire during
 * suspend even if a transient race delivers them out of order.
 *
 * This client never kills main itself. The kill authority lives entirely in
 * the watchdog subprocess; if the watchdog crashes, deadlock detection is
 * temporarily inactive but main is unharmed (fail-open).
 */

import { app, utilityProcess, type UtilityProcess } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { trackEvent } from "./TelemetryService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PING_INTERVAL_MS = 5000;
const SERVICE_NAME = "daintree-watchdog";

// Time-windowed crash-loop guard. Mirrors the constants in `PtyHostLifecycle`
// and `CrashLoopGuardService` so the watchdog follows the same policy as the
// rest of the app: three crashes within five minutes trip the cap, and a
// five-minute stretch of clean running decays the window back to empty.
// Replaces the prior 30s uptime-reset counter — that pattern was provably
// broken for slow crash loops (e.g. crash every 35s defeated the cap forever),
// allowing the watchdog to burn CPU indefinitely.
const CRASH_THRESHOLD = 3;
const RAPID_CRASH_WINDOW_MS = 300_000;
const STABILITY_TIMEOUT_MS = 300_000;

// Full-jitter backoff parameters, intentionally separated from
// `PtyHostLifecycle` (floor=100, base=1000, cap=10000) to avoid correlated
// restart collisions when the watchdog and pty-host crash from a shared
// trigger (OOM, signal, system event). With distinct floor/cap ranges the
// two services land in different parts of the jitter distribution, dropping
// the collision rate from ~28% to <5% per attempt.
const RESTART_FLOOR_MS = 250;
const RESTART_CAP_BASE_MS = 1_500;
const RESTART_CAP_MAX_MS = 5_000;

export interface WatchdogDisabledPayload {
  /** Number of restart attempts that completed before the cap kicked in. */
  attemptCount: number;
  /** Exit code from the final crash, when one was reported. */
  lastExitCode: number | null;
  /** Wall-clock ms when the cap was hit. */
  timestamp: number;
}

export type WatchdogDisabledListener = (payload: WatchdogDisabledPayload) => void;

export interface MainProcessWatchdogClientConfig {
  /** Test seam: override `process.pid` with a deterministic value. */
  mainPid?: number;
  /** Test seam: override the resolved bootstrap path. */
  hostPathOverride?: string;
  /** Test seam: skip the actual `utilityProcess.fork()`. Used by unit tests
   * that want to assert configuration without spinning up a child. */
  startImmediately?: boolean;
}

const DEFAULT_CONFIG: Required<
  Omit<MainProcessWatchdogClientConfig, "mainPid" | "hostPathOverride">
> = {
  startImmediately: true,
};

export class MainProcessWatchdogClient {
  private child: UtilityProcess | null = null;
  private config: Required<Omit<MainProcessWatchdogClientConfig, "mainPid" | "hostPathOverride">>;
  private mainPid: number;
  private hostPathOverride: string | undefined;

  private pingInterval: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private stabilityTimer: NodeJS.Timeout | null = null;
  /** Sliding window of recent crash timestamps. Trimmed to entries within
   * `RAPID_CRASH_WINDOW_MS` on each crash; cleared only by the stability
   * timer after a clean `STABILITY_TIMEOUT_MS` stretch. Not cleared on
   * successful fork — that would defeat the window for fast
   * crash→fork→crash loops. */
  private crashTimestamps: number[] = [];
  private isDisposed = false;
  private isPaused = false;
  private lastExitCode: number | null = null;
  private disabledListener: WatchdogDisabledListener | null = null;
  private disabledNotified = false;

  constructor(config: MainProcessWatchdogClientConfig = {}) {
    this.config = {
      startImmediately: config.startImmediately ?? DEFAULT_CONFIG.startImmediately,
    };
    this.mainPid = config.mainPid ?? process.pid;
    this.hostPathOverride = config.hostPathOverride;

    if (this.config.startImmediately) {
      this.startHost();
    }
  }

  private resolveHostPath(): string {
    if (this.hostPathOverride) return this.hostPathOverride;
    // esbuild emits this file under dist-electron/electron/. When running
    // from the chunked production bundle, __dirname is …/chunks; the host
    // bootstrap sits one level up, so normalise both layouts.
    const electronDir = path.basename(__dirname) === "chunks" ? path.dirname(__dirname) : __dirname;
    return path.join(electronDir, "watchdog-host-bootstrap.js");
  }

  private startHost(): void {
    if (this.isDisposed) return;
    if (this.child) return;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    const hostPath = this.resolveHostPath();
    console.log(`[MainProcessWatchdogClient] Starting watchdog from: ${hostPath}`);

    try {
      this.child = utilityProcess.fork(hostPath, [`--main-pid=${this.mainPid}`], {
        serviceName: SERVICE_NAME,
        stdio: "pipe",
        // Redirect v8.setHeapSnapshotNearHeapLimit dumps and suppress env
        // from diagnostic reports (crash dumps, process.report).
        execArgv: [
          "--max-old-space-size=128",
          `--diagnostic-dir=${app.getPath("logs")}`,
          "--report-exclude-env",
        ],
        env: {
          ...(process.env as Record<string, string>),
          DAINTREE_USER_DATA: app.getPath("userData"),
          DAINTREE_UTILITY_PROCESS_KIND: "watchdog-host",
        },
      });
    } catch (error) {
      console.error("[MainProcessWatchdogClient] Failed to fork watchdog:", error);
      this.scheduleRestart();
      return;
    }

    // Forward stdout/stderr for diagnosis — the watchdog logs are tiny so
    // there's no concern about flooding the main process.
    this.child.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(`[watchdog] ${chunk.toString()}`);
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[watchdog] ${chunk.toString()}`);
    });

    this.child.on("exit", (code) => {
      const wasDisposed = this.isDisposed;
      this.child = null;
      this.stopPingInterval();
      // Cancel any pending stability timer — the new fork must accumulate
      // its own grace period from scratch.
      if (this.stabilityTimer) {
        clearTimeout(this.stabilityTimer);
        this.stabilityTimer = null;
      }

      if (wasDisposed) return;

      this.lastExitCode = code ?? null;
      console.warn(`[MainProcessWatchdogClient] Watchdog exited (code=${code})`);
      this.scheduleRestart();
    });

    // Start the stability timer. When it fires after STABILITY_TIMEOUT_MS of
    // clean running, the crash window is cleared. We do NOT clear
    // `crashTimestamps` on fork success — clearing on "fork OK" would defeat
    // the window for fast crash→fork→crash loops where each new fork briefly
    // appears healthy before crashing again.
    this.startStabilityTimer();

    // Immediately send the first ping so the watchdog arms (it stays inert
    // until `isArmed = true` to prevent killing a slow-booting main).
    this.sendPing();

    if (this.isPaused) {
      // The watchdog crashed-and-restarted while we're suspended. Without
      // this, the new subprocess would be armed (by the ping above) and
      // its tick interval would accumulate missed beats during sleep,
      // leading to a false-positive SIGKILL on wake. Send "sleep" right
      // after the arming ping to suppress the kill path.
      try {
        this.child.postMessage({ type: "sleep" });
      } catch {
        // Channel down — exit handler will reschedule another restart.
      }
    } else {
      this.startPingInterval();
    }
  }

  private scheduleRestart(): void {
    if (this.isDisposed) return;

    // Time-windowed sliding crash counter. Trim entries older than the
    // window, then append the current crash. `crashTimestamps.length` is
    // the post-append attempt number used both for the cap check and as
    // the exponent in the jitter cap calculation.
    const crashAt = Date.now();
    this.crashTimestamps = this.crashTimestamps.filter((t) => crashAt - t < RAPID_CRASH_WINDOW_MS);
    this.crashTimestamps.push(crashAt);

    if (this.crashTimestamps.length >= CRASH_THRESHOLD) {
      console.error(
        `[MainProcessWatchdogClient] Max restart attempts reached (${CRASH_THRESHOLD} crashes in ${RAPID_CRASH_WINDOW_MS}ms), giving up. Deadlock detection disabled until next launch.`
      );
      this.notifyDisabled();
      return;
    }

    // Full jitter with floor, parameterised distinctly from PtyHostLifecycle
    // so the two services don't synchronise their restarts under a shared
    // crash trigger. `windowAttempt` is the post-append count, so the first
    // restart uses N=1 (cap = base*2 = 3000).
    const windowAttempt = this.crashTimestamps.length;
    const cap = Math.min(RESTART_CAP_BASE_MS * Math.pow(2, windowAttempt), RESTART_CAP_MAX_MS);
    const delay =
      RESTART_FLOOR_MS + Math.floor(Math.random() * Math.max(0, cap - RESTART_FLOOR_MS));

    console.log(
      `[MainProcessWatchdogClient] Restarting watchdog in ${delay}ms (${windowAttempt}/${CRASH_THRESHOLD} crashes in window)`
    );

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.isDisposed || this.child !== null) return;
      this.startHost();
    }, delay);
    this.restartTimer.unref?.();
  }

  /** Start (or restart) the stability timer. When it fires after
   * `STABILITY_TIMEOUT_MS` of clean running, the crash window is cleared so
   * subsequent crashes start fresh. Unref'd so the timer never pins the
   * Electron event loop alive after `app.quit`. */
  private startStabilityTimer(): void {
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
    }
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = null;
      if (this.isDisposed) return;
      this.crashTimestamps = [];
    }, STABILITY_TIMEOUT_MS);
    this.stabilityTimer.unref?.();
  }

  private startPingInterval(): void {
    if (this.pingInterval) return;
    this.pingInterval = setInterval(() => {
      this.sendPing();
    }, PING_INTERVAL_MS);
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private sendPing(): void {
    if (!this.child) return;
    try {
      this.child.postMessage({ type: "ping" });
    } catch (err) {
      // postMessage can throw if the child is between exit and our exit
      // handler (the channel is already torn down). Drop silently — the
      // exit handler will reschedule a restart.
      console.warn("[MainProcessWatchdogClient] ping postMessage failed:", err);
    }
  }

  /** Pause the watchdog during system sleep. Stops the ping interval and
   * sends an explicit "sleep" message so the subprocess won't accumulate
   * missed beats during suspend. Called from setupPowerMonitor. */
  pause(): void {
    if (this.isPaused) return;
    this.isPaused = true;
    this.stopPingInterval();
    if (this.child) {
      try {
        this.child.postMessage({ type: "sleep" });
      } catch {
        // Channel down — the watchdog's interval is unref'd, so it'll
        // exit naturally if main has already gone.
      }
    }
  }

  /** Resume the watchdog after system wake. Sends "wake" to clear the
   * subprocess's missed counter, then restarts the ping interval. */
  resume(): void {
    if (!this.isPaused) return;
    this.isPaused = false;
    if (this.child) {
      try {
        this.child.postMessage({ type: "wake" });
      } catch {
        // Same justification as pause().
      }
      // Send an immediate ping so the subprocess resets `missedBeats=0` and
      // re-arms before the first interval tick lands.
      this.sendPing();
      this.startPingInterval();
    }
    // If the child is null (crashed during sleep), scheduleRestart from the
    // exit handler will resurrect it; we'll re-arm via the immediate ping
    // in startHost().
  }

  /** Register a listener fired exactly once when the watchdog hits its
   * restart cap and deadlock detection becomes inactive for the session.
   * Replaces any previous listener; pass `null` to detach. The listener
   * fires every cap-hit cycle but at most once per cycle — a successful
   * `restart()` re-arms it for the next cycle.
   */
  onDisabled(listener: WatchdogDisabledListener | null): void {
    this.disabledListener = listener;
  }

  private notifyDisabled(): void {
    if (this.disabledNotified) return;
    this.disabledNotified = true;
    const payload: WatchdogDisabledPayload = {
      attemptCount: this.crashTimestamps.length,
      lastExitCode: this.lastExitCode,
      timestamp: Date.now(),
    };
    try {
      trackEvent("watchdog_disabled", { ...payload });
    } catch (err) {
      console.warn("[MainProcessWatchdogClient] trackEvent failed:", err);
    }
    if (this.disabledListener) {
      try {
        this.disabledListener(payload);
      } catch (err) {
        console.warn("[MainProcessWatchdogClient] onDisabled listener threw:", err);
      }
    }
  }

  /** Reset the sliding crash window and fork a fresh watchdog. Called from
   * the IPC restart handler after the renderer's recovery banner is dismissed.
   * Idempotent if the watchdog is already running. */
  restart(): void {
    if (this.isDisposed) return;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
    this.crashTimestamps = [];
    this.lastExitCode = null;
    this.disabledNotified = false;
    if (this.child) {
      // Already running — the window is reset; nothing further to do.
      return;
    }
    this.startHost();
  }

  /**
   * E2E seam: fire the disabled-notification path (telemetry + the `onDisabled`
   * listener that broadcasts `watchdog:disabled`) without driving three real
   * crashes. Respects the once-per-cycle `disabledNotified` guard exactly like
   * the production cap-hit path, so a subsequent `restart()` re-arms it. Gated
   * to `DAINTREE_E2E_FAULT_MODE` at the call site; never invoked in production.
   */
  _emitDisabledForTesting(): void {
    this.notifyDisabled();
  }

  /** Stop the watchdog cleanly. Idempotent. */
  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    this.stopPingInterval();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }

    if (this.child) {
      try {
        this.child.postMessage({ type: "dispose" });
      } catch {
        // Channel may already be closed; falling through to kill().
      }
      try {
        this.child.kill();
      } catch {
        // Child may have exited between postMessage and kill — that's fine.
      }
      this.child = null;
    }
  }

  /** Test/diagnostic accessor. */
  isRunning(): boolean {
    return this.child !== null && !this.isDisposed;
  }
}

let instance: MainProcessWatchdogClient | null = null;

export function getMainProcessWatchdogClient(
  config?: MainProcessWatchdogClientConfig
): MainProcessWatchdogClient {
  if (!instance) {
    instance = new MainProcessWatchdogClient(config);
  }
  return instance;
}

export function disposeMainProcessWatchdog(): void {
  if (instance) {
    instance.dispose();
    instance = null;
  }
}
