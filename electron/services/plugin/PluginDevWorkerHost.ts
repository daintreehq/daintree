import { utilityProcess, UtilityProcess, app } from "electron";
import { EventEmitter } from "events";
import { createHash } from "crypto";
import fs, { existsSync } from "fs";
import path from "path";
import os from "os";
import { fileURLToPath, pathToFileURL } from "url";
import { createLogger } from "../../utils/logger.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  PLUGIN_DEV_WORKER_KIND,
  PLUGIN_PROD_WORKER_KIND,
} from "../../../shared/types/pluginDevWorker.js";
import type {
  PluginHostToWorkerMessage,
  PluginWorkerToHostMessage,
} from "../../../shared/types/pluginDevWorker.js";

const logger = createLogger("main:PluginDevWorker");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Debounce for `dist/index.js` change events. Vite emits a write (and often a
 * rename) per rebuild; coalesce them so one rebuild triggers one reload. */
const RELOAD_DEBOUNCE_MS = 200;

/** Graceful-dispose grace period before SIGKILL, matching WorkspaceHostProcess. */
const DISPOSE_TIMEOUT_MS = 1000;

// Time-windowed crash-loop guard. Mirrors the constants in PtyHostLifecycle,
// WorkspaceHostProcess, and CrashLoopGuardService so all guards follow the same
// policy: three crashes within the window trip the cap, and crashes spread
// further apart decay out lazily at crash-record-time. Duplicated rather than
// imported because the guards operate at independent layers. The alignment test
// (`crashGuardAlignment.test.ts`) asserts the values stay in lockstep.
//
// Crucially, an intentional reload (mtime change → kill → respawn) is NOT a
// crash: `reload()` clears the crash window before killing, so a developer
// doing rapid saves can never trip the cap. Only an unintended worker exit
// (plugin bootstrap throw, segfault) accumulates toward it.
const CRASH_THRESHOLD = 3;
export const CRASH_WINDOW_MS = 30 * 60 * 1000;

export interface PluginDevWorkerHostOptions {
  pluginId: string;
  /** Plugin directory root (the symlink target). Used as the worker `cwd`. */
  pluginDir: string;
  /** Absolute path to the built bundle (`dist/index.js`) the worker imports. */
  bundlePath: string;
  /**
   * `"dev"` (default) hot-reloads the worker on every `bundlePath` rebuild;
   * `"prod"` runs the same worker without the file watcher (production bundles
   * never rebuild in place, so there is nothing to watch). Crash supervision,
   * fork lifecycle, and graceful dispose are identical in both modes.
   */
  mode?: "dev" | "prod";
  /**
   * Permission-model spike (#10890): extra `execArgv` flags (`--permission`,
   * `--allow-fs-*`, …) appended after the V8 heap cap. Empty/absent (the
   * default) preserves the exact current fork behavior. When present, the worker
   * reports back whether Electron actually honored them (`ready.permission`),
   * which this host logs — the flags are a prototype/measurement, not a boundary.
   */
  permissionExecArgv?: readonly string[];
}

/**
 * Owns the `utilityProcess.fork` lifecycle for one plugin: fork the worker,
 * hand it the bundle to import, and (in `"dev"` mode only) watch `bundlePath`
 * for rebuilds, killing + respawning on each change. Production plugins reuse
 * the same host with `mode: "prod"` and no file watcher. Crash supervision
 * mirrors
 * {@link WorkspaceHostProcess} (sliding crash window, `child-process-gone`
 * filtering, exit/gone ordering defer).
 *
 * Messages from the worker are re-emitted as `worker-message` events; the
 * {@link PluginDevWorkerMainBridge} consumes them and replies via {@link send}.
 * Lifecycle signals are emitted as `ready`, `reloading`, `exit`, and
 * `crash-loop`.
 */
