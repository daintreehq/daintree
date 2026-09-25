// The process-wide backend pieces both boot paths bring up: the first window's
// setup and the windowless Host runtime. Each is started once and shared —
// whichever path gets here first initialises it, the other awaits the same
// promise — so there is never a second pty-host or workspace-host pool.
import { app, webContents } from "electron";
import type { HandlerDependencies } from "../ipc/types.js";
import type { WindowRegistry } from "../window/WindowRegistry.js";
import type { WorkspaceClient } from "../services/WorkspaceClient.js";
import type { WorkspaceHostProcess } from "../services/WorkspaceHostProcess.js";
import { getWorkspaceClient } from "../services/WorkspaceClient.js";
import { getMainProcessWatchdogClient } from "../services/MainProcessWatchdogClient.js";
import { wireWatchdogDisabledBroadcast } from "../window/perWindowInit.js";
import {
  getEarlyPathRefreshPromise,
  isSmokeTest,
  kickOffEarlyPathRefresh,
} from "../setup/environment.js";
import { isE2EFaultMode } from "../setup/runtimeFlags.js";
import { markPerformance } from "../utils/performance.js";
import { PERF_MARKS } from "../../shared/perf/marks.js";
import {
  getMainProcessWatchdogClientRef,
  getPtyClient,
  getWorkspaceClientRef,
  getWorktreePortBrokerRef,
  setMainProcessWatchdogClientRef,
  setWorkspaceClientRef,
  setWorktreePortBrokerRef,
} from "../window/serviceRefs.js";

let ptyHostStart: Promise<void> | null = null;
let workspaceInit: Promise<WorkspaceClient> | null = null;
let workspaceInitSettled = false;
let hostRuntimeActive = false;

/**
 * Set by the Host runtime once it has brought the backend up. Process-wide
 * state then belongs to it rather than to whichever window happens to be open.
 */
export function markHostRuntimeActive(): void {
  hostRuntimeActive = true;
}

export function isHostRuntimeActive(): boolean {
  return hostRuntimeActive;
}

/**
 * Start the external main-process watchdog, then fork the pty-host. The
 * watchdog goes first so a deadlock during the fork is still recoverable; it is
 * fail-open, so its own failure never blocks the fork.
 *
 * The fork waits on the early PATH refresh so node-pty inherits the user's full
 * PATH (#8625), then reaps descendants a previous session left detached before
 * any new host can reuse their PIDs (#12203). Requires the PtyClient to exist
 * (constructed with `deferStart`); a no-op when it is already forked.
 */
export function ensurePtyHostStarted(opts: {
  windowRegistry: WindowRegistry | undefined;
  deferInitialPoolWarm: boolean;
}): Promise<void> {
  if (!isSmokeTest && !getMainProcessWatchdogClientRef()) {
    try {
      // The singleton accessor, so `disposeMainProcessWatchdog()` in
      // shutdown.ts reaches the running instance instead of a no-op.
      const watchdog = getMainProcessWatchdogClient();
      setMainProcessWatchdogClientRef(watchdog);
      wireWatchdogDisabledBroadcast(watchdog, opts.windowRegistry);
    } catch (err) {
      console.error("[MAIN] Failed to start main-process watchdog:", err);
      setMainProcessWatchdogClientRef(null);
    }
  }

  if (ptyHostStart) return ptyHostStart;
  const ptyClient = getPtyClient();
  if (!ptyClient || ptyClient.isHostStarted()) return Promise.resolve();

  ptyHostStart = (async () => {
    // Kicked off here if main.ts never started it; the kickoff is idempotent.
    await (getEarlyPathRefreshPromise() ?? kickOffEarlyPathRefresh());
    try {
      const { reapPersistedLineages } = await import("../services/TerminalLineageLedger.js");
      await reapPersistedLineages(app.getPath("userData"));
    } catch (err) {
      console.warn("[MAIN] Previous-session lineage reap failed:", err);
    }
    // A project-restoring boot drains the pool with set-active-project right
    // after the host is ready, so the homedir warm is skipped (#10393).
    ptyClient.setDeferInitialPoolWarm(opts.deferInitialPoolWarm);
    ptyClient.start();
  })();
  return ptyHostStart;
}

/**
 * Construct the WorkspaceClient, prewarm the given project's host concurrently
 * with the pty-host fork (#8828), and publish the IPC-visible ref only once the
 * pty-host is ready. Per-project hosts otherwise start on demand from
 * `loadProject()`.
 */
export function ensureWorkspaceClient(opts: { prewarmPath?: string }): Promise<WorkspaceClient> {
  // An in-flight init wins over the ref: the ref is published at pty-host
  // ready, before the port broker exists, and a caller must not proceed to
  // broker a worktree port until it does.
  if (workspaceInit) return workspaceInit;
  const existing = getWorkspaceClientRef();
  if (existing) return Promise.resolve(existing);
  workspaceInit = initWorkspaceClient(opts).then(
    (client) => {
      workspaceInitSettled = true;
      return client;
    },
    (err: unknown) => {
      workspaceInit = null;
      throw err;
    }
  );
  return workspaceInit;
}

/** True between the WorkspaceClient's construction starting and it being fully wired. */
export function isWorkspaceClientStarting(): boolean {
  return workspaceInit !== null && !workspaceInitSettled;
}

