import { utilityProcess, UtilityProcess, app, MessagePortMain } from "electron";
import { EventEmitter } from "events";
import { createHash } from "crypto";
import path from "path";
import os from "os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "url";
import type {
  WorkspaceHostRequest,
  WorkspaceHostEvent,
  WorkspaceClientConfig,
  MonitorConfig,
} from "../../shared/types/workspace-host.js";
import { PERF_MARKS } from "../../shared/perf/marks.js";
import { BrokerError, RequestResponseBroker } from "./rpc/RequestResponseBroker.js";
import { dispatchForgeRpc } from "./forgeRpcServer.js";
import { createLogger } from "../utils/logger.js";
import { mainBootAbsMs, markPerformance } from "../utils/performance.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { getForgeProviderImplEntries } from "./forgeProviderRegistry.js";
import type { ForgeProviderMatcher } from "../../shared/utils/forgeHostnames.js";

const logger = createLogger("main:WorkspaceHost");
const logInfo = (msg: string, ctx?: Record<string, unknown>) =>
  ctx ? logger.info(msg, ctx) : logger.info(msg);
const logWarn = (msg: string, ctx?: Record<string, unknown>) =>
  ctx ? logger.warn(msg, ctx) : logger.warn(msg);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RESTART_FLOOR_MS = 100;
const RESTART_CAP_BASE_MS = 1_000;
const RESTART_CAP_MAX_MS = 10_000;

// Monitor-config pushes are fire-and-forget, so no broker entry ever owns the
// response. Keep the required protocol field compact instead of minting an ID.
const UNTRACKED_MONITOR_CONFIG_REQUEST_ID = "";

// Time-windowed crash-loop guard. Mirrors the constants in PtyHostLifecycle
// and CrashLoopGuardService so the three guards follow the same policy: three
// crashes within the window trip the cap, and crashes spread further apart
// decay out lazily at crash-record-time. Duplicated rather than imported
// because the guards operate at independent layers. The alignment test
// (`crashGuardAlignment.test.ts`) asserts the three values stay in lockstep
// so the next person tuning one is forced to consider the others.
const CRASH_THRESHOLD = 3;
export const CRASH_WINDOW_MS = 30 * 60 * 1000;

// Slow-OOM crash-loop detector. The burst guard above only trips when three
// crashes land inside a single *fixed* 30-minute window. A host that OOMs every
// 6-11 minutes restarts cleanly between crashes, and because the OOM cadence is
// jittery (each crash writes a ~55 MB near-heap-limit snapshot, and GC during
// the dump buys irregular extra time) the oldest timestamp routinely decays out
// of the window before the third crash lands — so the burst guard never trips
// and the host loops in "Reconnecting…" forever (#10729).
//
// This secondary detector keys on the *interval between consecutive crashes*
// instead of a fixed window, which is robust to that jitter: when two
// consecutive crashes are each less than `OOM_LOOP_INTERVAL_MS` apart, the
// process is in a slow loop and we give up (emit `host-crash`) instead of
// restarting again. 20 minutes is deliberately wider than the burst guard's
// effective reach (~15-min cadence — at wider spacing the 30-min/3 window can no
// longer hold three entries) so this strictly extends detection to the slow
// loops the burst guard misses, while still covering the reported 6-11 min band.
//
// Intentionally NOT part of the `crashGuardAlignment.test.ts` triad — it tracks
// a distinct concept (inter-crash cadence, not a fixed window) and is named so
// it cannot be confused with the aligned CRASH_WINDOW_MS/CRASH_THRESHOLD pair.
const OOM_LOOP_INTERVAL_MS = 20 * 60 * 1000;
const OOM_LOOP_THRESHOLD = 2;

export class WorkspaceHostProcess extends EventEmitter {
  private child: UtilityProcess | null = null;
  private config: Required<WorkspaceClientConfig>;
  private isInitialized = false;
  private isDisposed = false;
  readonly projectPath: string;
  private readonly serviceName: string;

  private healthCheckInterval: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private disposeTimer: NodeJS.Timeout | null = null;
  /**
   * Sliding window of recent crash timestamps. Lazy-pruned to entries within
   * `CRASH_WINDOW_MS` on each crash — no proactive reset, no setTimeout.
   * Three crashes within the window trip the cap and emit `host-crash`.
   */
  private crashTimestamps: number[] = [];
  /**
   * Timestamp of the previous crash, used by the slow-OOM detector to measure
   * the interval between consecutive crashes. `null` until the first crash.
   */
  private previousCrashAt: number | null = null;
  /**
   * Count of consecutive crashes whose interval from the prior crash was under
   * `OOM_LOOP_INTERVAL_MS`. Reset whenever a crash follows a longer gap. Tripping
   * `OOM_LOOP_THRESHOLD` signals a slow OOM crash-loop (#10729). In-memory only —
   * the loop persists within a single session, so it needs no disk backing.
   */
  private consecutiveShortCrashIntervals = 0;
  /**
   * Authoritative crash reason captured from `app.on("child-process-gone")`.
   * Consumed by the next `exit` handler via `setImmediate` deferral, since the
   * Electron `exit`/`child-process-gone` ordering race (electron/electron#42283)
   * causes `exit` to often fire before `child-process-gone` for utility-process
   * crashes. This is distinct from the Windows exit-code mangling bug
   * (electron/electron#50386, fixed in Electron 41.0.4).
   */
  private pendingChildProcessGoneReason: { reason: string; exitCode: number } | null = null;
  private childProcessGoneHandler:
    ((event: Electron.Event, details: Electron.Details) => void) | null = null;
  private isHealthCheckPaused = false;
  private isWaitingForHandshake = false;
  private handshakeTimeout: NodeJS.Timeout | null = null;
  private missedHeartbeats = 0;
  private readonly MAX_MISSED_HEARTBEATS = 3;