export class PluginDevWorkerHost extends EventEmitter {
  private child: UtilityProcess | null = null;
  private isDisposed = false;
  private isReloading = false;
  readonly pluginId: string;
  private readonly pluginDir: string;
  private readonly bundlePath: string;
  private readonly serviceName: string;
  private readonly mode: "dev" | "prod";
  private readonly workerKind: string;
  /** Spike #10890: permission-model execArgv flags appended at fork time. */
  private readonly permissionExecArgv: readonly string[];

  private watcher: fs.FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private disposeTimer: NodeJS.Timeout | null = null;

  /**
   * Sliding window of recent UNINTENTIONAL crash timestamps. Lazy-pruned to
   * entries within `CRASH_WINDOW_MS` on each crash. Reload-driven exits clear
   * it (see {@link reload}) so deliberate kills never count toward the cap.
   */
  private crashTimestamps: number[] = [];
  /** Set true around an intentional kill so the exit handler skips crash accounting. */
  private expectingExit = false;

  private pendingChildProcessGoneReason: { reason: string; exitCode: number } | null = null;
  private childProcessGoneHandler:
    | ((event: Electron.Event, details: Electron.Details) => void)
    | null = null;

  private readyPromise: Promise<void>;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;

  constructor(options: PluginDevWorkerHostOptions) {
    super();
    this.pluginId = options.pluginId;
    this.pluginDir = options.pluginDir;
    this.bundlePath = options.bundlePath;
    this.mode = options.mode ?? "dev";
    this.workerKind = this.mode === "prod" ? PLUGIN_PROD_WORKER_KIND : PLUGIN_DEV_WORKER_KIND;
    this.permissionExecArgv = options.permissionExecArgv ?? [];

    const safeName = options.pluginId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
    // Hash the plugin dir so two plugins sharing a sanitized name still get
    // distinct service names — otherwise the per-instance `child-process-gone`
    // filter would cross-attribute crashes.
    const dirHash = createHash("sha1").update(options.pluginDir).digest("hex").slice(0, 8);
    this.serviceName = `daintree-plugin-${this.mode}:${safeName}-${dirHash}`;

    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.readyPromise.catch(() => undefined);

    this.registerChildProcessGoneListener();
  }

  /** Fork the worker and begin watching the bundle. Resolves when the worker
   * posts `ready`; rejects on fork failure or premature exit.
   *
   * Deliberately NOT `async`: an async wrapper would adopt `readyPromise`'s
   * state in a *fresh* promise that bypasses the `readyPromise.catch` guard
   * (constructor / {@link startFresh}), so a fire-and-forget caller
   * (`void host.start()`) would surface an unhandled rejection when dispose or
   * a premature exit rejects ready. Returning `readyPromise` directly keeps the
   * guard in effect; `startWorker`/`startWatching` swallow their own errors and
   * never throw synchronously, so awaiting callers still observe rejections. */
  start(): Promise<void> {
    this.startWorker();
    // Production workers never rebuild their bundle in place, so there is
    // nothing to hot-reload — skip the file watcher entirely.
    if (this.mode === "dev") this.startWatching();
    return this.readyPromise;
  }

  isReady(): boolean {
    return this.child !== null;
  }

  /**
   * UtilityProcess pid of the live worker, or null when not running. Lets the
   * governance snapshot join this worker to `app.getAppMetrics()` memory rows.
   */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** Send a message to the worker. Returns false if no live worker. */
  send(message: PluginHostToWorkerMessage): boolean {
    if (!this.child || this.isDisposed) return false;
    try {
      this.child.postMessage(message);
      return true;
    } catch (error) {
      logger.warn(`[${this.serviceName}] Failed to send message`, {
        error: formatErrorMessage(error, "post failed"),
      });
      return false;
    }
  }

  /**
   * Reload the worker: clear the crash window (this is an intentional restart,
   * not a crash), kill the current child, and fork a fresh one once it exits.
   * The new worker re-imports the rebuilt bundle and re-runs `activate`.
   */
  reload(): void {
    if (this.isDisposed) return;
    if (this.isReloading) return;
    this.isReloading = true;

    // Deliberate restart — give future crashes a fresh budget so rapid saves
    // can't trip the crash-loop cap (#7917 manualRestart parallel).
    this.crashTimestamps = [];

    this.emit("reloading");

    if (!this.child) {
      // No live child (e.g. a prior crash gave up); just fork a new one.
      this.isReloading = false;
      this.startFresh();
      return;
    }

    this.killChild(() => {
      if (this.isDisposed) return;
      this.isReloading = false;
      this.startFresh();
    });
  }

