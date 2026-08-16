// eager-import-allow: multi-window service initialization
import { app, BrowserWindow, dialog, webContents } from "electron";
import os from "os";
import { registerIpcHandlers, sendToRenderer } from "../ipc/handlers.js";
import { getAppWebContents } from "./webContentsRegistry.js";
import { distributePortsToView } from "./portDistribution.js";
import { registerErrorHandlers, flushPendingErrors } from "../ipc/errorHandlers.js";
import { getWorkspaceClient } from "../services/WorkspaceClient.js";
import { CHANNELS } from "../ipc/channels.js";
import { createApplicationMenu, handleDirectoryOpen } from "../menu.js";
import { refreshProjectMenuState } from "../projectMenuState.js";
import { notificationService } from "../services/NotificationService.js";
import { getMainProcessWatchdogClient } from "../services/MainProcessWatchdogClient.js";
import { projectStore } from "../services/ProjectStore.js";
import { scratchStore } from "../services/ScratchStore.js";
import { initializeAgentAvailabilityStore } from "../services/AgentAvailabilityStore.js";
import { initializePowerSaveBlockerService } from "../services/PowerSaveBlockerService.js";
import { runSmokeFunctionalChecks } from "../services/smokeTest.js";
import { markPerformance } from "../utils/performance.js";
import { getCurrentDiskSpaceStatus } from "../services/DiskSpaceMonitor.js";
import { PERF_MARKS } from "../../shared/perf/marks.js";
import { isCleaningUp } from "../lifecycle/shutdownCoordinator.js";
import {
  runStartupWorktreeLoad,
  selectStatusTarget,
  sendStartupWorktreeLoadFailure,
} from "./startupWorktreeLoad.js";
import { extractRestorePanelCwds } from "./restorePanelCwds.js";
import { mergeProjectEnv } from "./restoreProjectEnv.js";
import { store } from "../store.js";
import {
  isSmokeTest,
  smokeTestStart,
  getEarlyPathRefreshPromise,
  kickOffEarlyPathRefresh,
  getPendingOpenDirPaths,
  queuePendingOpenDirPath,
} from "../setup/environment.js";
import { shouldDeferRendererLoadForE2E } from "./earlyRenderer.js";
import { isE2EFaultMode } from "../setup/runtimeFlags.js";
import {
  extractCliPath,
  hasCliPathFlag,
  getPendingCliPath,
  setPendingCliPath,
  extractDntrPaths,
  extractDirectoryPaths,
  queueDntrPaths,
} from "../lifecycle/appLifecycle.js";
import type { WindowContext, WindowRegistry } from "./WindowRegistry.js";
import { getWindowRegistry } from "./windowRef.js";
import { installOpenDirConsumer, drainPendingOpenDirs } from "./openDirHandler.js";
import { resetDeferredQueue } from "./deferredInitQueue.js";
import { initGlobalServices } from "./globalServicesInit.js";
import { initPerWindowServices, wireWatchdogDisabledBroadcast } from "./perWindowInit.js";
import {
  getPtyClient,
  getWorkspaceClientRef,
  setWorkspaceClientRef,
  getWorktreePortBrokerRef,
  setWorktreePortBrokerRef,
  getCliAvailabilityServiceRef,
  getMainProcessWatchdogClientRef,
  setMainProcessWatchdogClientRef,
  getCleanupErrorHandlers,
  setCleanupErrorHandlers,
  setCleanupIpcHandlers,
  getProcessArgvCliHandled,
  setProcessArgvCliHandled,
  getProcessArgvDntrHandled,
  getProcessArgvDirectoryHandled,
  setProcessArgvDirectoryHandled,
  setProcessArgvDntrHandled,
  getIpcHandlersRegistered,
  setIpcHandlersRegistered,
  getGlobalServicesInitialized,
} from "./serviceRefs.js";

// Re-export the public getters/setters so existing import paths in main.ts,
// menu.ts, and shutdown.ts (via main.ts wiring) continue to resolve through
// `./window/windowServices.js`. The underlying state lives in serviceRefs.ts.
export {
  getPtyClient,
  setPtyClientRef,
  getMainProcessWatchdogClientRef,
  getWorkspaceClientRef,
  getWorktreePortBrokerRef,
  getCliAvailabilityServiceRef,
  getCleanupIpcHandlers,
  setCleanupIpcHandlers,
  getCleanupErrorHandlers,
  setCleanupErrorHandlers,
  getStopEventLoopLagMonitor,
  setStopEventLoopLagMonitor,
  getStopProcessMemoryMonitor,
  setStopProcessMemoryMonitor,
  getStopAppMetricsMonitor,
  setStopAppMetricsMonitor,
  getStopDiskSpaceMonitor,
  setStopDiskSpaceMonitor,
} from "./serviceRefs.js";

