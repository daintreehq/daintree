/**
 * PtyHostLifecycle - Owns the UtilityProcess fork/exit/restart loop for the PTY host.
 *
 * Encapsulates everything tied to a single host run: the `child` reference,
 * the `child-process-gone` deferred-classification race (Electron 37-41), the
 * full-jitter restart backoff, stdout/stderr log forwarding, and the
 * `readyPromise` lifecycle. PtyClient holds business state (broker, pending
 * spawns, watchdog) and reaches into the lifecycle through callbacks.
 *
 * Why this exists:
 *   - The exit handler ran ~70 lines of intertwined concerns inside PtyClient,
 *     mixing setImmediate deferral, restart scheduling, broker teardown, and
 *     orphan cleanup. Splitting the host-managing parts here keeps PtyClient
 *     focused on transport/correlation while still letting the existing
 *     adversarial/handshake/watchdog tests poke `child` for race simulation.
 *   - The `readyPromise` reassignment on each restart is a subtle invariant —
 *     having it owned here next to the resolve/reject pair removes a class of
 *     "wrong promise resolved" bugs.
 *
 * Behavior preserved:
 *   - `pendingChildProcessGoneReason` is consumed via `setImmediate` to bridge
 *     the Electron 37-41 race where `exit` often fires before
 *     `child-process-gone`.
 *   - On Windows, the `child-process-gone` exitCode is preferred over the
 *     `exit` event's code (Electron 40-41 has a known signed/unsigned mangling
 *     bug on the `exit` path).
 *   - Restart attempts use full jitter with a 100ms floor and a cap of
 *     `min(2^N * 1000ms, 10000ms)` per attempt N.
 *   - If `manualRestart()` already spawned a host during the setImmediate
 *     window, the deferred restart no-ops to avoid orphaning.
 */

import { app, utilityProcess, type UtilityProcess } from "electron";
import os from "os";
import path from "path";
import type {
  CrashType,
  HostCrashPayload,
  PtyHostEvent,
  PtyHostRequest,
} from "../../../shared/types/pty-host.js";

/**
 * Map an authoritative `child-process-gone` reason (Electron 37+) to our CrashType.
 * Used when `app.on("child-process-gone")` fires for the PTY host — the reason
 * string is more reliable than the exit-code heuristic in `classifyCrash()`.
 */
export function mapGoneReasonToCrashType(reason: string): CrashType {
  switch (reason) {
    case "oom":
    case "memory-eviction":
      return "OUT_OF_MEMORY";
    case "killed":
      return "SIGNAL_TERMINATED";
    case "clean-exit":
      return "CLEAN_EXIT";
    case "crashed":
    case "abnormal-exit":
    case "launch-failed":
    case "integrity-failure":
    default:
      return "UNKNOWN_CRASH";
  }
}

/**
 * Classify crash type based on exit code and signal.
 * Exit codes 137 (128+9=SIGKILL) and 134 (128+6=SIGABRT) often indicate OOM.
 */
export function classifyCrash(code: number | null, signal: string | null): CrashType {
  if (code === null) {
    return "SIGNAL_TERMINATED";
  }
  if (code === 0) {
    return "CLEAN_EXIT";
  }
  if (code === 137 || signal === "SIGKILL") {
    return "OUT_OF_MEMORY";
  }
  if (code === 134 || signal === "SIGABRT") {
    return "ASSERTION_FAILURE";
  }
  if (code > 128) {
    return "SIGNAL_TERMINATED";
  }
  if (code !== 0) {
    return "UNKNOWN_CRASH";
  }
  return "CLEAN_EXIT";
}

const HOST_LOG_BUFFER_LIMIT = 64 * 1024;
const HOST_LOG_LINE_LIMIT = 4_000;
const RESTART_FLOOR_MS = 100;
const RESTART_CAP_BASE_MS = 1_000;
const RESTART_CAP_MAX_MS = 10_000;

export interface PtyHostLifecycleConfig {
  maxRestartAttempts: number;
  memoryLimitMb: number;
  electronDir: string;
}

