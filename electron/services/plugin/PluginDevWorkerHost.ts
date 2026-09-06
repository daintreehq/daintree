import { utilityProcess, UtilityProcess, app } from "electron";
import { EventEmitter } from "events";
import { createHash } from "crypto";
import path from "path";
import os from "os";
import { fileURLToPath, pathToFileURL } from "url";
import { createLogger } from "../../utils/logger.js";
import { minimalWorkerEnv } from "../../utils/minimalSpawnEnv.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  PLUGIN_DEV_WORKER_KIND,
  PLUGIN_PROD_WORKER_KIND,
} from "../../../shared/types/pluginDevWorker.js";
import type { PluginIdentity } from "../../../shared/types/plugin.js";
import type { PluginHostToWorkerMessage } from "../../../shared/types/pluginDevWorker.js";
import { parseWorkerToHostMessage } from "../../schemas/pluginDevWorker.js";

const logger = createLogger("main:PluginDevWorker");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Graceful-dispose grace period before SIGKILL, matching WorkspaceHostProcess. */
const DISPOSE_TIMEOUT_MS = 1000;

/**
 * Budget from a successful fork to the worker's `ready` handshake (#12275).
 * Separate from the activation budget in `PluginService`: this one covers
 * bootstrap, that one the plugin's own `activate()`.
 */
const READY_TIMEOUT_MS = 5000;

// Time-windowed crash-loop guard. Mirrors the constants in PtyHostLifecycle,
// WorkspaceHostProcess, and CrashLoopGuardService so all guards follow the same
// policy: three crashes within the window trip the cap, and crashes spread
// further apart decay out lazily at crash-record-time. Duplicated rather than
// imported because the guards operate at independent layers. The alignment test
// (`crashGuardAlignment.test.ts`) asserts the values stay in lockstep.
//
// Crucially, a rebuild is NOT a crash. A dev rebuild is reconciled by
// PluginService replacing the whole plugin — this host is disposed and a fresh
// one forked with an empty window — so rapid saves can never trip the cap. Only
// an unintended worker exit (plugin bootstrap throw, segfault) accumulates
// toward it.
const CRASH_THRESHOLD = 3;
export const CRASH_WINDOW_MS = 30 * 60 * 1000;

export interface PluginDevWorkerHostOptions {
  pluginId: string;
  /**
   * The plugin's identity as the host knows it, relayed to the worker so the
   * proxy's `host.pluginInfo` answers with the real binding rather than a
   * reconstruction. `projectRoot` in particular cannot be derived from the
   * instance key.
   */
  identity: PluginIdentity;
  /** Plugin directory root (the symlink target). Used as the worker `cwd`. */
  pluginDir: string;
  /**
   * Absolute path to the built bundle (`dist/index.js`) the worker imports.
   * Absent for a commands-only plugin — one with no `main`, whose only
   * executable code is its manifest commands' handler modules (#12274). The
   * worker still forks and boots the harness; it just has nothing to import
   * until a command is dispatched.
   */
  bundlePath?: string;
  /**
   * Distinguishes the two worker kinds for the service name and the
   * utility-process kind label only. Crash supervision, fork lifecycle, and
   * graceful dispose are identical in both modes.
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
 * Owns the `utilityProcess.fork` lifecycle for one plugin: fork the worker and
 * hand it the bundle to import — or nothing to import, for a commands-only
 * plugin whose handler modules are loaded on dispatch instead (#12274). Rebuild detection is deliberately NOT here —
 * a rebuild changes the manifest and the views as well as the backend, so it is
 * reconciled one layer up by {@link PluginDevArtifactWatcher} driving the
 * ordinary dev-load path, which replaces this host along with everything else
 * the plugin contributes (#12277). Crash supervision mirrors
 * {@link WorkspaceHostProcess} (sliding crash window, `child-process-gone`
 * filtering, exit/gone ordering defer).
 *
 * Messages from the worker are re-emitted as `worker-message` events; the
 * {@link PluginDevWorkerMainBridge} consumes them and replies via {@link send}.
 * Messages are validated against the protocol schema before they are forwarded;
 * anything that fails is a terminal, plugin-scoped failure (#12276).
 *
 * Lifecycle signals are emitted as `ready`, `exit`, `crash-loop`, and
 * `protocol-violation`.
 */
export class PluginDevWorkerHost extends EventEmitter {
  private child: UtilityProcess | null = null;
  private isDisposed = false;
  readonly pluginId: string;
  private readonly identity: PluginIdentity;
  private readonly pluginDir: string;
  private readonly bundlePath: string | undefined;
  private readonly serviceName: string;
  private readonly mode: "dev" | "prod";
  private readonly workerKind: string;
  /** Spike #10890: permission-model execArgv flags appended at fork time. */
  private readonly permissionExecArgv: readonly string[];