  /** Re-arm the ready promise and fork a new worker. */
  private startFresh(): void {
    if (this.isDisposed) return;
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.readyPromise.catch(() => undefined);
    this.startWorker();
  }

  /** Promise that resolves on the next `ready` after a reload. */
  waitForReady(): Promise<void> {
    return this.readyPromise;
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // ignore — watcher may already be closed
      }
      this.watcher = null;
    }
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    if (this.childProcessGoneHandler) {
      app.off("child-process-gone", this.childProcessGoneHandler);
      this.childProcessGoneHandler = null;
    }
    this.pendingChildProcessGoneReason = null;

    if (this.readyReject) {
      this.readyReject(new Error(`Plugin dev worker "${this.pluginId}" disposed`));
      this.readyReject = null;
      this.readyResolve = null;
    }

    if (this.child) {
      this.expectingExit = true;
      // Post directly — `send()` bails once `isDisposed` is set (which we just
      // did), so route around it for the cooperative shutdown message.
      try {
        this.child.postMessage({ type: "dispose" });
      } catch {
        // worker may already be gone; the kill backstop below still fires
      }
      this.disposeTimer = setTimeout(() => {
        this.disposeTimer = null;
        if (this.child) {
          try {
            this.child.kill();
          } catch (error) {
            logger.warn(`[${this.serviceName}] Failed to kill worker during dispose`, {
              error: formatErrorMessage(error, "kill failed"),
            });
          } finally {
            this.child = null;
          }
        }
      }, DISPOSE_TIMEOUT_MS);
      this.disposeTimer.unref?.();
    }

    this.removeAllListeners();
  }

  /** Kill the current child, invoking `onExit` once it's gone. */
  private killChild(onExit: () => void): void {
    const child = this.child;
    if (!child) {
      onExit();
      return;
    }
    this.expectingExit = true;

    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (this.disposeTimer) {
        clearTimeout(this.disposeTimer);
        this.disposeTimer = null;
      }
      onExit();
    };

    // Prefer a cooperative dispose, fall back to kill after the grace period.
    this.send({ type: "dispose" });
    this.disposeTimer = setTimeout(() => {
      this.disposeTimer = null;
      if (this.child === child) {
        try {
          child.kill();
        } catch {
          // already gone
        }
      }
    }, DISPOSE_TIMEOUT_MS);
    this.disposeTimer.unref?.();

    child.once("exit", () => finish());
  }

  private startWatching(): void {
    if (this.watcher || this.isDisposed) return;
    const dir = path.dirname(this.bundlePath);
    const base = path.basename(this.bundlePath);

    // `fs.watch` on the `dist/` dir is preferred — watching the file directly
    // would go stale when Vite replaces it via rename, and filtering by
    // filename coalesces rename+write. But `dist/` may not exist yet when
    // Daintree loads the plugin (Vite hasn't produced the first build). In that
    // case watch the plugin root for `dist/` appearing, then re-arm the real
    // watcher. A single-dir watch is one fd — no recursive-watch fd leak.
    if (existsSync(dir)) {
      try {
        this.watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
          if (filename && filename !== base) return;
          this.scheduleReload();
        });
        this.watcher.on("error", (error) => {
          logger.warn(`[${this.serviceName}] Bundle watcher error`, {
            error: formatErrorMessage(error, "watch failed"),
          });
        });
      } catch (error) {
        logger.warn(`[${this.serviceName}] Failed to watch bundle dir ${dir}`, {
          error: formatErrorMessage(error, "watch failed"),
        });
      }
      return;
    }

    const distName = path.basename(dir);
    try {
      this.watcher = fs.watch(this.pluginDir, { persistent: false }, (_event, filename) => {
        if (filename && filename !== distName) return;
        if (!existsSync(dir)) return;
        // `dist/` now exists — swap to watching it for real, then reload to pick
        // up the freshly-built bundle.
        if (this.watcher) {
          try {
            this.watcher.close();
          } catch {
            // ignore
          }
          this.watcher = null;
        }
        this.startWatching();
        this.scheduleReload();
      });
      this.watcher.on("error", (error) => {
        logger.warn(`[${this.serviceName}] Plugin-dir watcher error`, {
          error: formatErrorMessage(error, "watch failed"),
        });
      });
    } catch (error) {
      logger.warn(`[${this.serviceName}] Failed to watch plugin dir ${this.pluginDir}`, {
        error: formatErrorMessage(error, "watch failed"),
      });
    }
  }

  private scheduleReload(): void {
    if (this.isDisposed) return;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      this.reload();
    }, RELOAD_DEBOUNCE_MS);
    this.reloadTimer.unref?.();
  }

  private startWorker(): void {
    if (this.isDisposed) return;
    this.pendingChildProcessGoneReason = null;
    this.expectingExit = false;

    const electronDir = path.basename(__dirname) === "chunks" ? path.dirname(__dirname) : __dirname;
    // PluginDevWorkerHost lives in electron/services/plugin/, but at build time
    // every host bundle is flattened into electron/ (or electron/chunks/), so
    // the bootstrap resolves relative to the runtime dir, not the source tree.
    const bootstrapPath = path.join(electronDir, "plugin-dev-worker-bootstrap.js");

    try {
      this.child = utilityProcess.fork(bootstrapPath, [], {
        serviceName: this.serviceName,
        stdio: "pipe",
        cwd: this.pluginDir || os.homedir(),
        execArgv: ["--max-old-space-size=256", ...this.permissionExecArgv],
        env: {
          // env REPLACES process.env in a utility process (#6081) — spread first.
          ...(process.env as Record<string, string>),
          DAINTREE_USER_DATA: app.getPath("userData"),
          DAINTREE_UTILITY_PROCESS_KIND: this.workerKind,
          // io_uring disabled on Linux for utility-process stability (#6081).
          ...(process.platform === "linux" ? { UV_USE_IO_URING: "0" } : {}),
        },
      });
    } catch (error) {
      logger.error(`[${this.serviceName}] Failed to fork`, {
        error: formatErrorMessage(error, "fork failed"),
      });
      if (this.readyReject) {
        this.readyReject(
          new Error(`Plugin dev worker failed to fork: ${formatErrorMessage(error, "fork failed")}`)
        );
        this.readyReject = null;
      }
      // A fork failure is a hard non-start, not a crash loop: `start()` rejects
      // and `activateViaDevWorker`'s catch records the (more informative)
      // loadError. Emitting `crash-loop` here would make the bridge write a
      // second, racy "crash loop (code -1)" provenance entry over that one.
      return;
    }

    this.installLogForwarding();

    this.child.on("message", (msg: PluginWorkerToHostMessage) => {
      this.handleWorkerMessage(msg);
    });

    this.child.on("exit", (code) => {
      this.handleExit(code);
    });
  }

  private handleWorkerMessage(msg: PluginWorkerToHostMessage): void {
    if (this.isDisposed) return;
    if (msg.type === "ready") {
      // Spike #10890: record whether Electron honored the permission-model
      // execArgv flags. Only logged when we actually requested them, so a
      // normal fork stays quiet. `honored=false` on Electron 42 is the expected
      // finding — the utility-process bootstrap never runs Node's `--permission`
      // parsing, so the flags are inert (the real boundary stays host.fs realpath
      // containment). This log is the measurement surface the spike asks for.
      if (this.permissionExecArgv.length > 0) {
        logger.info(`[${this.serviceName}] plugin permission model spike`, {
          requested: true,
          honored: msg.permission?.present ?? false,
          flags: this.permissionExecArgv,
        });
      }
      // Re-import the bundle and re-run activate on every (re)start.
      this.send({
        type: "start",
        bundleUrl: pathToBundleUrl(this.bundlePath),
        pluginId: this.pluginId,
      });
      if (this.readyResolve) {
        this.readyResolve();
        this.readyResolve = null;
      }
      this.emit("ready");
      return;
    }
    // All other messages (host-call, host-notify, subscribe, invoke-result,
    // activated, activate-error, error) are routed to the bridge.
    this.emit("worker-message", msg);
  }

  private handleExit(code: number | undefined): void {
    const wasExpected = this.expectingExit;
    this.expectingExit = false;
    this.child = null;

    if (this.readyReject) {
      this.readyReject(new Error(`Plugin dev worker exited (code ${code ?? "unknown"})`));
      this.readyReject = null;
    }

    if (this.isDisposed) {
      this.pendingChildProcessGoneReason = null;
      return;
    }

    // An intentional kill (reload/dispose) is not a crash — emit exit and stop.
    if (wasExpected) {
      this.pendingChildProcessGoneReason = null;
      this.emit("exit", code ?? 0, /* expected */ true);
      return;
    }

    this.emit("exit", code ?? 0, /* expected */ false);

    // `exit`/`child-process-gone` ordering race (electron/electron#42283):
    // defer one tick so the authoritative reason/exit code can arrive.
    setImmediate(() => {
      if (this.isDisposed) {
        this.pendingChildProcessGoneReason = null;
        return;
      }
      const gone = this.pendingChildProcessGoneReason;
      this.pendingChildProcessGoneReason = null;
      const reportedCode = gone ? gone.exitCode : (code ?? -1);

      const crashAt = Date.now();
      this.crashTimestamps = this.crashTimestamps.filter((t) => crashAt - t < CRASH_WINDOW_MS);
      this.crashTimestamps.push(crashAt);

      if (this.crashTimestamps.length >= CRASH_THRESHOLD) {
        logger.error(
          `[${this.serviceName}] Worker crashed ${CRASH_THRESHOLD} times within the window — giving up; edit + save to retry`
        );
        this.emit("crash-loop", reportedCode);
        return;
      }

      logger.warn(
        `[${this.serviceName}] Worker crashed (code ${reportedCode}); respawning (${this.crashTimestamps.length}/${CRASH_THRESHOLD} in window)`
      );
      this.startFresh();
    });
  }

  private registerChildProcessGoneListener(): void {
    if (this.childProcessGoneHandler) return;
    const handler = (_event: Electron.Event, details: Electron.Details): void => {
      if (this.isDisposed) return;
      if (details.type !== "Utility") return;
      // Electron 41+ populates `name` from `serviceName`; accept either for
      // resilience (mirrors WorkspaceHostProcess).
      const matches = details.name === this.serviceName || details.serviceName === this.serviceName;
      if (!matches) return;
      this.pendingChildProcessGoneReason = {
        reason: details.reason,
        exitCode: details.exitCode,
      };
    };
    this.childProcessGoneHandler = handler;
    app.on("child-process-gone", handler);
  }

  private installLogForwarding(): void {
    if (!this.child) return;
    const stdout = (this.child as unknown as { stdout?: NodeJS.ReadableStream }).stdout;
    const stderr = (this.child as unknown as { stderr?: NodeJS.ReadableStream }).stderr;
    const forward = (kind: "stdout" | "stderr", chunk: Buffer): void => {
      const text = chunk.toString("utf8").trimEnd();
      if (!text) return;
      const line = `[plugin-dev:${this.pluginId}] ${text}`;
      if (kind === "stderr") logger.warn(line);
      else logger.info(line);
    };
    stdout?.on("data", (chunk: Buffer) => forward("stdout", chunk));
    stderr?.on("data", (chunk: Buffer) => forward("stderr", chunk));
    stdout?.on("error", () => {});
    stderr?.on("error", () => {});
  }
}

/** Resolve a filesystem path to a `file://` URL the worker can `import()`. */
function pathToBundleUrl(p: string): string {
  return pathToFileURL(path.resolve(p)).href;
}