export interface PtyHostLifecycleCallbacks {
  /** Forward each message from the child. PtyClient routes these via {@link routeHostEvent}. */
  onMessage: (event: PtyHostEvent) => void;
  /**
   * Called synchronously inside the exit handler, before the setImmediate
   * deferral. PtyClient uses this to: stop the watchdog, reject readyPromise
   * if !wasReady, run a first-pass orphan cleanup with the heuristic crash
   * type, clear the broker, and set shouldResyncProjectContext.
   */
  onExitSync: (info: {
    code: number | null;
    wasReady: boolean;
    fallbackCrashType: CrashType;
  }) => void;
  /**
   * Called inside the setImmediate deferral with the final crash classification.
   * PtyClient uses this to run a second orphan cleanup with the authoritative
   * crash type and to emit `host-crash-details` when crashType !== CLEAN_EXIT.
   */
  onCrashClassified: (info: {
    reportedCode: number | null;
    crashType: CrashType;
    signal: string | null;
    payload: HostCrashPayload | null;
  }) => void;
  /** Called when the restart cap is hit. PtyClient emits `host-crash`. */
  onMaxRestartsReached: (code: number | null) => void;
  /**
   * Called when `utilityProcess.fork()` itself throws. PtyClient emits
   * `host-crash` with code -1.
   */
  onForkFailed: (error: unknown) => void;
  /**
   * Called just before each *restart* fork (not the initial start). PtyClient
   * sets `needsRespawn=true` so its `ready` handler will replay pending spawns.
   */
  onBeforeRestart: () => void;
  /** Returns whether PtyClient.isDisposed is true. */
  isDisposed: () => boolean;
  /** Logger functions. Decoupled from any specific logger implementation. */
  logInfo: (message: string) => void;
  logWarn: (message: string) => void;
}

export class PtyHostLifecycle {
  /** Active UtilityProcess; null between exit and the next fork. Public for test access. */
  child: UtilityProcess | null = null;
  /** Public for test access — read by `isReady()` on PtyClient and the watchdog tick. */
  isInitialized = false;
  /** Number of restart attempts since the last successful `ready`. */
  restartAttempts = 0;
  /** Active restart timer; cleared on dispose / start / manualRestart. */
  restartTimer: NodeJS.Timeout | null = null;
  /**
   * Authoritative crash reason captured from `app.on("child-process-gone")`.
   * Consumed by the next `exit` handler via `setImmediate` deferral, since
   * Electron 37-41 has a documented race where `exit` often fires before
   * `child-process-gone` for utility-process crashes.
   */
  pendingChildProcessGoneReason: { reason: string; exitCode: number } | null = null;

  private childProcessGoneHandler:
    | ((event: Electron.Event, details: Electron.Details) => void)
    | null = null;

  private hostStdoutBuffer = "";
  private hostStderrBuffer = "";

  private readyPromise: Promise<void>;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;

  constructor(
    private readonly config: PtyHostLifecycleConfig,
    private readonly callbacks: PtyHostLifecycleCallbacks
  ) {
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.registerChildProcessGoneListener();
  }