  private disposeTimer: NodeJS.Timeout | null = null;

  /**
   * Sliding window of recent UNINTENTIONAL crash timestamps. Lazy-pruned to
   * entries within `CRASH_WINDOW_MS` on each crash. A deliberate kill sets
   * {@link expectingExit} and is never recorded.
   */
  private crashTimestamps: number[] = [];
  /** Set true around an intentional kill so the exit handler skips crash accounting. */
  private expectingExit = false;

  /**
   * Latched once this worker has spoken the protocol wrongly. Terminal: the
   * worker is torn down and never respawned, so the latch only ever guards
   * against re-reporting from a message admitted in the same tick.
   */
  private protocolViolated = false;

  private pendingChildProcessGoneReason: { reason: string; exitCode: number } | null = null;
  private childProcessGoneHandler:
    ((event: Electron.Event, details: Electron.Details) => void) | null = null;

  private readyPromise: Promise<void>;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  /** Armed per fork; cleared by `ready`, by an exit, or by dispose. */
  private readyTimer: NodeJS.Timeout | null = null;

  constructor(options: PluginDevWorkerHostOptions) {
    super();
    this.pluginId = options.pluginId;
    this.identity = options.identity;
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

  /** Fork the worker. Resolves when the worker posts `ready`; rejects on fork
   * failure or premature exit.
   *
   * Deliberately NOT `async`: an async wrapper would adopt `readyPromise`'s
   * state in a *fresh* promise that bypasses the `readyPromise.catch` guard
   * (constructor / {@link startFresh}), so a fire-and-forget caller
   * (`void host.start()`) would surface an unhandled rejection when dispose or
   * a premature exit rejects ready. Returning `readyPromise` directly keeps the
   * guard in effect; `startWorker` swallows its own errors and never throws
   * synchronously, so awaiting callers still observe rejections. */
  start(): Promise<void> {
    this.startWorker(/* armDeadline */ true);
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

  /** Re-arm the ready promise and fork a new worker. */
  private startFresh(): void {
    if (this.isDisposed) return;
    // Only re-arm once the previous wait has settled. Re-arming over a still
    // pending resolver would orphan the original `start()` caller forever, and
    // PluginService reads a `start()` rejection as a hard fork failure (#12279).
    // The crash path settles the waiter before it gets here; this keeps that a
    // property of the code rather than of the caller's timing.
    if (!this.readyResolve) {
      this.readyPromise = new Promise((resolve, reject) => {
        this.readyResolve = resolve;
        this.readyReject = reject;
      });
      this.readyPromise.catch(() => undefined);
    }
    this.startWorker(/* armDeadline */ false);
  }

  /** Promise that resolves on the next `ready` after a crash respawn. */
  waitForReady(): Promise<void> {
    return this.readyPromise;
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    this.clearReadyDeadline();
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

  /**
   * @param armDeadline Whether this fork gets a fork-to-ready deadline. True for
   * the fork `start()` is awaiting; false for the supervisor's own crash
   * respawn, which answers to the crash-loop cap instead.
   */
  private startWorker(armDeadline: boolean): void {
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
        // env REPLACES process.env in a utility process (#6081), so everything
        // the worker needs must be in this one object. It is built from the SAME
        // safe-key allowlist as the children a plugin spawns (#11300) rather than
        // the full host env: plugin code runs in here, and the managed-spawn path
        // scrubs secrets specifically to keep them away from it — inheriting them
        // one level up made the "safe" path a formality. A plugin that needs a
        // credential passes it explicitly or goes through a scoped host API.
        env: minimalWorkerEnv({
          DAINTREE_USER_DATA: app.getPath("userData"),
          DAINTREE_UTILITY_PROCESS_KIND: this.workerKind,
          // io_uring disabled on Linux for utility-process stability (#6081).
          ...(process.platform === "linux" ? { UV_USE_IO_URING: "0" } : {}),
        }) as Record<string, string>,
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

    // Bind both listeners to THIS child so a superseded or retiring worker can
    // never speak for the host (#12279).
    const child = this.child;

    child.on("message", (raw: unknown) => {
      // Third-party code can post to `parentPort` directly, so this callback is
      // an untrusted-input boundary. Node re-throws straight out of `emit()`,
      // which lands in `uncaughtException` and takes the whole app into fatal
      // recovery over one plugin's bug (#12276) — so nothing may escape here,
      // including a throw from a synchronous `worker-message` listener.
      //
      // Authority is checked BEFORE validation: a retiring generation's messages
      // are not this host's to read at all, malformed or not, and rejecting one
      // must not tear down the incoming worker that already replaced it.
      if (!this.hasAuthority(child)) return;
      try {
        this.handleWorkerMessage(raw);
      } catch (error) {
        // The report is best-effort — a logger that itself throws must not be
        // the thing that escapes into `uncaughtException`.
        try {
          logger.error(`[${this.serviceName}] Worker message handling threw`, error);
        } catch {
          // swallowed: stopping the worker below is what matters
        }
        this.failProtocolViolation("worker message handling failed");
      }
    });

    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.handleExit(code);
    });

    if (armDeadline) this.armReadyDeadline(child);
  }

  /**
   * Bound the gap between a successful fork and this child's `ready`.
   *
   * `utilityProcess.fork()` only throws for an immediate spawn failure, and
   * Electron merely WARNS a utility process on an unhandled rejection instead of
   * killing it (#10340) — so a worker whose bootstrap throws, or whose import
   * spins, stays alive-but-mute and emits no `exit` to react to. Nothing else
   * bounds that gap: `start()` would stay pending forever, and the in-flight
   * `activationPromises` entry it feeds hangs every later retry with it.
   *
   * Armed for the fork `start()` is AWAITING, because that is what the deadline
   * is for: an awaited bootstrap that never completes hangs its caller, and
   * through it the cached in-flight activation. Deliberately NOT armed for the
   * supervisor's own crash respawn — nobody awaits that fork, so a wedged one
   * hangs no one, and it already answers to the crash-loop cap; a second
   * deadline there would be a competing restart policy layered over the ladder.
   *
   * On expiry the worker is wedged rather than crashing, so it is stopped
   * WITHOUT crash accounting: a bootstrap that never completes must not burn the
   * respawn budget, and the failure has to stay visible to its caller.
   */
  private armReadyDeadline(child: UtilityProcess): void {
    this.clearReadyDeadline();
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (this.isDisposed || this.child !== child) return;
      const message = `Plugin worker "${this.pluginId}" did not become ready within ${READY_TIMEOUT_MS}ms`;
      logger.error(`[${this.serviceName}] ${message}`);
      if (this.readyReject) {
        this.readyReject(new Error(message));
        this.readyReject = null;
        this.readyResolve = null;
      }
      this.expectingExit = true;
      try {
        child.kill();
      } catch {
        // already gone
      }
    }, READY_TIMEOUT_MS);
    this.readyTimer.unref?.();
  }