  private broker = new RequestResponseBroker({
    idPrefix: "workspace",
    // Slow git ops (project-pulse, file-diff, create-worktree) need the legacy
    // 30s ceiling; collapsing to the broker's 5s default would break them.
    defaultTimeoutMs: 30000,
  });

  private readyPromise: Promise<void>;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;

  /** Replayed on every `ready` — the child's message listener isn't attached
   * until after `ready`, so pushing at fork time would silently drop. */
  private logLevelOverridesCache: Record<string, string> = {};

  /** Last GitHub fetch-throttle multiplier relayed from main. Replayed on
   * every `ready` (initial + restarts) so a host restart doesn't silently
   * revert monitor fetch cadence to the unthrottled default. */
  private fetchThrottleMultiplierCache = 1;

  /** Last forge provider-matcher table relayed from main. Replayed on every
   * `ready` (initial + restarts) so a restarted host can still resolve remote
   * URLs to provider ids. `null` until the first relay — nothing is pushed
   * before the registry has reported, keeping monitors at their unmatched
   * initial state. */
  private forgeProviderMatchersCache: ForgeProviderMatcher[] | null = null;

  /** Accumulated monitor config (poll/fetch intervals, watcher cap) relayed
   * from main. Merged per-field because callers push partial configs (the
   * focus throttle sends poll intervals only; the resource profile adds fetch
   * cadence and watcher cap). Replayed on every `ready` so a host restart
   * doesn't silently revert to the in-host balanced defaults. `null` until
   * the first push. */
  private monitorConfigCache: MonitorConfig | null = null;

  /** Buffers for line-splitting stdout/stderr from the forked host. Forking
   * with `stdio:"pipe"` (instead of `"inherit"`) isolates the host from the
   * main process's fd 2 — critical on AppImage GUI launches where fd 2 points
   * to a dead pty that returns EIO on write. See issue #5588. */
  private hostStdoutBuffer = "";
  private hostStderrBuffer = "";

  constructor(projectPath: string, config: Required<WorkspaceClientConfig>) {
    super();
    this.projectPath = projectPath;
    this.config = config;

    const safeName = path
      .basename(projectPath)
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .slice(0, 40);
    // Hash the full path to disambiguate same-basename projects (e.g.
    // `/workspaces/a/api` and `/workspaces/b/api`). Without this suffix the
    // per-instance `child-process-gone` filter would match both hosts and
    // cross-attribute crash reasons.
    const pathHash = createHash("sha1").update(projectPath).digest("hex").slice(0, 8);
    this.serviceName = `daintree-workspace-host:${safeName}-${pathHash}`;

    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.registerChildProcessGoneListener();
    this.startHost();
  }

  async waitForReady(): Promise<void> {
    return this.readyPromise;
  }

  isReady(): boolean {
    return this.isInitialized && this.child !== null;
  }

  generateRequestId(): string {
    return this.broker.generateId();
  }

  send(request: WorkspaceHostRequest): boolean {
    if (!this.child) {
      console.warn(`[WorkspaceHost:${this.serviceName}] Cannot send - host not running`);
      return false;
    }
    try {
      this.child.postMessage(request);
      return true;
    } catch (error) {
      console.error(`[WorkspaceHost:${this.serviceName}] Failed to send message:`, error);
      return false;
    }
  }

  /**
   * Transfer a MessagePort for the new worktree port protocol (Phase 1).
   * Supports request/response correlation and scoped event delivery.
   */
  attachWorktreePort(port: MessagePortMain): boolean {
    if (!this.child || this.isDisposed) return false;
    try {
      this.child.postMessage({ type: "attach-worktree-port" }, [port]);
      return true;
    } catch (error) {
      console.error(`[WorkspaceHost:${this.serviceName}] Failed to attach worktree port:`, error);
      return false;
    }
  }

