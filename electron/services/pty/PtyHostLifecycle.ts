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
 *     the Electron `exit`/`child-process-gone` ordering race (electron/electron#42283),
 *     where `exit` often fires before `child-process-gone` for utility-process
 *     crashes.
 *   - On Windows, the `child-process-gone` exitCode is preferred over the
 *     `exit` event's code as defense-in-depth for pre-41.0.4 builds and future
 *     regressions of the signed/unsigned mangling bug (fixed in
 *     electron/electron#50386, landed Electron 41.0.4).
 *   - Restart attempts use full jitter with a 100ms floor and a cap of
 *     `min(2^N * 1000ms, 10000ms)` per attempt N.
 *   - If `manualRestart()` already spawned a host during the setImmediate
 *     window, the deferred restart no-ops to avoid orphaning.
 */

import { app, utilityProcess, type UtilityProcess } from "electron";
import os from "os";
import path from "path";
import { performance } from "node:perf_hooks";
import { PERF_MARKS } from "../../../shared/perf/marks.js";
import type {
  CrashType,
  HostCrashPayload,
  PtyHostEvent,
  PtyHostRequest,
} from "../../../shared/types/pty-host.js";
import { mainBootAbsMs, markPerformance } from "../../utils/performance.js";

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
  // POSIX convention: code > 128 encodes signal number (e.g. 143 = 128 + 15 = SIGTERM).
  // On Windows, large exit codes are uint32 NTSTATUS values (e.g. 0xC0000005 = 3221225477
  // for ACCESS_VIOLATION) — they are not signal-encoded and should fall through to
  // UNKNOWN_CRASH instead of misreporting as a POSIX signal termination.
  if (code > 128 && process.platform !== "win32") {
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

// Time-windowed crash-loop guard. Mirrors the constants in
// `CrashLoopGuardService` and `WorkspaceHostProcess` so the three guards
// follow the same policy: three crashes within the window trip the cap, and
// crashes spread further apart decay out lazily at crash-record-time.
// Constants are duplicated rather than imported because the guards operate at
// different layers (disk-persisted app-level vs. in-memory utility-process)
// and shouldn't be coupled. The alignment test
// (`crashGuardAlignment.test.ts`) asserts the three values stay in lockstep
// so the next person tuning one is forced to consider the others.
const CRASH_THRESHOLD = 3;
export const CRASH_WINDOW_MS = 30 * 60 * 1000;

export interface PtyHostLifecycleConfig {
  memoryLimitMb: number;
  electronDir: string;
  /**
   * UtilityProcess serviceName for this host run. Defaults to the legacy
   * "daintree-pty-host". PTY fabric shards pass a per-project name so crash
   * attribution (`child-process-gone` details.name) and process listings
   * identify the owning project; the gone-listener filter matches this exact
   * name, so a shard never consumes a sibling shard's crash reason.
   */
  serviceName?: string;
  /**
   * Read at each fork. When true the host defers its boot-time homedir pool
   * warm — used on project-restoring boots where the set-active-project that
   * follows ready immediately drains the pool to the project path, so the
   * homedir warm would only spawn shells for the drain to kill (#10393).
   */
  deferInitialPoolWarm?: () => boolean;
}

const DEFAULT_SERVICE_NAME = "daintree-pty-host";

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
  /**
   * Sliding window of recent crash timestamps. Lazy-pruned to entries within
   * `CRASH_WINDOW_MS` on each crash — no proactive reset, no setTimeout.
   * Public for test access.
   */
  crashTimestamps: number[] = [];
  /** Active restart timer; cleared on dispose / start / manualRestart. */
  restartTimer: NodeJS.Timeout | null = null;
  /** Force-kill backstop timer scheduled by dispose(); cleared if dispose runs again. */
  private disposeTimer: NodeJS.Timeout | null = null;
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
    this.readyPromise = this.createReadyPromise();
    this.registerChildProcessGoneListener();
  }

  /**
   * Mint a fresh readyPromise for the next fork. The no-op catch marks the
   * promise handled without consuming the rejection for real awaiters —
   * fork/pre-ready-crash rejections on a run nobody awaits (restart cycles,
   * fabric project shards) must not surface as unhandled rejections.
   */
  private createReadyPromise(): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    promise.catch(() => {});
    return promise;
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
    // Do NOT clear `crashTimestamps` here — clearing on ready would defeat
    // the sliding window for a crash-ready-crash-ready loop, where each fresh
    // ready would wipe the history right before the next crash. The window
    // decays lazily at crash-record-time in `handleExit()`.
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
   * User-initiated restart (e.g., from the renderer). Clears the crash window
   * so the new cycle starts with a fresh budget. No-ops if already disposed
   * or already running.
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

    this.crashTimestamps = [];
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
    this.readyPromise = this.createReadyPromise();

    const hostPath = path.join(this.config.electronDir, "pty-host-bootstrap.js");

    // Anchor cross-process timing for the host's per-phase marks. The child
    // has its own `performance.timeOrigin`, so we ship a wall-clock-aligned
    // float (sub-ms precision) and let the child subtract.
    const forkAbsMs = performance.timeOrigin + performance.now();
    markPerformance(PERF_MARKS.PTY_HOST_FORK_DISPATCHED);

    try {
      this.child = utilityProcess.fork(hostPath, [], {
        serviceName: this.config.serviceName ?? DEFAULT_SERVICE_NAME,
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
          // Keep the host's ResourceGovernor budget in lockstep with the V8
          // cap above — the fabric RAM-scales the cap per shard, and a
          // governor still assuming 512 would throttle a 2 GB shard at 25%.
          DAINTREE_PTY_HEAP_BUDGET_MB: String(this.config.memoryLimitMb),
          // Shard identity for per-process file scoping (emergency log) —
          // Electron does not expose serviceName to the child itself.
          DAINTREE_PTY_SHARD_SERVICE: this.config.serviceName ?? DEFAULT_SERVICE_NAME,
          // Forward packaged-build state to the pty host so dev-only diagnostics
          // (e.g. agent CLI CPU profiling via `DAINTREE_PROFILE_AGENT_STARTUP`)
          // can gate themselves on `!== "0"` without touching `app.isPackaged`.
          DAINTREE_IS_PACKAGED: app.isPackaged ? "1" : "0",
          DAINTREE_UTILITY_PROCESS_KIND: "pty-host",
          DAINTREE_PERF_FORK_ABS_MS: String(forkAbsMs),
          DAINTREE_PERF_MAIN_BOOT_ABS_MS: String(mainBootAbsMs),
          ...(this.config.deferInitialPoolWarm?.() ? { DAINTREE_PTY_DEFER_POOL_WARM: "1" } : {}),
          // node-pty 1.x hangs intermittently on Linux kernels with io_uring
          // enabled (microsoft/node-pty#630, closed as not planned). The fix
          // is permanent and must be set inside the explicit env object — a
          // mutation on process.env wouldn't survive utilityProcess.fork's
          // env override.
          ...(process.platform === "linux" ? { UV_USE_IO_URING: "0" } : {}),
        },
      });
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

    if (this.disposeTimer) {
      clearTimeout(this.disposeTimer);
      this.disposeTimer = null;
    }

    if (this.child) {
      this.postMessage({ type: "dispose" });
      // Give the host a moment to clean up, then force kill. Unref'd so the
      // pending backstop never holds the Electron event loop alive after
      // app.quit when the host has already cooperated.
      this.disposeTimer = setTimeout(() => {
        this.disposeTimer = null;
        if (this.child) {
          this.child.kill();
          this.child = null;
        }
      }, 1000);
      this.disposeTimer.unref?.();
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
      // future runtime changes or edge cases where only one is set. Matches
      // this lifecycle's own serviceName exactly so fabric shards never
      // consume a sibling shard's crash reason.
      const expectedName = this.config.serviceName ?? DEFAULT_SERVICE_NAME;
      const matchesHost = details.name === expectedName || details.serviceName === expectedName;
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
    // UtilityProcess exit event doesn't provide signal, but we can infer from
    // the POSIX exit-code convention (`code = 128 + signum`). On Windows, exit
    // codes above 128 are uint32 NTSTATUS values (e.g. 0xC0000005 = 3221225477
    // for ACCESS_VIOLATION), so the heuristic would emit nonsense like
    // "SIG3221225349" into host-crash-details — gate it to non-Windows only.
    const signal =
      code !== null && code > 128 && process.platform !== "win32" ? `SIG${code - 128}` : null;
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

    // `exit`/`child-process-gone` ordering race (electron/electron#42283): `exit`
    // often fires before `child-process-gone` for utility-process crashes. Defer
    // crash classification by one event loop tick so the authoritative reason
    // can arrive; fall back to the exit-code heuristic when no reason was
    // captured in time.
    setImmediate(() => {
      if (this.callbacks.isDisposed()) {
        this.pendingChildProcessGoneReason = null;
        return;
      }

      const gone = this.pendingChildProcessGoneReason;
      this.pendingChildProcessGoneReason = null;
      const crashType: CrashType = gone ? mapGoneReasonToCrashType(gone.reason) : fallbackCrashType;
      // Prefer the authoritative exit code from `child-process-gone` over the
      // (sometimes unreliable) one from `exit` — defense-in-depth for pre-41.0.4
      // builds and future regressions of the Windows signed/unsigned mangling
      // bug (fixed in electron/electron#50386, landed Electron 41.0.4).
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

      // Time-windowed sliding crash counter. Lazy-prune entries older than
      // the window, then append the current crash. Three crashes within the
      // window trip the cap; crashes spread further apart decay out.
      const crashAt = Date.now();
      this.crashTimestamps = this.crashTimestamps.filter((t) => crashAt - t < CRASH_WINDOW_MS);
      this.crashTimestamps.push(crashAt);

      if (this.crashTimestamps.length < CRASH_THRESHOLD) {
        const windowAttempt = this.crashTimestamps.length;
        // Full jitter with floor: break deterministic retry lockstep while
        // keeping a minimum wait so instant-fail crashes don't spin the CPU.
        const cap = Math.min(RESTART_CAP_BASE_MS * Math.pow(2, windowAttempt), RESTART_CAP_MAX_MS);
        const delay =
          RESTART_FLOOR_MS + Math.floor(Math.random() * Math.max(0, cap - RESTART_FLOOR_MS));

        if (this.restartTimer) {
          clearTimeout(this.restartTimer);
        }
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (this.callbacks.isDisposed() || this.child !== null) return;
          this.callbacks.onBeforeRestart();
          this.start();
        }, delay);
        this.restartTimer.unref?.();
      } else {
        console.error(
          `[PtyClient] Max restart attempts reached (${CRASH_THRESHOLD} crashes in ${CRASH_WINDOW_MS}ms), giving up`
        );
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