  private clearReadyDeadline(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
  }

  /**
   * Whether messages from `child` still carry authority.
   *
   * Dispose asks the worker to shut down cooperatively and only force-kills it
   * after a grace period, so a retiring worker stays alive and connected well
   * after the host stopped speaking for it — and its `dispose` handler runs the
   * plugin's cleanup, which can itself call the host. Those calls must not be
   * forwarded: the bridge stamps every host call with the CURRENT generation, so
   * a late prompt, settings/storage write or delegated action from the dead
   * generation would pass every downstream staleness check and commit with full
   * authority (#12279). A rebuild takes the same route — PluginService disposes
   * this host outright and forks a fresh one (#12277).
   *
   * Gating on child identity is self-clearing — a crash respawn's replacement
   * becomes `this.child` and is served immediately, including the host calls its
   * `activate()` makes, so this cannot deadlock activation.
   */
  private hasAuthority(child: UtilityProcess): boolean {
    return !this.isDisposed && this.child === child;
  }

  private handleWorkerMessage(raw: unknown): void {
    if (this.isDisposed || this.protocolViolated) return;

    const parsed = parseWorkerToHostMessage(raw);
    if (!parsed.ok) {
      // Field paths and issue codes only — the offending values stay out of
      // the log, and the reason handed onward becomes user-visible provenance.
      logger.error(
        `[${this.serviceName}] Worker sent a message that violates the protocol`,
        undefined,
        { issues: parsed.issues }
      );
      this.failProtocolViolation("worker sent a malformed message");
      return;
    }
    const msg = parsed.message;

    if (msg.type === "ready") {
      this.clearReadyDeadline();
      // No `expectingExit` guard here, unlike #12282's in-host reload. A child
      // is only ever asked to die by `dispose()`, which sets `isDisposed`
      // first — so both this method and `hasAuthority` have already dropped the
      // message by the time a doomed child's `ready` could reach this branch. A
      // rebuild no longer kills a child from under a live host at all: it
      // replaces the whole plugin one layer up (#12277).
      //
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
        bundleUrl: this.bundlePath ? pathToBundleUrl(this.bundlePath) : undefined,
        pluginId: this.pluginId,
        identity: this.identity,
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

  /**
   * Terminal failure for one plugin instance: the worker is speaking a protocol
   * main does not understand, so stop it rather than keep reading from it.
   *
   * Deliberately NOT routed through the crash window. `crashTimestamps` records
   * the process actually exiting; a live-but-misbehaving worker is a different
   * failure class, and feeding it in would both mis-report the cause and race a
   * second provenance write against the one the bridge is about to make.
   *
   * `dispose()` is what stops it — it sets `isDisposed`, so the exit this
   * triggers is never counted or respawned.
   */
  private failProtocolViolation(reason: string): void {
    if (this.isDisposed) return;
    // Re-entry after the latch still disposes: a first pass whose reporting
    // threw must not leave the misbehaving worker running.
    if (this.protocolViolated) {
      this.dispose();
      return;
    }
    this.protocolViolated = true;
    try {
      logger.error(`[${this.serviceName}] Protocol violation: ${reason}; stopping the worker`);
    } catch {
      // reporting is best-effort; stopping the worker is not
    }
    try {
      if (this.readyReject) {
        this.readyReject(new Error(`Plugin dev worker "${this.pluginId}": ${reason}`));
        this.readyReject = null;
        this.readyResolve = null;
      }
      // The bridge turns this into the plugin's `loadError` and tears its own
      // side down. Emitted before `dispose()`, which drops every listener.
      this.emit("protocol-violation", reason);
    } catch (error) {
      try {
        logger.error(`[${this.serviceName}] protocol-violation listener threw`, error);
      } catch {
        // swallowed
      }
    } finally {
      // Runs with no bridge attached, and however the reporting above went.
      this.dispose();
    }
  }

  private handleExit(code: number | undefined): void {
    this.clearReadyDeadline();
    const wasExpected = this.expectingExit;
    this.expectingExit = false;
    this.child = null;

    // A crash rejects: a worker that dies on load has genuinely failed to
    // activate. A deliberate kill only happens under dispose, which already
    // settled this waiter, so there is nothing left to reject there.
    if (this.readyReject) {
      this.readyReject(new Error(`Plugin dev worker exited (code ${code ?? "unknown"})`));
      this.readyReject = null;
      this.readyResolve = null;
    }

    if (this.isDisposed) {
      this.pendingChildProcessGoneReason = null;
      return;
    }

    // An intentional kill (dispose) is not a crash — emit exit and stop.
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
      // Keep draining after teardown starts (an unread stream stalls the child's
      // exit) but stop decoding and logging it once the worker has been killed
      // for a protocol violation — it has no business writing to the app log on
      // its way out. Narrowed to that case deliberately: a graceful teardown
      // (unload, idle-dispose, quit) runs the plugin's own disposer, and its
      // failures are logged on stderr from there, so gating on `isDisposed`
      // would silently discard a plugin author's broken cleanup.
      if (this.protocolViolated) return;
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