  /** Wait for the host to emit `ready`. Re-creates per fork; safe across restarts. */
  waitForReady(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * Mark the host as ready. Called by PtyClient's `onReady` callback from the
   * event router. Returns false if the host is already dead (late ready event).
   */
  markReady(): boolean {
    if (!this.child) return false;
    this.isInitialized = true;
    this.restartAttempts = 0;
    if (this.readyResolve) {
      this.readyResolve();
      this.readyResolve = null;
      this.readyReject = null;
    }
    return true;
  }

  /** Whether the lifecycle is currently running a host. */
  isRunning(): boolean {
    return this.isInitialized && this.child !== null;
  }

  /**
   * User-initiated restart (e.g., from the renderer). Resets `restartAttempts`
   * to 0 and immediately starts a fresh host. No-ops if already disposed or
   * already running.
   */
  manualRestart(): void {
    if (this.callbacks.isDisposed()) {
      this.callbacks.logWarn("[PtyClient] Cannot manual restart - already disposed");
      return;
    }

    if (this.child !== null) {
      this.callbacks.logWarn("[PtyClient] Cannot manual restart - host process already exists");
      return;
    }

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    this.restartAttempts = 0;
    this.callbacks.onBeforeRestart();
    this.callbacks.logInfo("[PtyClient] Manual restart initiated");
    this.start();
  }

  /** Start the host. Used both for the initial spawn and subsequent restarts. */
  start(): void {
    if (this.callbacks.isDisposed()) {
      console.warn("[PtyClient] Cannot start host - already disposed");
      return;
    }

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    // Defensive: clear any stale crash reason from a prior host cycle. Under
    // normal flow the `exit` handler's setImmediate consumes this, but a missed
    // exit event (or out-of-band listener fire) would otherwise leak into the
    // next crash.
    this.pendingChildProcessGoneReason = null;

    this.isInitialized = false;
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    const hostPath = path.join(this.config.electronDir, "pty-host-bootstrap.js");
    console.log(`[PtyClient] Starting Pty Host from: ${hostPath}`);

    try {
      this.child = utilityProcess.fork(hostPath, [], {
        serviceName: "daintree-pty-host",
        stdio: "pipe",
        cwd: os.homedir(),
        // `--diagnostic-dir` redirects v8.setHeapSnapshotNearHeapLimit dumps
        // (set in pty-host.ts) into the app's logs directory instead of the
        // utility process CWD (homedir).
        execArgv: [
          `--max-old-space-size=${this.config.memoryLimitMb}`,
          `--diagnostic-dir=${app.getPath("logs")}`,
          "--report-exclude-env",
        ],
        env: {
          ...(process.env as Record<string, string>),
          DAINTREE_USER_DATA: app.getPath("userData"),
          DAINTREE_UTILITY_PROCESS_KIND: "pty-host",
          // node-pty 1.x hangs intermittently on Linux kernels with io_uring
          // enabled (microsoft/node-pty#630, closed as not planned). The fix
          // is permanent and must be set inside the explicit env object — a
          // mutation on process.env wouldn't survive utilityProcess.fork's
          // env override.
          ...(process.platform === "linux" ? { UV_USE_IO_URING: "0" } : {}),
        },
      });
      console.log(`[PtyClient] Pty Host started with ${this.config.memoryLimitMb}MB memory limit`);
    } catch (error) {
      console.error("[PtyClient] Failed to fork Pty Host:", error);
      if (this.readyReject) {
        this.readyReject(new Error("PTY host failed to start"));
        this.readyResolve = null;
        this.readyReject = null;
      }
      this.callbacks.onForkFailed(error);
      return;
    }

    this.installHostLogForwarding();

    this.child.on("message", (msg: PtyHostEvent) => {
      this.callbacks.onMessage(msg);
    });

    this.child.on("exit", (code) => {
      this.handleExit(code);
    });

    console.log("[PtyClient] Pty Host started");
  }

  /** Send one request to the host. Treats `postMessage` failure as a crash. */
  postMessage(request: PtyHostRequest): void {
    if (!this.child) {
      console.warn("[PtyClient] Cannot send - host not running");
      return;
    }
    try {
      this.child.postMessage(request);
    } catch (error) {
      console.error("[PtyClient] postMessage failed:", error);
      if (this.child) {
        this.child.kill();
      }
    }
  }

  /**
   * Tear down the lifecycle. Called from PtyClient.dispose() — clears timers,
   * removes the child-process-gone listener, asks the host to dispose, then
   * force-kills after 1s if it hasn't exited.
   */
  dispose(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.child) {
      this.postMessage({ type: "dispose" });
      // Give the host a moment to clean up, then force kill
      setTimeout(() => {
        if (this.child) {
          this.child.kill();
          this.child = null;
        }
      }, 1000);
    }

    if (this.childProcessGoneHandler) {
      app.off("child-process-gone", this.childProcessGoneHandler);
      this.childProcessGoneHandler = null;
    }
    this.pendingChildProcessGoneReason = null;
  }