const DEFAULT_TERMINAL_ID = "default";

// Folder-drop open dependencies for macOS `open-file` directories (#10976).
// Stable singletons, so the deps object is module-level; the install-once guard
// lives in openDirHandler.ts.
const openDirDeps = {
  openDirectory: (dirPath: string, win: BrowserWindow) =>
    handleDirectoryOpen(dirPath, win, getCliAvailabilityServiceRef() ?? undefined),
  resolvePrimaryWindow: () => getWindowRegistry()?.getPrimary()?.browserWindow,
};

function createAndDistributePorts(win: BrowserWindow, ctx: WindowContext): void {
  const wc = getAppWebContents(win);
  distributePortsToView(win, ctx, wc, getPtyClient());
}

export interface SetupWindowServicesOptions {
  loadRenderer: (reason: string, projectId?: string) => void;
  smokeTestTimer: ReturnType<typeof setTimeout> | undefined;
  smokeRendererUnresponsive: () => boolean;
  windowRegistry?: WindowRegistry;
  initialProjectPath?: string;
  /** Last-active projectId read before window creation for session partition assignment */
  initialProjectId?: string;
  projectViewManager?: import("./ProjectViewManager.js").ProjectViewManager;
  initialAppView?: import("electron").WebContentsView;
}

/**
 * @returns "ok" when the window is fully wired.
 *
 *   "exit-requested" when the process is already on its way out — fatally
 *   failed global init, or a finished smoke run — and `app.exit()` has been
 *   issued. "not-registered" when the window never reached the registry, so it
 *   has no services at all.
 *
 *   Callers that create more than one window (the startup restore fan-out,
 *   #11492) must stop on anything but "ok" rather than build windows into a
 *   dying process — or count a serviceless window as a restored one and persist
 *   it. Single-window callers can ignore the result.
 */
