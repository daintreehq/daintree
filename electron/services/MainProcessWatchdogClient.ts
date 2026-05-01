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

const PING_INTERVAL_MS = 5000;
const SERVICE_NAME = "daintree-watchdog";

// If the watchdog stays alive this long after a fork, treat it as stable and
// reset the restart counter. Without this reset, three transient crashes
// spread across a multi-hour session would permanently disable deadlock
// detection. Any duration well above the cap of cumulative backoff
// (≤30s for 3 attempts) is safe — we pick 30s for the symmetry.
const RESTART_COUNTER_RESET_MS = 30_000;

export interface MainProcessWatchdogClientConfig {
  /** Maximum restart attempts before giving up. After this, deadlock
   * detection is disabled until the next app launch. */
  maxRestartAttempts?: number;
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
  maxRestartAttempts: 3,
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
  private restartAttempts = 0;
  private isDisposed = false;
  private isPaused = false;

  constructor(config: MainProcessWatchdogClientConfig = {}) {
    this.config = {
      maxRestartAttempts: config.maxRestartAttempts ?? DEFAULT_CONFIG.maxRestartAttempts,
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

      console.warn(`[MainProcessWatchdogClient] Watchdog exited (code=${code})`);
      this.scheduleRestart();
    });

    // Reset the restart counter once this fork stays alive long enough to be
    // considered stable. Cumulative restart backoff for 3 attempts is well
    // under 30s, so 30s of uptime confirms we're past the recovery phase.
    if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = null;
      if (this.isDisposed) return;
      this.restartAttempts = 0;
    }, RESTART_COUNTER_RESET_MS);

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
    if (this.restartAttempts >= this.config.maxRestartAttempts) {
      console.error(
        `[MainProcessWatchdogClient] Max restart attempts (${this.config.maxRestartAttempts}) reached. Deadlock detection disabled until next launch.`
      );
      return;
    }

    this.restartAttempts += 1;
    // Full jitter with floor — same formula as PtyClient/WorkspaceClient:
    // `cap = min(1000 * 2^n, 10000)`, floor `100ms`. Jitter breaks
    // deterministic retry lockstep when paired with a sibling client that
    // crashed at the same instant; the floor stops fork-storms when the
    // watchdog binary itself is broken.
    const cap = Math.min(1000 * Math.pow(2, this.restartAttempts), 10000);
    const floor = 100;
    const delay = floor + Math.floor(Math.random() * Math.max(0, cap - floor));

    console.log(
      `[MainProcessWatchdogClient] Restarting watchdog in ${delay}ms (attempt ${this.restartAttempts}/${this.config.maxRestartAttempts})`
    );

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.isDisposed || this.child !== null) return;
      this.startHost();
    }, delay);
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