  /**
   * Register the `child-process-gone` listener once. Filtered to our PTY host
   * by `type === "Utility"` and `name === "daintree-pty-host"`. The handler
   * only records the reason; the `exit` handler consumes it via setImmediate.
   */
  private registerChildProcessGoneListener(): void {
    if (this.childProcessGoneHandler) return;
    const handler = (_event: Electron.Event, details: Electron.Details): void => {
      if (this.callbacks.isDisposed()) return;
      if (details.type !== "Utility") return;
      // Electron 41 populates `name` from `serviceName` at runtime, but both
      // fields are typed as optional. Accept either to stay resilient to
      // future runtime changes or edge cases where only one is set.
      const matchesHost =
        details.name === "daintree-pty-host" || details.serviceName === "daintree-pty-host";
      if (!matchesHost) return;
      this.pendingChildProcessGoneReason = {
        reason: details.reason,
        exitCode: details.exitCode,
      };
    };
    this.childProcessGoneHandler = handler;
    app.on("child-process-gone", handler);
  }

  private handleExit(code: number | null): void {
    this.flushHostOutputBuffers();
    // UtilityProcess exit event doesn't provide signal, but we can infer from code
    const signal = code !== null && code > 128 ? `SIG${code - 128}` : null;
    const fallbackCrashType = classifyCrash(code, signal);

    const wasReady = this.isInitialized;
    this.isInitialized = false;
    this.child = null; // Prevent posting to dead process

    if (this.callbacks.isDisposed()) {
      // Expected shutdown - drop any buffered reason so it can't leak.
      this.pendingChildProcessGoneReason = null;
      this.callbacks.onExitSync({ code, wasReady, fallbackCrashType });
      return;
    }

    // If host crashed before ready, reject the promise so startup doesn't hang
    if (!wasReady && this.readyReject) {
      this.readyReject(new Error("PTY host exited before ready"));
      this.readyResolve = null;
      this.readyReject = null;
    }

    this.callbacks.onExitSync({ code, wasReady, fallbackCrashType });

    // Electron 37-41 race: `exit` often fires before `child-process-gone`
    // for utility-process crashes. Defer crash classification by one event
    // loop tick so the authoritative reason can arrive; fall back to the
    // exit-code heuristic when no reason was captured in time.
    setImmediate(() => {
      if (this.callbacks.isDisposed()) {
        this.pendingChildProcessGoneReason = null;
        return;
      }

      const gone = this.pendingChildProcessGoneReason;
      this.pendingChildProcessGoneReason = null;
      const crashType: CrashType = gone ? mapGoneReasonToCrashType(gone.reason) : fallbackCrashType;
      // Prefer the authoritative exit code from `child-process-gone` over the
      // (sometimes unreliable) one from `exit` — Electron 40-41 has a known
      // signed/unsigned mangling bug on Windows for the exit event.
      const reportedCode = gone ? gone.exitCode : code;

      console.error(
        `[PtyClient] Pty Host exited with code ${reportedCode}` +
          (crashType !== "CLEAN_EXIT" ? ` (${crashType})` : "")
      );

      const payload: HostCrashPayload | null =
        crashType !== "CLEAN_EXIT"
          ? {
              code: reportedCode,
              // When we have an authoritative reason, trust it and clear the
              // derived-from-exit-code signal string.
              signal: gone ? null : signal,
              crashType,
              timestamp: Date.now(),
            }
          : null;

      this.callbacks.onCrashClassified({
        reportedCode,
        crashType,
        signal: gone ? null : signal,
        payload,
      });

      // If `manualRestart()` already spawned a new host during the defer
      // window, don't schedule a second auto-restart — it would orphan that host.
      if (this.child !== null) return;

      if (this.restartAttempts < this.config.maxRestartAttempts) {
        this.restartAttempts++;
        // Full jitter with floor: break deterministic retry lockstep while
        // keeping a minimum wait so instant-fail crashes don't spin the CPU.
        const cap = Math.min(
          RESTART_CAP_BASE_MS * Math.pow(2, this.restartAttempts),
          RESTART_CAP_MAX_MS
        );
        const delay =
          RESTART_FLOOR_MS + Math.floor(Math.random() * Math.max(0, cap - RESTART_FLOOR_MS));
        console.log(
          `[PtyClient] Restarting Host in ${delay}ms (attempt ${this.restartAttempts}/${this.config.maxRestartAttempts})`
        );

        if (this.restartTimer) {
          clearTimeout(this.restartTimer);
        }
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (this.callbacks.isDisposed() || this.child !== null) return;
          this.callbacks.onBeforeRestart();
          this.start();
        }, delay);
      } else {
        console.error("[PtyClient] Max restart attempts reached, giving up");
        this.callbacks.onMaxRestartsReached(reportedCode);
      }
    });
  }

  private installHostLogForwarding(): void {
    if (!this.child) return;
    this.hostStdoutBuffer = "";
    this.hostStderrBuffer = "";

    const stdout = (this.child as unknown as { stdout?: NodeJS.ReadableStream }).stdout;
    const stderr = (this.child as unknown as { stderr?: NodeJS.ReadableStream }).stderr;

    stdout?.on("data", (chunk: Buffer) => this.forwardHostOutput("stdout", chunk));
    stderr?.on("data", (chunk: Buffer) => this.forwardHostOutput("stderr", chunk));
  }

  private forwardHostOutput(kind: "stdout" | "stderr", chunk: Buffer): void {
    const text = chunk.toString("utf8");
    if (kind === "stdout") {
      this.hostStdoutBuffer += text;
    } else {
      this.hostStderrBuffer += text;
    }

    if (this.hostStdoutBuffer.length > HOST_LOG_BUFFER_LIMIT) {
      this.hostStdoutBuffer = this.hostStdoutBuffer.slice(-HOST_LOG_BUFFER_LIMIT);
    }
    if (this.hostStderrBuffer.length > HOST_LOG_BUFFER_LIMIT) {
      this.hostStderrBuffer = this.hostStderrBuffer.slice(-HOST_LOG_BUFFER_LIMIT);
    }

    const current = kind === "stdout" ? this.hostStdoutBuffer : this.hostStderrBuffer;
    const lines = current.split(/\r?\n/);
    const remainder = lines.pop() ?? "";
    if (kind === "stdout") {
      this.hostStdoutBuffer = remainder;
    } else {
      this.hostStderrBuffer = remainder;
    }

    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (!trimmed) continue;
      const message = `[PtyHost] ${trimmed.length > HOST_LOG_LINE_LIMIT ? `${trimmed.slice(0, HOST_LOG_LINE_LIMIT)}…` : trimmed}`;
      if (kind === "stderr") {
        this.callbacks.logWarn(message);
      } else {
        this.callbacks.logInfo(message);
      }
    }
  }

  private flushHostOutputBuffers(): void {
    const stdoutRemainder = this.hostStdoutBuffer.trim();
    if (stdoutRemainder) {
      this.callbacks.logInfo(
        `[PtyHost] ${stdoutRemainder.length > HOST_LOG_LINE_LIMIT ? `${stdoutRemainder.slice(0, HOST_LOG_LINE_LIMIT)}…` : stdoutRemainder}`
      );
    }
    const stderrRemainder = this.hostStderrBuffer.trim();
    if (stderrRemainder) {
      this.callbacks.logWarn(
        `[PtyHost] ${stderrRemainder.length > HOST_LOG_LINE_LIMIT ? `${stderrRemainder.slice(0, HOST_LOG_LINE_LIMIT)}…` : stderrRemainder}`
      );
    }
    this.hostStdoutBuffer = "";
    this.hostStderrBuffer = "";
  }
}