export async function setupWindowServices(
  win: BrowserWindow,
  opts: SetupWindowServicesOptions
): Promise<"ok" | "exit-requested" | "not-registered"> {
  const windowRegistry = opts.windowRegistry;
  const ctx = windowRegistry?.getByWindowId(win.id);
  if (!ctx) {
    console.error("[MAIN] Window not registered before setupWindowServices — skipping");
    return "not-registered";
  }

  markPerformance(PERF_MARKS.WINDOW_SERVICES_START);

  // ── One-time global initialization (first window only) ──
  if (!getGlobalServicesInitialized()) {
    const result = await initGlobalServices(windowRegistry);
    if (result === "exit-requested") return "exit-requested";
  }

  // ── Per-window initialization ──
  const handlerDeps = await initPerWindowServices(win, ctx, windowRegistry);
  const cliAvailabilityService = getCliAvailabilityServiceRef();

  // Publish the ProjectViewManager BEFORE the IPC handlers below go live, and
  // well before loadRenderer(). Published late, there was a window in which the
  // renderer could already invoke `project:switch` while the handlers still saw
  // no manager — the switch then took the legacy (non-PVM) path, which moves the
  // renderer to another project without binding its webContents to it. The
  // initial-view registration further down would then bind that renderer to the
  // project we restored, and every later switch would persist the layout it is
  // really showing under the stale one (#11101). Publishing here means a switch
  // that early is handled by the manager, which binds views as it swaps them.
  if (opts.projectViewManager) {
    handlerDeps.projectViewManager = opts.projectViewManager;
    ctx.services.projectViewManager = opts.projectViewManager;
  }

  console.log("[MAIN] Registering IPC handlers...");

  // IPC handlers are globally scoped — register only once. PluginService
  // initialization moved to a deferred task in globalServicesInit.ts; the
  // plugin IPC handlers registered above return empty lists until init
  // completes, and contribution broadcasts populate the renderer when ready.
  if (!getIpcHandlersRegistered()) {
    setIpcHandlersRegistered(true);
    setCleanupIpcHandlers(registerIpcHandlers(handlerDeps));
    markPerformance(PERF_MARKS.SERVICE_INIT_IPC_READY);
  }

  // Default boot path: the did-finish-load handler is registered and
  // loadRenderer() fires before the workspace/PTY init block, so first
  // paint stops waiting on the PTY handshake. Two paths fall back to the
  // serial after-services-ready trigger: smoke tests (deterministic
  // readiness checks) and the E2E DAINTREE_E2E_DEFER_RENDERER_LOAD opt-in,
  // which keeps the WebContentsView load behind the BrowserWindow sentinel
  // for Playwright's CDP handshake.
  const deferRendererLoadForE2E = shouldDeferRendererLoadForE2E();

  let rendererLoadStarted = false;
  // True once a port pair has been distributed with a live PtyClient (the
  // client queues ports internally until the host is running, so "client
  // exists" is sufficient). Lets the post-services block below skip its
  // redundant re-distribution, which would discard the pair the renderer is
  // already holding.
  let ptyPortsWired = false;
  const startRendererLoad = (reason: string): void => {
    if (rendererLoadStarted) return;
    rendererLoadStarted = true;

    // Handle reloads (per-window) — listen on the app view's webContents.
    // MUST be attached BEFORE loadRenderer() to avoid missing the first did-finish-load.
    const appWc = getAppWebContents(win);
    appWc.on("did-finish-load", () => {
      const currentUrl = appWc.getURL();
      if (currentUrl.includes("recovery.html")) {
        console.log("[MAIN] Recovery page loaded, skipping normal renderer bootstrap");
        return;
      }
      console.log("[MAIN] Renderer loaded, ensuring MessagePort connection...");
      if (isSmokeTest) console.error("[SMOKE] CHECK: Renderer did-finish-load — OK");
      markPerformance(PERF_MARKS.RENDERER_READY);
      createAndDistributePorts(win, ctx);
      if (getPtyClient()) {
        ptyPortsWired = true;
      }
      // Re-register the renderer in directPortViews on reload so
      // sendToEntryWindows continues routing host events to it. With
      // early-renderer mode (default), workspaceClient may still be null on
      // the first did-finish-load — the initial registration is performed by
      // the loadProject() path below once the workspace host is ready.
      const workspaceClient = getWorkspaceClientRef();
      if (workspaceClient) {
        workspaceClient.attachDirectPort(win.id, appWc);

        // Re-broker worktree port for initial view reload
        const worktreePortBroker = getWorktreePortBrokerRef();
        if (worktreePortBroker) {
          const host = workspaceClient.getHostForWindow(win.id);
          if (host) {
            worktreePortBroker.brokerPort(host, appWc);
          }
        }
      }
      flushPendingErrors();
      const diskStatus = getCurrentDiskSpaceStatus();
      if (diskStatus.status !== "normal") {
        sendToRenderer(win, CHANNELS.EVENTS_PUSH, {
          name: "window:disk-space-status",
          payload: diskStatus,
        });
      }
    });

    opts.loadRenderer(reason, opts.initialProjectId);
  };

  if (!deferRendererLoadForE2E && !isSmokeTest) {
    console.log("[MAIN] Loading renderer in parallel with PTY init");
    startRendererLoad("early-renderer");
  } else if (deferRendererLoadForE2E) {
    console.log("[MAIN] E2E renderer-load deferral enabled — waiting for services");
  }

  // Initial menu build, unconditional and synchronous: after the renderer-load
  // kick-off so the native Menu.buildFromTemplate/setApplicationMenu work no
  // longer delays the load dispatch, but before the first await so it can
  // never lose a race with the deferred cli-availability-check /
  // plugin-menu-rebuild rebuilds and clobber the availability-aware menu. On
  // already-drained queues (second windows) those rebuilds may run first and
  // this build harmlessly rebuilds from the same cached availability/plugin
  // state. The smoke and DAINTREE_E2E_DEFER_RENDERER_LOAD paths get the menu
  // here too, before their serial startRendererLoad below.
  console.log("[MAIN] Creating application menu (initial, no agent availability yet)...");
  createApplicationMenu(win, cliAvailabilityService ?? undefined);

  // Start the external main-process watchdog before ptyClient.start() so a
  // deadlock during PTY host fork (worst case: a synchronous spawn that
  // hangs) is still recoverable — that pre-fork ordering is the watchdog's
  // only invariant, which is why it lives here with the fork rather than
  // pre-renderer-load in initPerWindowServices. The watchdog is fail-open:
  // if its own fork throws, PtyClient still starts normally.
  if (!isSmokeTest && !getMainProcessWatchdogClientRef()) {
    try {
      // Use the singleton accessor so `disposeMainProcessWatchdog()` in
      // shutdown.ts reaches the running instance instead of a no-op.
      const watchdog = getMainProcessWatchdogClient();
      setMainProcessWatchdogClientRef(watchdog);
      wireWatchdogDisabledBroadcast(watchdog, windowRegistry);
    } catch (err) {
      console.error("[MAIN] Failed to start main-process watchdog:", err);
      setMainProcessWatchdogClientRef(null);
    }
  }

  // Fork the PTY host now — *after* startRendererLoad — so first paint is no
  // longer blocked by the early PATH refresh (#8827). PtyClient was constructed
  // with `deferStart` in initPerWindowServices, so the host has not forked yet.
  // We await the early PATH refresh here, immediately before forking, so
  // node-pty inherits the user's full PATH (the #8625 invariant: PATH refresh →
  // PTY fork). Awaiting a settled promise is a no-op; on the P95 path the probe
  // resolved in ~50ms during the renderer bundle load, so the host forks before
  // the renderer hydrates. First window only — `start()` is idempotent and
  // `isHostStarted()` short-circuits subsequent windows.
  const ptyClient = getPtyClient();
  if (ptyClient && !ptyClient.isHostStarted()) {
    // Fall back to kicking off the refresh here if it was never started (e.g. a
    // custom entry path that skips main.ts's app.whenReady kickoff). The kickoff
    // is idempotent — it returns the cached promise when already running — so
    // this never double-runs the probe and guarantees the #8625 invariant holds
    // before the fork rather than silently skipping it on a null promise.
    await (getEarlyPathRefreshPromise() ?? kickOffEarlyPathRefresh());
    // Project-restoring boots send set-active-project with a project path
    // right after the host is ready, draining the pool — tell the host to
    // skip the homedir warm those drains would immediately kill (#10393).
    // The host falls back to a homedir warm if the restore falls through.
    // Keyed on initialProjectId only: path-only boots (CLI open) send
    // set-active-project(null) before the project-switch, which would fire
    // the fallback homedir warm and waste the deferral anyway.
    ptyClient.setDeferInitialPoolWarm(Boolean(opts.initialProjectId));
    ptyClient.start();
  }

  // Initialize workspace client (first window only) — per-project hosts
  // are started on-demand when loadProject() is called, not at init time.
  //
  // Captured once here so the worktree-load gate near the end of this function
  // uses the same instance rather than re-reading the module ref across the two
  // `Promise.allSettled` gaps below (#11818). The construction path is
  // first-window-only, so on later windows this capture is the ref read that
  // used to happen at the gate. Whether the ref is actually cleared mid-boot on
  // the reported packaged-Windows launches is unconfirmed — capturing removes
  // the possibility either way, and the gate now reports every outcome that
  // leaves the renderer without a port regardless of cause.
  let capturedWorkspaceClient = getWorkspaceClientRef();
  if (!capturedWorkspaceClient) {
    // Construct the workspace client and prewarm its per-project host
    // concurrently with the PTY host fork. The two utility processes load
    // native modules independently (node-pty vs better-sqlite3 + @parcel/watcher)
    // and share no IPC/memory, so dispatching the workspace host fork while we
    // await PTY-ready overlaps the two native loads instead of serializing them
    // behind the PTY handshake (#8828).
    const workspaceClient = getWorkspaceClient({
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 10000,
      showCrashDialog: false,
    });

    // Resolve the project path this window will load so the workspace host can
    // start forking now. getProjectById is a synchronous SQLite read on the
    // already-open shared DB, so it's safe before projectStore.initialize().
    // Derivation + dispatch are wrapped together: a failed lookup or a
    // synchronous prewarm error must not abort startup — the host self-heals
    // and loadProject() forks a fresh one later if needed.
    try {
      const prewarmPath =
        opts.initialProjectPath ??
        (opts.initialProjectId
          ? projectStore.getProjectById(opts.initialProjectId)?.path
          : undefined);
      if (prewarmPath) {
        console.log("[MAIN] Prewarming workspace host concurrently with PTY host:", prewarmPath);
        // Fire-and-forget: prewarmProject sets up the host initPromise and a
        // dormant-cleanup timer; async failure self-heals inside the pool.
        workspaceClient.prewarmProject(prewarmPath);
      }
    } catch (error) {
      console.warn("[MAIN] Workspace host prewarm failed; will fork on demand:", error);
    }

    console.log("[MAIN] Waiting for Pty Host to be ready...");
    try {
      await ptyClient!.waitForReady();
      console.log("[MAIN] Pty Host ready");
      markPerformance(PERF_MARKS.SERVICE_INIT_PTY_READY);
    } catch (error) {
      console.error("[MAIN] Pty Host failed to start:", error);
    }

    setWorkspaceClientRef(workspaceClient);
    capturedWorkspaceClient = workspaceClient;

    // Give PluginService the WorkspaceClient reference now that it's ready.
    // initialize() is deferred and may run before or after this point — the
    // service's pendingWorktreeSubs replay handles either ordering. The two
    // imports are independent; load them concurrently with per-module error
    // isolation.
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

    // Create WorktreePortBroker alongside WorkspaceClient
    if (!getWorktreePortBrokerRef()) {
      if (portBrokerResult.status === "fulfilled") {
        setWorktreePortBrokerRef(new portBrokerResult.value.WorktreePortBroker());
      } else {
        throw portBrokerResult.reason;
      }
    }

    handlerDeps.worktreeService = workspaceClient;
    handlerDeps.worktreePortBroker = getWorktreePortBrokerRef() ?? undefined;

    workspaceClient.on("host-crash", (code: number) => {
      console.error(`[MAIN] Workspace Host crashed with code ${code}`);
    });

    // Re-broker worktree ports when a workspace host restarts
    workspaceClient.on(
      "host-restarted",
      ({
        projectPath,
        host,
      }: {
        projectPath: string;
        host: import("../services/WorkspaceHostProcess.js").WorkspaceHostProcess;
      }) => {
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
  }

  const { armRestoreQuota } = await import("../ipc/utils.js");
  armRestoreQuota(50, 120_000);

  // On the default path the RENDERER_READY mark can fire before this point,
  // since the renderer is loading concurrently with workspace init.
  markPerformance(PERF_MARKS.SERVICE_INIT_COMPLETE);
  // Serial fallback: smoke tests and the E2E deferral path land here after
  // workspace + PTY are ready. With the default path this is a
  // no-op (already started above).
  startRendererLoad("after-services-ready");

  // Error handlers also use ipcMain.handle — register once
  if (!getCleanupErrorHandlers()) {
    setCleanupErrorHandlers(registerErrorHandlers(getWorkspaceClientRef(), getPtyClient()));
  }

  console.log("[MAIN] All critical services ready");

  // Wait for remaining services
  console.log("[MAIN] Waiting for remaining services to initialize...");
  let ptyReady = false;
  // Workspace client is always "ready" — per-project hosts start on-demand via loadProject()
  const workspaceReady = true;

  // Scratch store init is not needed for first interaction — fire-and-forget
  // so it doesn't gate critical-path readiness. createScratch() does its own
  // recursive mkdir, so the root dir doesn't have to exist before IPC handlers
  // register.
  scratchStore.initialize().catch((err) => {
    console.warn("[MAIN] Scratch store init failed:", err);
  });

  // Read saved panel cwds concurrently with PTY/store init so the warm hint is
  // ready the instant `setActiveProject` fires — typically before the renderer
  // hydrates and starts requesting restore spawns (best-effort: a spawn that
  // races ahead simply misses the pool and cold-spawns, as it did pre-fix).
  // getProjectState reads directly by configDir+projectId (no dependency on
  // projectStore.initialize's in-memory list), so racing it against
  // initialize() is safe.
  let restorePanelCwds: string[] = [];
  // Merged env (global + project) for the pty-host's non-empty envHash warm
  // (#9810). Computed from the same store reads above; on any failure the warm
  // path falls back to whatever global env we can read; if both reads fail
  // the env-empty warm path runs. We read settings concurrently because the
  // project state path already calls into the settings manager.
  let restoreProjectEnv: Record<string, string> | null = null;

  try {
    const results = await Promise.allSettled([
      getPtyClient()!.waitForReady(),
      projectStore.initialize(),
      opts.initialProjectId
        ? projectStore.getProjectState(opts.initialProjectId)
        : Promise.resolve(null),
      opts.initialProjectId
        ? projectStore.getProjectSettings(opts.initialProjectId)
        : Promise.resolve(null),
    ]);

    ptyReady = results[0].status === "fulfilled";
    const projectStoreReady = results[1].status === "fulfilled";
    if (results[2].status === "fulfilled") {
      restorePanelCwds = extractRestorePanelCwds(results[2].value);
    }
    const globalEnv = store.get("globalEnvironmentVariables") as Record<string, string>;
    const projectEnv =
      results[3].status === "fulfilled"
        ? ((results[3].value?.environmentVariables as Record<string, string> | undefined) ??
          undefined)
        : undefined;
    restoreProjectEnv = mergeProjectEnv(globalEnv, projectEnv);

    if (ptyReady && workspaceReady && projectStoreReady) {
      console.log("[MAIN] All critical services ready");
    } else {
      const failures: string[] = [];
      if (!ptyReady)
        failures.push(
          `PTY service: ${results[0].status === "rejected" ? results[0].reason?.message || "unknown error" : "timeout"}`
        );
      if (!projectStoreReady)
        failures.push(
          `Project store: ${results[1].status === "rejected" ? results[1].reason?.message || "unknown error" : "timeout"}`
        );

      console.error("[MAIN] Service initialization failed:", failures);

      dialog
        .showMessageBox(win, {
          type: "error",
          title: "Service Initialization Failed",
          message: `One or more services failed to start:\n\n${failures.join("\n")}\n\nThe application will continue in degraded mode. Some features may be unavailable.\n\nTry restarting the application if problems persist.`,
          buttons: ["OK"],
        })
        .catch(console.error);
    }
  } catch (error) {
    console.error("[MAIN] Unexpected error during service initialization:", error);
  }

  // Per-window project binding: use opts.initialProjectId/initialProjectPath
  // instead of the global current project (which belongs to another window).
  const restoreProject = opts.initialProjectId
    ? projectStore.getProjectById(opts.initialProjectId)
    : undefined;

  // A Linux file manager launching a cold Daintree via "Open With" on a folder
  // puts a `file://` directory URI in argv. Classified here — outside the PTY
  // gate below — so a degraded-mode launch still honours the request, and
  // queued into the same pre-window store the macOS `open-file` drops use so
  // `drainPendingOpenDirs` opens it. An explicit `--cli-path` suppresses the
  // scan, mirroring `second-instance`, so one launch is never routed twice —
  // gated on the flag rather than a resolved path, both so an unresolvable
  // `--cli-path` isn't quietly replaced by a positional URI and so this doesn't
  // become a second `extractCliPath` call that re-reports the same failure.
  let coldDirectoryPaths: string[] = [];
  if (!getProcessArgvDirectoryHandled()) {
    setProcessArgvDirectoryHandled(true);
    coldDirectoryPaths = hasCliPathFlag(process.argv) ? [] : extractDirectoryPaths(process.argv);
    for (const dirPath of coldDirectoryPaths) {
      queuePendingOpenDirPath(dirPath);
    }
  }

  // PTY-related features
  if (ptyReady) {
    const pty = getPtyClient()!;
    // Skip when the did-finish-load handler already distributed a pair with a
    // live PtyClient — re-distributing here would close the renderer's ports.
    if (!ptyPortsWired) {
      createAndDistributePorts(win, ctx);
    }

    if (restoreProject) {
      pty.setActiveProject(
        win.id,
        restoreProject.id,
        restoreProject.path,
        restorePanelCwds,
        restoreProjectEnv
      );
    } else {
      pty.setActiveProject(win.id, null);
    }

    initializeAgentAvailabilityStore();
    initializePowerSaveBlockerService();
    console.log("[MAIN] AgentAvailabilityStore and PowerSaveBlocker initialized");

    const processArgvCli = !getProcessArgvCliHandled()
      ? extractCliPath(process.argv, process.cwd())
      : null;
    const skipDefaultSpawn =
      opts.initialProjectPath ||
      processArgvCli ||
      getPendingCliPath() ||
      restoreProject ||
      getPendingOpenDirPaths().length > 0;
    if (skipDefaultSpawn) {
      console.log(
        "[MAIN] CLI path, initial project path, or existing project set, skipping default terminal spawn"
      );
    } else {
      const terminalId = `${DEFAULT_TERMINAL_ID}-${win.id}`;
      console.log("[MAIN] Spawning default terminal:", terminalId);
      try {
        pty.spawn(terminalId, {
          cwd: os.homedir(),
          cols: 80,
          rows: 30,
        });
      } catch (error) {
        console.error("[MAIN] Failed to spawn default terminal:", error);
      }
    }
  } else {
    console.warn("[MAIN] PTY service unavailable - skipping terminal setup");
  }

  // Register the initial view with ProjectViewManager — only when this window
  // has a project binding (startup restore). Unbound windows (Cmd+N) start
  // with the project picker and get their view registered on project open.
  //
  // Skipped once the manager has already activated a project: a switch can land
  // while the rest of this boot is still awaiting, and the manager will have
  // swapped in its own view for it. Registering the restored project on top of
  // that would point `activeProjectId` and the view map at a project the window
  // is no longer showing.
  if (
    opts.projectViewManager &&
    opts.initialAppView &&
    restoreProject &&
    !opts.projectViewManager.getActiveProjectId()
  ) {
    opts.projectViewManager.registerInitialView(
      opts.initialAppView,
      restoreProject.id,
      restoreProject.path
    );
    // The menu was built before this binding existed, so its project gates
    // resolved against a PVM with no active project. Converge them now (#11136).
    refreshProjectMenuState();
    notificationService.refreshTitles();
  }

  // Load worktrees — prefer initialProjectPath, else restoreProject for
  // startup windows. Unbound windows (no project) skip worktree loading.
  const projectPathForWorktrees = opts.initialProjectPath ?? restoreProject?.path;
  // Skipped outright while the app is quitting: the captured client may already
  // be disposed, and a banner on a window that is going away helps nobody.
  if (projectPathForWorktrees && !isCleaningUp()) {
    // Every outcome below that leaves the renderer without a brokered worktree
    // port has to reach PROJECT_WORKTREE_LOAD_STATUS (#8796, #11818). When one
    // does not, the per-view worktree store never leaves its initial
    // `isLoading: true` — `worktreePort.onReady` is what triggers the first
    // fetch — so the sidebar renders its skeleton forever with no banner and
    // nothing in the log. That silent branch is what this block removes.
    //
    // A restored window already carries the registered id, which is the one the
    // renderer filters on — use it directly. Only a window opened by path (CLI
    // open, Dock drop) has to resolve one, and without that it would resolve no
    // id at all and drop the status. `resolveProjectIdForPath` is a synchronous
    // read returning the registered id when the path is known; for a path that
    // isn't registered yet it hashes the path, which can differ from the id the
    // project is finally registered under (git-root or realpath resolution).
    // The renderer's own port watchdog is the backstop for that case.
    let statusProjectId = restoreProject?.id;
    if (!statusProjectId) {
      try {
        statusProjectId = projectStore.resolveProjectIdForPath(projectPathForWorktrees);
      } catch (error) {
        console.warn("[MAIN] Could not resolve a project id for worktree load status:", error);
      }
    }

    // Re-selected at report time rather than captured up front — the window's
    // app view can be swapped or destroyed while `loadProject()` is awaited.
    const reportFailure = (error: unknown): void => {
      if (isCleaningUp()) return;
      const statusTarget = selectStatusTarget(
        opts.initialAppView?.webContents ?? null,
        getAppWebContents(win) ?? null
      );
      sendStartupWorktreeLoadFailure(statusTarget, statusProjectId, error);
    };

    const workspaceClient = capturedWorkspaceClient;
    if (workspaceClient) {
      console.log("[MAIN] Loading worktrees for project path:", projectPathForWorktrees);
    }

    // Register the renderer in directPortViews so sendToEntryWindows routes
    // host events (worktree updates, PR detection, etc.) to it, then broker the
    // worktree port (Phase 1).
    const outcome = await runStartupWorktreeLoad({
      loadProject: workspaceClient
        ? () => workspaceClient.loadProject(projectPathForWorktrees, win.id)
        : null,
      getPortTarget: () => opts.initialAppView?.webContents ?? getAppWebContents(win) ?? null,
      getHost: () => workspaceClient?.getHostForProject(projectPathForWorktrees),
      attachDirectPort: (target) => {
        workspaceClient?.attachDirectPort(win.id, target);
        console.log("[MAIN] Workspace direct port attached");
      },
      getBrokerPort: () => {
        const worktreePortBroker = getWorktreePortBrokerRef();
        return worktreePortBroker
          ? (host, target) => worktreePortBroker.brokerPort(host, target)
          : null;
      },
      report: reportFailure,
    });

    switch (outcome.status) {
      case "loaded":
        console.log("[MAIN] Worktrees loaded; worktree port brokered");
        break;
      case "no-client":
        console.error(
          "[MAIN] Workspace client unavailable - cannot load worktrees for:",
          projectPathForWorktrees
        );
        break;
      case "load-failed":
        console.error("[MAIN] Failed to load worktrees:", outcome.error);
        break;
      case "port-failed":
        console.error("[MAIN] Worktree port not brokered:", outcome.reason);
        break;
    }
  }

  // Smoke test
  if (isSmokeTest) {
    if (opts.smokeTestTimer) clearTimeout(opts.smokeTestTimer);
    const bootMs = Date.now() - smokeTestStart;
    console.error("[SMOKE] CHECK: Window created — OK");
    console.error("[SMOKE] CHECK: PTY service — %s", ptyReady ? "OK" : "FAILED");
    console.error("[SMOKE] CHECK: Workspace service — %s", workspaceReady ? "OK" : "FAILED");
    console.error("[SMOKE] CHECK: Auto-updater module — OK");
    console.error("[SMOKE] GPU feature status:", JSON.stringify(app.getGPUFeatureStatus()));
    console.error("[SMOKE] Boot completed in %dms", bootMs);

    if (!ptyReady || !workspaceReady) {
      console.error("[SMOKE] FAILED — one or more services did not start");
      if (win && !win.isDestroyed()) win.destroy();
      getWorkspaceClientRef()?.dispose();
      getPtyClient()?.dispose();
      app.exit(1);
      return "exit-requested";
    }

    const smokeClient = getPtyClient()!;
    const allPassed = await runSmokeFunctionalChecks(
      win,
      smokeClient,
      opts.smokeRendererUnresponsive
    );

    if (win && !win.isDestroyed()) win.destroy();
    try {
      getWorkspaceClientRef()?.dispose();
    } catch {
      /* ignore */
    }
    try {
      getPtyClient()?.dispose();
    } catch {
      /* ignore */
    }
    app.exit(allPassed ? 0 : 1);
    return "exit-requested";
  }

  // CLI path handling — skip if this window was opened with an explicit initialProjectPath
  if (!opts.initialProjectPath) {
    const firstLaunchCliPath = !getProcessArgvCliHandled()
      ? extractCliPath(process.argv, process.cwd())
      : null;
    // Retire the one-shot read whenever argv asked for a path at all, not only
    // when it resolved: an unresolvable `--cli-path` is still consumed, so it
    // isn't re-parsed (and re-reported) by every window created afterwards.
    if (firstLaunchCliPath || hasCliPathFlag(process.argv)) setProcessArgvCliHandled(true);
    const cliPath = firstLaunchCliPath ?? getPendingCliPath();
    if (cliPath) {
      setPendingCliPath(null);
      console.log("[MAIN] Opening CLI path from launch args:", cliPath);
      handleDirectoryOpen(cliPath, win, cliAvailabilityService ?? undefined).catch((err) =>
        console.error("[MAIN] Failed to open CLI path:", err)
      );
    }
  } else {
    console.log("[MAIN] Window opened with initial project path:", opts.initialProjectPath);
    handleDirectoryOpen(opts.initialProjectPath, win, cliAvailabilityService ?? undefined).catch(
      (err) => console.error("[MAIN] Failed to open initial project path:", err)
    );
  }

  // Folder drops on the Dock icon / "Open With" arrive via macOS `open-file`
  // (#10976). Cold-launch / zero-window drops queue in `environment.ts` before
  // any window exists; the first window drains them here (mirroring the CLI-
  // path drain above), and a one-shot consumer routes subsequent warm drops to
  // the primary window. The queue/consumer lifecycle lives in openDirHandler.ts
  // so it is unit-testable independent of this module's heavy setup.
  installOpenDirConsumer(openDirDeps);
  drainPendingOpenDirs(win, openDirDeps);

  // `.dntr` plugin-archive handling — independent of project/CLI-path routing.
  // First-launch (cold double-click) archives arrive in process.argv. Each is
  // queued for the install-confirmation prompt (#11280), never installed
  // outright; the intent queue holds previews until this window paints, so
  // there is no separate windowless drain. Fire-and-forget: previews are read
  // sequentially so the prompts keep argv order.
  // A folder named `foo.dntr` opened from the OS is a project, not an archive —
  // the stat-backed directory scan above wins, mirroring `second-instance`.
  const firstLaunchDntrPaths = !getProcessArgvDntrHandled()
    ? extractDntrPaths(process.argv, process.cwd()).filter(
        (dntrPath) => !coldDirectoryPaths.includes(dntrPath)
      )
    : [];
  if (firstLaunchDntrPaths.length > 0) {
    setProcessArgvDntrHandled(true);
    void queueDntrPaths(firstLaunchDntrPaths).catch((err) =>
      console.error("[MAIN] Failed to queue .dntr plugin(s):", err)
    );
  }

  // ── Last-window-close: reset per-window deferred queue ──
  //
  // Per-window cleanup is handled by ctx.cleanup (run by WindowRegistry.unregister).
  // Global services (PtyClient, WorkspaceClient, monitors, watchers, notifiers, etc.)
  // are kept alive for app lifetime — they are torn down only in `before-quit`
  // (electron/lifecycle/shutdown.ts). On macOS, closing all windows does NOT quit
  // the app; reactivating from the dock must re-open a window without racing an
  // in-flight async teardown of the global singletons. Keeping globals alive
  // makes the dock-reactivation path a no-op past `initGlobalServices()`.
  //
  // We still reset the deferred init queue so a future window can re-register
  // per-window-context deferred tasks. The `globalServicesInitialized` guard
  // stays true, so `initGlobalServices()` itself does NOT re-run.
  win.on("closed", () => {
    if (windowRegistry && windowRegistry.size > 0) {
      // Other windows still open — nothing to do at this level.
      return;
    }
    resetDeferredQueue();
  });

  return "ok";
}