  sendWithResponse<T>(
    request: WorkspaceHostRequest & { requestId: string },
    timeoutMs: number = 30000
  ): Promise<T> {
    if (this.isDisposed) {
      return Promise.reject(
        new BrokerError("APP_SHUTDOWN", "WorkspaceHostProcess disposed", {
          projectScopeId: this.projectPath,
        })
      );
    }
    if (!this.child) {
      return Promise.reject(
        new BrokerError("HOST_EXITED", "Workspace Host not running", {
          projectScopeId: this.projectPath,
        })
      );
    }

    const promise = this.broker.register<T>(request.requestId, {
      method: request.type,
      timeoutMs,
    });

    try {
      if (!this.child) {
        throw new BrokerError("HOST_EXITED", "Workspace Host not running", {
          projectScopeId: this.projectPath,
        });
      }
      this.child.postMessage(request);
    } catch (error) {
      this.broker.reject(
        request.requestId,
        error instanceof Error ? error : new Error(String(error))
      );
    }

    // The broker emits plain BrokerError("TIMEOUT", ...) on timeout; callers
    // here have always seen projectScopeId on the rejection, so wrap to preserve
    // that contract without re-running the timer.
    return promise.catch((err: unknown) => {
      if (
        err instanceof BrokerError &&
        err.code === "TIMEOUT" &&
        err.projectScopeId === undefined
      ) {
        throw new BrokerError("TIMEOUT", "Request timeout", {
          projectScopeId: this.projectPath,
        });
      }
      throw err;
    });
  }

  /**
   * Update the cached overrides and push immediately if initialized. On
   * restart, `ready` replays the cached map automatically.
   */
  setLogLevelOverrides(overrides: Record<string, string>): void {
    this.logLevelOverridesCache = { ...overrides };
    if (this.isInitialized && this.child) {
      this.send({ type: "set-log-level-overrides", overrides: this.logLevelOverridesCache });
    }
  }

  /**
   * Update the cached fetch-throttle multiplier and push immediately if
   * initialized. On restart, `ready` replays the cached value automatically.
   */
  private async relayForgeCredentialsFromRegistry(): Promise<void> {
    for (const [providerId, impl] of getForgeProviderImplEntries()) {
      try {
        const credentials = await impl.getCredentials();
        if (!credentials) continue;
        if (this.isDisposed || !this.isInitialized) return;
        this.send({ type: "update-forge-credentials", providerId, credentials });
      } catch {
        // A provider that cannot produce credentials must not block the
        // replay of the remaining providers (or the ready handling).
      }
    }
  }

  relayFetchThrottle(multiplier: number): void {
    this.fetchThrottleMultiplierCache = multiplier;
    if (this.isInitialized && this.child) {
      this.send({ type: "apply-fetch-throttle", multiplier: this.fetchThrottleMultiplierCache });
    }
  }

  /**
   * Merge the partial config into the cache and push immediately if
   * initialized. On restart, `ready` replays the merged cache automatically.
   */
  updateMonitorConfig(config: MonitorConfig): void {
    this.monitorConfigCache = { ...this.monitorConfigCache, ...config };
    if (this.isInitialized && this.child) {
      this.send({
        type: "update-monitor-config",
        requestId: UNTRACKED_MONITOR_CONFIG_REQUEST_ID,
        config,
      });
    }
  }

  /**
   * Update the cached forge provider-matcher table and push immediately if
   * initialized. On restart, `ready` replays the cached table automatically.
   */
  relayForgeProviderMatchers(matchers: ForgeProviderMatcher[]): void {
    this.forgeProviderMatchersCache = matchers;
    if (this.isInitialized && this.child) {
      this.send({ type: "forge-provider-matchers", matchers: this.forgeProviderMatchersCache });
    }
  }