async function initWorkspaceClient(opts: { prewarmPath?: string }): Promise<WorkspaceClient> {
  const workspaceClient = getWorkspaceClient({
    maxRestartAttempts: 3,
    healthCheckIntervalMs: 10000,
    showCrashDialog: false,
  });

  // Fire-and-forget: a failed or synchronously throwing prewarm must not abort
  // startup — the pool self-heals and `loadProject()` forks on demand.
  try {
    if (opts.prewarmPath) {
      console.log("[MAIN] Prewarming workspace host concurrently with PTY host:", opts.prewarmPath);
      workspaceClient.prewarmProject(opts.prewarmPath);
    }
  } catch (error) {
    console.warn("[MAIN] Workspace host prewarm failed; will fork on demand:", error);
  }

  const ptyClient = getPtyClient();
  if (ptyClient) {
    console.log("[MAIN] Waiting for Pty Host to be ready...");
    try {
      await ptyClient.waitForReady();
      console.log("[MAIN] Pty Host ready");
      markPerformance(PERF_MARKS.SERVICE_INIT_PTY_READY);
    } catch (error) {
      console.error("[MAIN] Pty Host failed to start:", error);
    }
  }

  setWorkspaceClientRef(workspaceClient);

  // PluginService may initialise before or after this point; its
  // pendingWorktreeSubs replay handles either ordering.
  const [pluginServiceResult, portBrokerResult] = await Promise.allSettled([
    import("../services/PluginService.js"),
    import("../services/WorktreePortBroker.js"),
  ]);

  if (pluginServiceResult.status === "fulfilled") {
    try {
      pluginServiceResult.value.pluginService.setWorkspaceClient(workspaceClient);
    } catch (err) {
      console.error("[MAIN] Failed to wire WorkspaceClient into PluginService:", err);
    }
  } else {
    console.error(
      "[MAIN] Failed to wire WorkspaceClient into PluginService:",
      pluginServiceResult.reason
    );
  }

  markPerformance(PERF_MARKS.SERVICE_INIT_WORKSPACE_READY);

  if (!getWorktreePortBrokerRef()) {
    if (portBrokerResult.status === "fulfilled") {
      setWorktreePortBrokerRef(new portBrokerResult.value.WorktreePortBroker());
    } else {
      throw portBrokerResult.reason;
    }
  }

  workspaceClient.on("host-crash", (code: number) => {
    console.error(`[MAIN] Workspace Host crashed with code ${code}`);
  });

  workspaceClient.on(
    "host-restarted",
    ({ projectPath, host }: { projectPath: string; host: WorkspaceHostProcess }) => {
      const worktreePortBroker = getWorktreePortBrokerRef();
      if (!worktreePortBroker) return;
      const wcIds = worktreePortBroker.closePortsForHost(projectPath);
      if (wcIds.length > 0) {
        const reBrokered = worktreePortBroker.reBrokerForHost(
          host,
          (wcId: number) => webContents.fromId(wcId) ?? undefined,
          wcIds
        );
        console.log(
          `[MAIN] Re-brokered ${reBrokered}/${wcIds.length} worktree port(s) after host restart`
        );
      }
      if (isE2EFaultMode) {
        const g = globalThis as Record<string, unknown>;
        const current =
          typeof g.__daintreeWorkspaceHostRestartCount === "number"
            ? g.__daintreeWorkspaceHostRestartCount
            : 0;
        g.__daintreeWorkspaceHostRestartCount = current + 1;
      }
    }
  );

  return workspaceClient;
}

const WINDOW_SCOPED_DEPS = [
  "mainWindow",
  "eventBuffer",
  "portalManager",
  "projectSwitchService",
  "projectViewManager",
] as const satisfies readonly (keyof HandlerDependencies)[];

/**
 * IPC handlers are registered once, with one HandlerDependencies object they
 * keep reading for the life of the process. The windowed boot registers the
 * first window's; the Host runtime registers one with no window. When a window
 * attaches to the latter, its window-scoped fields are taken over so the
 * handlers see what they would have if that window had booted first. A Host
 * outlives its windows, so once the adopted window is destroyed the next one
 * to attach replaces all of them together.
 */
export function adoptWindowHandlerDeps(
  registered: HandlerDependencies,
  fromWindow: HandlerDependencies,
  opts: { force?: boolean } = {}
): void {
  const current = registered.mainWindow;
  const replace = opts.force === true || (current !== undefined && current.isDestroyed());
  for (const key of WINDOW_SCOPED_DEPS) {
    if ((replace || registered[key] === undefined) && fromWindow[key] !== undefined) {
      (registered as Record<string, unknown>)[key] = fromWindow[key];
    }
  }
}

/**
 * Tracks the windows attached to a windowless IPC registration so that when
 * the window whose fields were adopted closes, a surviving window's take over
 * at once rather than at the next window's setup.
 */
export function createWindowDepsAdopter(registered: HandlerDependencies): {
  attach(windowId: number, deps: HandlerDependencies): void;
  detach(windowId: number): void;
} {
  const attached = new Map<number, HandlerDependencies>();
  return {
    attach(windowId, deps) {
      attached.set(windowId, deps);
      adoptWindowHandlerDeps(registered, deps);
    },
    detach(windowId) {
      const leaving = attached.get(windowId);
      attached.delete(windowId);
      if (!leaving || registered.mainWindow !== leaving.mainWindow) return;
      for (const deps of attached.values()) {
        if (deps.mainWindow && !deps.mainWindow.isDestroyed()) {
          adoptWindowHandlerDeps(registered, deps, { force: true });
          return;
        }
      }
    },
  };
}

export function _resetHostServicesForTest(): void {
  ptyHostStart = null;
  workspaceInit = null;
  workspaceInitSettled = false;
  hostRuntimeActive = false;
}