  pauseHealthCheck(): void {
    if (this.isHealthCheckPaused) return;
    this.isHealthCheckPaused = true;
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout);
      this.handshakeTimeout = null;
    }
    this.isWaitingForHandshake = false;
  }

  resumeHealthCheck(): void {
    if (!this.isHealthCheckPaused) return;
    if (!this.isInitialized || !this.child) {
      this.isHealthCheckPaused = false;
      return;
    }

    this.isHealthCheckPaused = false;

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout);
      this.handshakeTimeout = null;
    }

    this.isWaitingForHandshake = true;
    this.send({ type: "health-check" });

    this.handshakeTimeout = setTimeout(() => {
      if (this.isWaitingForHandshake) {
        this.isWaitingForHandshake = false;
        this.handshakeTimeout = null;
        this.startHealthCheckInterval();
      }
    }, 5000);
  }

  /**
   * Restart the host after its auto-restart budget has been exhausted.
   * Clears the crash window so future crashes get a fresh budget, respawns
   * the child, and emits `"restarted"` so `WorkspaceClient` can re-broker
   * ports and reload the project — the auto-restart path emits this from its
   * `setTimeout` callback which `manualRestart()` bypasses.
   */
  manualRestart(): void {
    if (this.isDisposed) {
      console.warn(`[WorkspaceHost:${this.serviceName}] Cannot manual restart - already disposed`);
      return;
    }

    if (this.child !== null) {
      console.warn(
        `[WorkspaceHost:${this.serviceName}] Cannot manual restart - host process already exists`
      );
      return;
    }

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    this.crashTimestamps = [];
    this.previousCrashAt = null;
    this.consecutiveShortCrashIntervals = 0;

    console.log(`[WorkspaceHost:${this.serviceName}] Manual restart initiated`);
    this.startHost();

    // Only signal "restarted" when the fork actually produced a child —
    // `startHost()` emits `host-crash` on fork failure and leaves `child`
    // null; emitting `restarted` in that case would poison
    // `reloadProjectAfterRestart` by awaiting a `waitForReady()` that will
    // never resolve.
    if (this.child !== null) {
      this.emit("restarted");
    }
  }

  /**
   * E2E seam: force-kill the host child to exercise the real crash →
   * auto-restart → `restarted` → port re-broker path. Mirrors the health-check
   * watchdog's SIGKILL. Gated to `DAINTREE_E2E_FAULT_MODE` at the main-process
   * call site; never invoked in production. Returns false if there is no live
   * child to kill.
   */
  _crashForTesting(): boolean {
    if (this.isDisposed || !this.child) return false;
    const pid = this.child.pid;
    if (!pid) return false;
    try {
      process.kill(pid, "SIGKILL");
      return true;
    } catch {
      return false;
    }
  }

  _hasLiveChildForTesting(): boolean {
    return !this.isDisposed && this.child !== null && typeof this.child.pid === "number";
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout);
      this.handshakeTimeout = null;
    }
    this.isWaitingForHandshake = false;

    if (this.childProcessGoneHandler) {
      app.off("child-process-gone", this.childProcessGoneHandler);
      this.childProcessGoneHandler = null;
    }
    this.pendingChildProcessGoneReason = null;

    if (this.readyReject) {
      this.readyReject(
        new BrokerError("APP_SHUTDOWN", "WorkspaceHostProcess disposed", {
          projectScopeId: this.projectPath,
        })
      );
      this.readyReject = null;
      this.readyResolve = null;
    }

    this.broker.clear(
      new BrokerError("APP_SHUTDOWN", "WorkspaceHostProcess disposed", {
        projectScopeId: this.projectPath,
      })
    );

    if (this.child) {
      this.send({ type: "dispose" });
      // Unref'd so the pending backstop never holds the Electron event loop
      // alive after app.quit when the host has already cooperated. Cleared by
      // the `exit` handler, so a host that exits on the dispose message above
      // never reaches the signal below.
      this.disposeTimer = setTimeout(() => {
        this.disposeTimer = null;
        const pid = this.child?.pid;
        if (!pid) return;
        // Deliberately NOT `child.kill()` (#11069): Electron's
        // `UtilityProcess.kill()` runs `Process::Terminate` +
        // `base::EnsureProcessTerminated`, which on macOS blocks the calling
        // thread — main — for up to 2s waiting for the child to die, freezing
        // window input routing. A raw SIGKILL is non-blocking and cannot be
        // trapped by the child. Matches the health watchdog's force-kill.
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          // ESRCH — the child exited between the pid read and the signal.
          const code =
            typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
          if (code !== "ESRCH") {
            console.warn(
              `[WorkspaceHost:${this.serviceName}] Failed to kill host during dispose:`,
              error
            );
          }
        }
        // `this.child` stays set — the `exit` event is the authority on process
        // death and nulls it. Clearing it here would strand that handler.
      }, 1000);
      this.disposeTimer.unref?.();
    }

    this.removeAllListeners();
  }

  private forwardHostOutput(kind: "stdout" | "stderr", chunk: Buffer): void {
    const text = chunk.toString("utf8");
    if (kind === "stdout") {
      this.hostStdoutBuffer += text;
    } else {
      this.hostStderrBuffer += text;
    }

    const MAX_BUFFER = 64 * 1024;
    if (this.hostStdoutBuffer.length > MAX_BUFFER)
      this.hostStdoutBuffer = this.hostStdoutBuffer.slice(-MAX_BUFFER);
    if (this.hostStderrBuffer.length > MAX_BUFFER)
      this.hostStderrBuffer = this.hostStderrBuffer.slice(-MAX_BUFFER);

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
      const message = `[WorkspaceHost] ${trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}…` : trimmed}`;
      if (kind === "stderr") {
        logWarn(message);
      } else {
        logInfo(message);
      }
    }
  }

  private installHostLogForwarding(): void {
    if (!this.child) return;
    this.hostStdoutBuffer = "";
    this.hostStderrBuffer = "";

    const stdout = (this.child as unknown as { stdout?: NodeJS.ReadableStream }).stdout;
    const stderr = (this.child as unknown as { stderr?: NodeJS.ReadableStream }).stderr;

    stdout?.on("data", (chunk: Buffer) => this.forwardHostOutput("stdout", chunk));
    stderr?.on("data", (chunk: Buffer) => this.forwardHostOutput("stderr", chunk));
    // Swallow post-exit pipe errors so an unhandled Readable error can't
    // surface as an uncaughtException after the host is already shutting down.
    stdout?.on("error", () => {});
    stderr?.on("error", () => {});
    // Flush any partial line buffered at close — 'exit' fires before pipes
    // fully drain, so the tail of a crash stack trace can arrive after the
    // exit-time flush would otherwise clear the buffer.
    stdout?.on("close", () => this.flushHostOutputBuffers());
    stderr?.on("close", () => this.flushHostOutputBuffers());
  }

  private flushHostOutputBuffers(): void {
    const stdoutRemainder = this.hostStdoutBuffer.trim();
    if (stdoutRemainder) {
      logInfo(
        `[WorkspaceHost] ${stdoutRemainder.length > 4000 ? `${stdoutRemainder.slice(0, 4000)}…` : stdoutRemainder}`
      );
    }
    const stderrRemainder = this.hostStderrBuffer.trim();
    if (stderrRemainder) {
      logWarn(
        `[WorkspaceHost] ${stderrRemainder.length > 4000 ? `${stderrRemainder.slice(0, 4000)}…` : stderrRemainder}`
      );
    }
    this.hostStdoutBuffer = "";
    this.hostStderrBuffer = "";
  }

  private startHost(): void {
    if (this.isDisposed) return;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    // Defensive: clear any stale crash reason from a prior host cycle. Under
    // normal flow the `exit` handler's setImmediate consumes this, but a
    // missed exit event (or out-of-band listener fire) would otherwise leak
    // into the next crash.
    this.pendingChildProcessGoneReason = null;

    if (this.readyReject && this.isInitialized) {
      this.readyReject(new Error("Workspace Host restarting"));
    }

    this.isInitialized = false;
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // Attach a no-op handler so a fork failure (which rejects readyPromise
    // synchronously inside the catch below) doesn't surface as an unhandled
    // rejection on internal restart paths where no external caller is
    // awaiting. Consumers calling waitForReady() still observe the rejection
    // on their own chain because .catch returns a new branched promise.
    this.readyPromise.catch(() => undefined);

    const electronDir = path.basename(__dirname) === "chunks" ? path.dirname(__dirname) : __dirname;
    const hostPath = path.join(electronDir, "workspace-host-bootstrap.js");

    // Anchor cross-process timing for the host's per-phase marks. The child
    // has its own `performance.timeOrigin`, so we ship a wall-clock-aligned
    // float (sub-ms precision) and let the child subtract.
    const forkAbsMs = performance.timeOrigin + performance.now();
    markPerformance(PERF_MARKS.WORKSPACE_HOST_FORK_DISPATCHED, {
      serviceName: this.serviceName,
    });

    try {
      this.child = utilityProcess.fork(hostPath, [], {
        serviceName: this.serviceName,
        stdio: "pipe",
        cwd: os.homedir(),
        // Redirect v8.setHeapSnapshotNearHeapLimit dumps (set in
        // workspace-host.ts) into the app's logs directory.
        execArgv: [
          // 256 MB was marginal for large multi-worktree projects and let the
          // host OOM-loop (#10729). 512 MB raises the headroom while the slow-OOM
          // detector above surfaces any genuine leak instead of looping silently.
          "--max-old-space-size=512",
          // Cap the young generation: git-status polling churns short-lived
          // strings per poll; an uncapped nursery (RAM-scaled by V8) commits
          // slack per project's host. One host per project multiplies it.
          "--max-semi-space-size=8",
          `--diagnostic-dir=${app.getPath("logs")}`,
          "--report-exclude-env",
        ],
        env: {
          ...(process.env as Record<string, string>),
          DAINTREE_USER_DATA: app.getPath("userData"),
          DAINTREE_UTILITY_PROCESS_KIND: "workspace-host",
          DAINTREE_PERF_FORK_ABS_MS: String(forkAbsMs),
          DAINTREE_PERF_MAIN_BOOT_ABS_MS: String(mainBootAbsMs),
          // Per-instance label so concurrent workspace-host marks (two projects
          // open) remain distinguishable in the shared NDJSON.
          DAINTREE_WORKSPACE_SERVICE_NAME: this.serviceName,
        },
      });
    } catch (error) {
      console.error(`[WorkspaceHost:${this.serviceName}] Failed to fork:`, error);
      if (this.readyReject) {
        const errorMessage = formatErrorMessage(error, "Workspace host failed to fork");
        this.readyReject(new Error(`Workspace host failed to fork: ${errorMessage}`));
        this.readyReject = null;
      }
      this.emit("host-crash", -1);
      return;
    }

    this.installHostLogForwarding();

    this.child.on("message", (msg: WorkspaceHostEvent) => {
      this.handleHostEvent(msg);
    });

    this.child.on("error", (error) => {
      logWarn(`[WorkspaceHost:${this.serviceName}] Error event: ${String(error)}`);
      if (this.readyReject) {
        this.readyReject(new Error(`Workspace host error: ${String(error)}`));
        this.readyReject = null;
      }
      this.emit("host-crash", -1);
    });

    this.child.on("exit", (code) => {
      this.flushHostOutputBuffers();
      // A disposed host exiting is the cooperative path, not a crash — every
      // eviction ends here, so warning on it would read as a fault.
      if (this.isDisposed) {
        logInfo(`[WorkspaceHost:${this.serviceName}] Exited with code ${code} after dispose`);
      } else {
        logWarn(`[WorkspaceHost:${this.serviceName}] Exited with code ${code}`);
      }

      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = null;
      }
      if (this.handshakeTimeout) {
        clearTimeout(this.handshakeTimeout);
        this.handshakeTimeout = null;
      }
      // The host cooperated with `dispose` — retire the force-kill backstop so
      // it cannot signal a pid the OS may have already recycled.
      if (this.disposeTimer) {
        clearTimeout(this.disposeTimer);
        this.disposeTimer = null;
      }
      this.isWaitingForHandshake = false;
      this.missedHeartbeats = 0;
      this.isInitialized = false;
      this.child = null;

      this.broker.clear(
        new BrokerError("HOST_EXITED", "Workspace Host crashed", {
          projectScopeId: this.projectPath,
        })
      );

      if (this.readyReject) {
        this.readyReject(
          new BrokerError("HOST_EXITED", `Workspace Host crashed (exit code ${code})`, {
            projectScopeId: this.projectPath,
          })
        );
        this.readyReject = null;
      }

      if (this.isDisposed) {
        this.pendingChildProcessGoneReason = null;
        return;
      }

      // Fire the recovery signal before restart scheduling so the renderer can
      // reject in-flight requests immediately instead of waiting up to ~10s for
      // the per-request timeout.
      this.emit("host-recovering", code);

      // `exit`/`child-process-gone` ordering race (electron/electron#42283):
      // `exit` often fires before `child-process-gone` for utility-process
      // crashes. Defer the restart decision by one event loop tick so the
      // authoritative reason and exit code can arrive; fall back to the
      // exit-code from the `exit` event when no reason was captured in time.
      setImmediate(() => {
        if (this.isDisposed) {
          this.pendingChildProcessGoneReason = null;
          return;
        }

        const gone = this.pendingChildProcessGoneReason;
        this.pendingChildProcessGoneReason = null;
        // Prefer the authoritative exit code from `child-process-gone` over
        // the (sometimes unreliable) one from `exit` — defense-in-depth for
        // pre-41.0.4 builds and future regressions of the Windows signed/unsigned
        // mangling bug (fixed in electron/electron#50386, landed Electron 41.0.4).
        const reportedCode = gone ? gone.exitCode : code;

        // If `manualRestart()` or some other path already spawned a new host
        // during the defer window, don't schedule a second auto-restart — it
        // would orphan that host.
        if (this.child !== null) return;

        // Time-windowed sliding crash counter. Lazy-prune entries older than
        // the window, then append the current crash. Three crashes within the
        // window trip the cap; crashes spread further apart decay out.
        const crashAt = Date.now();
        this.crashTimestamps = this.crashTimestamps.filter((t) => crashAt - t < CRASH_WINDOW_MS);
        this.crashTimestamps.push(crashAt);

        // Slow-OOM detector: track consecutive crashes that land close together
        // even when they never accumulate three inside the burst window. A short
        // gap from the prior crash increments the counter; a long gap resets it.
        const interCrashGap = this.previousCrashAt !== null ? crashAt - this.previousCrashAt : null;
        if (interCrashGap !== null && interCrashGap < OOM_LOOP_INTERVAL_MS) {
          this.consecutiveShortCrashIntervals++;
        } else {
          this.consecutiveShortCrashIntervals = 0;
        }
        this.previousCrashAt = crashAt;
        const slowOomLoop = this.consecutiveShortCrashIntervals >= OOM_LOOP_THRESHOLD;

        if (this.crashTimestamps.length < CRASH_THRESHOLD && !slowOomLoop) {
          const windowAttempt = this.crashTimestamps.length;
          const cap = Math.min(
            RESTART_CAP_BASE_MS * Math.pow(2, windowAttempt),
            RESTART_CAP_MAX_MS
          );
          const delay =
            RESTART_FLOOR_MS + Math.floor(Math.random() * Math.max(0, cap - RESTART_FLOOR_MS));
          console.log(
            `[WorkspaceHost:${this.serviceName}] Restarting in ${delay}ms (attempt ${windowAttempt}/${CRASH_THRESHOLD - 1} in window)`
          );

          if (this.restartTimer) clearTimeout(this.restartTimer);
          this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            if (this.isDisposed || this.child !== null) return;
            this.startHost();
            if (this.child !== null) {
              this.emit("restarted");
            }
          }, delay);
          this.restartTimer.unref?.();
        } else {
          const cause = slowOomLoop
            ? `slow crash-loop (${this.consecutiveShortCrashIntervals + 1} crashes under ${OOM_LOOP_INTERVAL_MS / 60_000}min apart — likely OOM)`
            : `${CRASH_THRESHOLD} crashes in ${CRASH_WINDOW_MS / 60_000}min`;
          console.error(
            `[WorkspaceHost:${this.serviceName}] Max restart attempts reached (${cause}), giving up`
          );
          this.emit("host-crash", reportedCode);
        }
      });
    });

    this.startHealthCheckInterval();
  }

  private startHealthCheckInterval(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.isHealthCheckPaused || !this.child) return;

    this.missedHeartbeats = 0;

    this.healthCheckInterval = setInterval(() => {
      if (!this.isInitialized || !this.child || this.isHealthCheckPaused) return;

      if (this.missedHeartbeats >= this.MAX_MISSED_HEARTBEATS) {
        const missedMs = this.missedHeartbeats * this.config.healthCheckIntervalMs;
        console.error(
          `[WorkspaceHost:${this.serviceName}] Watchdog: unresponsive for ${missedMs}ms. Force killing.`
        );

        if (this.child.pid) {
          try {
            process.kill(this.child.pid, "SIGKILL");
          } catch {
            // Process may have already exited
          }
        }
        if (this.healthCheckInterval) {
          clearInterval(this.healthCheckInterval);
          this.healthCheckInterval = null;
        }
        this.missedHeartbeats = 0;
        return;
      }

      this.missedHeartbeats++;
      this.send({ type: "health-check" });
    }, this.config.healthCheckIntervalMs);
  }

  /**
   * Register the `child-process-gone` listener once. Filtered to this host's
   * unique per-instance `serviceName` (each WorkspaceHostProcess scopes its
   * own host). The handler only records the reason; the `exit` handler
   * consumes it via setImmediate.
   */
  private registerChildProcessGoneListener(): void {
    if (this.childProcessGoneHandler) return;
    const handler = (_event: Electron.Event, details: Electron.Details): void => {
      if (this.isDisposed) return;
      if (details.type !== "Utility") return;
      // Electron 41 populates `name` from `serviceName` at runtime, but both
      // fields are typed as optional. Accept either to stay resilient to
      // future runtime changes or edge cases where only one is set.
      const matchesHost =
        details.name === this.serviceName || details.serviceName === this.serviceName;
      if (!matchesHost) return;
      this.pendingChildProcessGoneReason = {
        reason: details.reason,
        exitCode: details.exitCode,
      };
    };
    this.childProcessGoneHandler = handler;
    app.on("child-process-gone", handler);
  }

  private handleHostEvent(event: WorkspaceHostEvent): void {
    try {
      this.processHostEvent(event);
    } catch (error) {
      const eventType = (event as { type?: string })?.type ?? "unknown";
      console.error(`[WorkspaceHost:${this.serviceName}] Error processing "${eventType}":`, error);

      const requestId = (event as { requestId?: string })?.requestId;
      if (requestId) {
        this.broker.reject(
          requestId,
          error instanceof Error ? error : new Error(`Event processing failed: ${eventType}`)
        );
      }
    }
  }

  private processHostEvent(event: WorkspaceHostEvent): void {
    if (this.isDisposed) return;

    switch (event.type) {
      case "ready": {
        if (!this.child) return;
        this.isInitialized = true;
        // Do NOT clear `crashTimestamps` here — clearing on ready would
        // defeat the sliding window for a crash-ready-crash-ready loop,
        // where each fresh ready would wipe the history right before the
        // next crash. The window decays lazily at crash-record-time in the
        // `exit` handler. This is the fix for #8553 (preserved) and #8683
        // (no proactive reset timer).

        // Replay every registered provider's credentials into the (re)started
        // host. Pulled from the forge registry so this stays provider-neutral;
        // hosts that become ready before a provider plugin activates are
        // covered by the plugin's activation-time credential push.
        void this.relayForgeCredentialsFromRegistry();

        // Replay cached log-level overrides on every ready (initial + restarts).
        this.send({ type: "set-log-level-overrides", overrides: this.logLevelOverridesCache });

        // Replay the cached fetch-throttle multiplier on every ready — a
        // restarted host would otherwise run unthrottled until the next
        // rate-limit state change, which can be hours away.
        this.send({
          type: "apply-fetch-throttle",
          multiplier: this.fetchThrottleMultiplierCache,
        });

        // Replay the cached provider-matcher table so a restarted host can
        // resolve remote URLs without waiting for the next registry change.
        if (this.forgeProviderMatchersCache !== null) {
          this.send({
            type: "forge-provider-matchers",
            matchers: this.forgeProviderMatchersCache,
          });
        }

        // Replay the merged monitor config so a restarted host doesn't run
        // the in-host balanced defaults until the next profile transition or
        // focus event.
        if (this.monitorConfigCache !== null) {
          this.send({
            type: "update-monitor-config",
            requestId: UNTRACKED_MONITOR_CONFIG_REQUEST_ID,
            config: this.monitorConfigCache,
          });
        }

        if (this.readyResolve) {
          this.readyResolve();
          this.readyResolve = null;
        }
        this.startHealthCheckInterval();
        break;
      }

      case "pong":
        this.missedHeartbeats = 0;
        if (this.isWaitingForHandshake) {
          this.isWaitingForHandshake = false;
          if (this.handshakeTimeout) {
            clearTimeout(this.handshakeTimeout);
            this.handshakeTimeout = null;
          }
          this.startHealthCheckInterval();
        }
        break;

      case "error":
        console.error(`[WorkspaceHost:${this.serviceName}] Host error:`, event.error);
        if (event.requestId) {
          this.broker.reject(event.requestId, new Error(event.error));
        }
        break;

      // Request/response results - resolve pending promises
      case "load-project-result":
      case "sync-result":
      case "project-switch-result":
      case "set-active-result":
      case "refresh-result":
      case "refresh-prs-result":
      case "get-pr-status-result":
      case "reset-pr-state-result":
      case "create-worktree-result":
      case "delete-worktree-result":
      case "fetch-pr-branch-result":
        this.handleRequestResult(event);
        break;

      case "all-states":
        this.handleRequestResult(this.toResult(event, true));
        break;

      case "monitor":
        this.handleRequestResult(this.toResult(event, true));
        break;

      case "fetch-worktree-result":
      case "list-branches-result":
      case "get-recent-branches-result":
      case "get-file-diff-result":
      case "file-tree-result":
      case "resource-action-result":
      case "has-resource-config-result":
      case "update-monitor-config-result":
        this.handleRequestResult(this.toResult(event));
        break;

      case "copytree:complete":
      case "copytree:test-config-result":
        this.handleRequestResult(this.toResult(event, true));
        break;

      case "governance:snapshot-result":
        this.handleRequestResult(this.toResult(event, true));
        break;

      case "copytree:error":
        this.handleRequestResult({
          requestId: event.requestId,
          success: false,
          error: event.error,
        });
        break;

      case "git:project-pulse":
        this.handleRequestResult(this.toResult(event, true));
        break;

      case "git:project-pulse-error":
        this.handleRequestResult(this.toResult(event, false));
        break;

      // Forge RPC request from the workspace-host — dispatch against the
      // local registry and send the result back. Provider impls live here
      // (registered by `PluginService` on plugin activate), so the
      // workspace-host has to round-trip through this server for any PR /
      // CI / rate-limit call. See `docs/architecture/forge-provider-abstraction.md`.
      case "forge:rpc":
        void dispatchForgeRpc(
          {
            forgeRequestId: event.forgeRequestId,
            method: event.method,
            namespacedId: event.namespacedId,
            args: event.args,
          },
          (request) => this.send(request)
        );
        break;

      // Spontaneous events - re-emit for the manager to route. The relay is
      // dumb: it passes `event` through verbatim (including the `silent` flag)
      // and lets WorkspaceHostEventRouter own routing/suppression.
      // `worktree-activated` (router emits to the plugin bus unless silent) and
      // `lifecycle-setup-error` (router calls notifyError) were both dropped
      // here before #10778, so their downstream router cases never fired.
      case "worktree-update":
      case "worktree-removed":
      case "worktree-activated":
      case "pr-detected":
      case "pr-cleared":
      case "issue-detected":
      case "issue-not-found":
      case "lifecycle-setup-error":
      case "copytree:progress":
      case "inotify-limit-reached":
      case "emfile-limit-reached":
      case "watcher-recovered":
      case "topology-watcher-dark":
      case "topology-watcher-recovered":
      case "forge-rate-limit-changed":
      case "forge-token-health-changed":
      case "forge-remote-changed":
        this.emit("host-event", event);
        break;

      // Renderer-only event: the utility process forwards every event to this
      // parent port, but `fetch-auth-failure-confirmed` is consumed solely via
      // the DIRECT_RENDERER_EVENTS MessagePort fan-out (WorktreeStoreContext).
      // There is no WorkspaceHostEventRouter case for it, so it is intentionally
      // not relayed as `host-event`. Swallow it here so it does not trip the
      // `default` "Unknown event" warn — that warn historically flagged a real
      // dropped event and would cause false-alarm triage (#10778).
      case "fetch-auth-failure-confirmed":
        break;

      default:
        console.warn(
          `[WorkspaceHost:${this.serviceName}] Unknown event:`,
          (event as { type: string }).type
        );
    }
  }

  private handleRequestResult(event: {
    requestId: string;
    success?: boolean;
    error?: string;
  }): void {
    if (event.success === false || event.error) {
      this.broker.reject(event.requestId, new Error(event.error || "Operation failed"));
    } else {
      this.broker.resolve(event.requestId, event);
    }
  }

  private toResult<T extends { requestId: string; error?: string }>(
    event: T,
    success?: boolean
  ): T & { success: boolean } {
    return {
      ...event,
      success: success ?? !event.error,
    };
  }
}
