import { app, BrowserWindow, dialog, webContents } from "electron";
import os from "os";
import { registerIpcHandlers, sendToRenderer } from "../ipc/handlers.js";
import { getAppWebContents } from "./webContentsRegistry.js";
import { distributePortsToView } from "./portDistribution.js";
import { registerErrorHandlers, flushPendingErrors } from "../ipc/errorHandlers.js";
import { disposePtyClient } from "../services/PtyClient.js";
import { disposeMainProcessWatchdog } from "../services/MainProcessWatchdogClient.js";
import { getWorkspaceClient, disposeWorkspaceClient } from "../services/WorkspaceClient.js";
import { CHANNELS } from "../ipc/channels.js";
import { handleDirectoryOpen } from "../menu.js";
import { projectStore } from "../services/ProjectStore.js";
import { taskQueueService } from "../services/TaskQueueService.js";
import { gitHubTokenHealthService } from "../services/github/GitHubTokenHealthService.js";
import {
  agentConnectivityService,
  getServiceConnectivityRegistry,
} from "../services/connectivity/index.js";
import { notificationService } from "../services/NotificationService.js";
import { preAgentSnapshotService } from "../services/PreAgentSnapshotService.js";
import {
  initializeAgentAvailabilityStore,
  disposeAgentAvailabilityStore,
} from "../services/AgentAvailabilityStore.js";
import {
  initializePowerSaveBlockerService,
  disposePowerSaveBlockerService,
} from "../services/PowerSaveBlockerService.js";
import { initializeAgentRouter, disposeAgentRouter } from "../services/AgentRouter.js";
import {
  initializeTaskOrchestrator,
  disposeTaskOrchestrator,
} from "../services/TaskOrchestrator.js";
import { runSmokeFunctionalChecks } from "../services/smokeTest.js";
import { getHibernationService } from "../services/HibernationService.js";
import { getSystemSleepService } from "../services/SystemSleepService.js";
import { getCrashRecoveryService } from "../services/CrashRecoveryService.js";
import { getIdleTerminalNotificationService } from "../services/IdleTerminalNotificationService.js";
import { markPerformance } from "../utils/performance.js";
import { getCurrentDiskSpaceStatus } from "../services/DiskSpaceMonitor.js";
import { PERF_MARKS } from "../../shared/perf/marks.js";
import { isSmokeTest, smokeTestStart } from "../setup/environment.js";
import { shouldEnableEarlyRenderer } from "./earlyRenderer.js";
import { extractCliPath, getPendingCliPath, setPendingCliPath } from "../lifecycle/appLifecycle.js";
import type { WindowContext, WindowRegistry } from "./WindowRegistry.js";
import { resetDeferredQueue } from "./deferredInitQueue.js";
import { initGlobalServices } from "./globalServicesInit.js";
import { initPerWindowServices } from "./perWindowInit.js";
import {
  getPtyClient,
  setPtyClientRef,
  getMainProcessWatchdogClientRef,
  setMainProcessWatchdogClientRef,
  getWorkspaceClientRef,
  setWorkspaceClientRef,
  getWorktreePortBrokerRef,
  setWorktreePortBrokerRef,
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
  getResourceProfileService,
  setResourceProfileService,
  getCcrConfigService,
  setCcrConfigService,
  getAutoUpdaterServiceRef,
  setAutoUpdaterServiceRef,
  getAgentNotificationServiceRef,
  setAgentNotificationServiceRef,
  getProcessArgvCliHandled,
  setProcessArgvCliHandled,
  getIpcHandlersRegistered,
  setIpcHandlersRegistered,
  getGlobalServicesInitialized,
  setGlobalServicesInitialized,
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

export async function setupWindowServices(
  win: BrowserWindow,
  opts: SetupWindowServicesOptions
): Promise<void> {
  const windowRegistry = opts.windowRegistry;
  const ctx = windowRegistry?.getByWindowId(win.id);
  if (!ctx) {
    console.error("[MAIN] Window not registered before setupWindowServices — skipping");
    return;
  }

  markPerformance(PERF_MARKS.WINDOW_SERVICES_START);

  // ── One-time global initialization (first window only) ──
  if (!getGlobalServicesInitialized()) {
    const result = await initGlobalServices(windowRegistry);
    if (result === "exit-requested") return;
  }

  // ── Per-window initialization ──
  const handlerDeps = initPerWindowServices(win, ctx, windowRegistry);
  const cliAvailabilityService = getCliAvailabilityServiceRef();

  console.log("[MAIN] Registering IPC handlers...");

  // IPC handlers are globally scoped — register only once
  if (!getIpcHandlersRegistered()) {
    setIpcHandlersRegistered(true);
    setCleanupIpcHandlers(registerIpcHandlers(handlerDeps));
    markPerformance(PERF_MARKS.SERVICE_INIT_IPC_READY);

    try {
      const { pluginService } = await import("../services/PluginService.js");
      await pluginService.initialize();
    } catch (error) {
      console.error("[MAIN] PluginService initialization failed:", error);
    }
  }

  // Renderer load is gated by DAINTREE_EARLY_RENDERER. With the flag, the
  // did-finish-load handler is registered and loadRenderer() is fired before
  // the workspace/PTY init block — first paint stops waiting on the PTY
  // handshake. Without the flag (default), the original serial order is kept:
  // workspace init → handler → loadRenderer.
  const earlyRendererEnabled = shouldEnableEarlyRenderer({ isSmokeTest, env: process.env });

  let rendererLoadStarted = false;
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
      // Refresh workspace direct port on reload (preload context is reset).
      // Under DAINTREE_EARLY_RENDERER, workspaceClient may still be null on the
      // first did-finish-load — the initial direct-port attach is performed by
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

  if (earlyRendererEnabled) {
    console.log("[MAIN] DAINTREE_EARLY_RENDERER=1 — loading renderer in parallel with PTY init");
    startRendererLoad("early-renderer");
  }

  // Initialize workspace client (first window only) — per-project hosts
  // are started on-demand when loadProject() is called, not at init time.
  const ptyClient = getPtyClient();
  if (!getWorkspaceClientRef()) {
    console.log("[MAIN] Waiting for Pty Host to be ready before initializing Workspace Client...");
    try {
      await ptyClient!.waitForReady();
      console.log("[MAIN] Pty Host ready, initializing Workspace Client...");
      markPerformance(PERF_MARKS.SERVICE_INIT_PTY_READY);
    } catch (error) {
      console.error("[MAIN] Pty Host failed to start:", error);
    }

    const workspaceClient = getWorkspaceClient({
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 60000,
      showCrashDialog: false,
    });
    setWorkspaceClientRef(workspaceClient);

    // Give PluginService the WorkspaceClient reference now that it's ready —
    // PluginService.initialize() ran earlier before workspaceClient existed.
    try {
      const { pluginService } = await import("../services/PluginService.js");
      pluginService.setWorkspaceClient(workspaceClient);
    } catch (err) {
      console.error("[MAIN] Failed to wire WorkspaceClient into PluginService:", err);
    }

    markPerformance(PERF_MARKS.SERVICE_INIT_WORKSPACE_READY);

    // Create WorktreePortBroker alongside WorkspaceClient
    if (!getWorktreePortBrokerRef()) {
      const { WorktreePortBroker } = await import("../services/WorktreePortBroker.js");
      setWorktreePortBrokerRef(new WorktreePortBroker());
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
          worktreePortBroker.reBrokerForHost(
            host,
            (wcId: number) => webContents.fromId(wcId) ?? undefined,
            wcIds
          );
          console.log(`[MAIN] Re-brokered ${wcIds.length} worktree port(s) after host restart`);
        }
      }
    );
  }

  const { armRestoreQuota } = await import("../ipc/utils.js");
  armRestoreQuota(50, 120_000);

  // Under DAINTREE_EARLY_RENDERER=1 the RENDERER_READY mark can fire before
  // this point, since the renderer is loading concurrently with workspace init.
  markPerformance(PERF_MARKS.SERVICE_INIT_COMPLETE);
  // Default path: renderer load happens here, after workspace + PTY are ready.
  // With DAINTREE_EARLY_RENDERER=1 this is a no-op (already started above).
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

  try {
    const results = await Promise.allSettled([
      getPtyClient()!.waitForReady(),
      projectStore.initialize(),
    ]);

    ptyReady = results[0].status === "fulfilled";
    const projectStoreReady = results[1].status === "fulfilled";

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

  // PTY-related features
  if (ptyReady) {
    const pty = getPtyClient()!;
    createAndDistributePorts(win, ctx);

    if (restoreProject) {
      pty.setActiveProject(win.id, restoreProject.id, restoreProject.path);
    } else {
      pty.setActiveProject(win.id, null);
    }

    const availabilityStore = initializeAgentAvailabilityStore();
    const agentRouter = initializeAgentRouter(availabilityStore);
    initializePowerSaveBlockerService();
    console.log("[MAIN] AgentAvailabilityStore, AgentRouter, and PowerSaveBlocker initialized");

    initializeTaskOrchestrator(pty, agentRouter);
    console.log("[MAIN] TaskOrchestrator initialized");

    const processArgvCli = !getProcessArgvCliHandled() ? extractCliPath(process.argv) : null;
    const skipDefaultSpawn =
      opts.initialProjectPath || processArgvCli || getPendingCliPath() || restoreProject;
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
  if (opts.projectViewManager && opts.initialAppView && restoreProject) {
    opts.projectViewManager.registerInitialView(
      opts.initialAppView,
      restoreProject.id,
      restoreProject.path
    );
  }

  // Add ProjectViewManager to handler deps for IPC handlers
  if (opts.projectViewManager) {
    handlerDeps.projectViewManager = opts.projectViewManager;
    ctx.services.projectViewManager = opts.projectViewManager;
  }

  // Load worktrees — prefer initialProjectPath, else restoreProject for
  // startup windows. Unbound windows (no project) skip worktree loading.
  const projectPathForWorktrees = opts.initialProjectPath ?? restoreProject?.path;
  const workspaceClient = getWorkspaceClientRef();
  if (projectPathForWorktrees && workspaceClient && workspaceReady) {
    console.log("[MAIN] Loading worktrees for project path:", projectPathForWorktrees);
    try {
      await workspaceClient.loadProject(projectPathForWorktrees, win.id);
      console.log("[MAIN] Worktrees loaded");

      // Attach direct MessagePort for workspace events (bypasses main-process relay)
      const directPortTarget = opts.initialAppView?.webContents ?? getAppWebContents(win);
      if (directPortTarget && !directPortTarget.isDestroyed()) {
        workspaceClient.attachDirectPort(win.id, directPortTarget);
        console.log("[MAIN] Workspace direct port attached");

        // Broker new worktree port (Phase 1)
        const host = workspaceClient.getHostForProject(projectPathForWorktrees);
        const worktreePortBroker = getWorktreePortBrokerRef();
        if (host && worktreePortBroker) {
          worktreePortBroker.brokerPort(host, directPortTarget);
          console.log("[MAIN] Worktree port brokered");
        }
      }
    } catch (error) {
      console.error("[MAIN] Failed to load worktrees:", error);
    }
  } else if (projectPathForWorktrees && !workspaceReady) {
    console.warn("[MAIN] Workspace service unavailable - skipping worktree loading");
  }

  // Task queue & workflow (startup restore only — not for unbound or path windows)
  if (restoreProject && !opts.initialProjectPath) {
    console.log("[MAIN] Initializing task queue for current project:", restoreProject.name);
    try {
      await taskQueueService.initialize(restoreProject.id);
      console.log("[MAIN] Task queue initialized for current project");
    } catch (error) {
      console.error("[MAIN] Failed to initialize task queue:", error);
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
      return;
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
    return;
  }

  // CLI path handling — skip if this window was opened with an explicit initialProjectPath
  if (!opts.initialProjectPath) {
    const firstLaunchCliPath = !getProcessArgvCliHandled() ? extractCliPath(process.argv) : null;
    if (firstLaunchCliPath) setProcessArgvCliHandled(true);
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

  // ── Last-window-close: dispose global services ──
  // Per-window cleanup is handled by ctx.cleanup (run by WindowRegistry.unregister).
  // This handler only disposes global singletons when the last window closes.
  win.on("closed", async () => {
    if (windowRegistry && windowRegistry.size > 0) {
      // Other windows still open — do not dispose global services
      return;
    }

    // Last window closed — dispose global services.
    // Stop the CCR config watcher first, before any guard resets or IPC teardown.
    // Awaiting here blocks a new window from racing into the init block (which would
    // restart the singleton watcher) and finding this handler about to null the ref.
    const ccrConfigService = getCcrConfigService();
    if (ccrConfigService) {
      await ccrConfigService.stopWatching();
      setCcrConfigService(null);
    }

    const stopELL = getStopEventLoopLagMonitor();
    if (stopELL) {
      stopELL();
      setStopEventLoopLagMonitor(null);
    }
    const stopPM = getStopProcessMemoryMonitor();
    if (stopPM) {
      stopPM();
      setStopProcessMemoryMonitor(null);
    }
    const stopAM = getStopAppMetricsMonitor();
    if (stopAM) {
      stopAM();
      setStopAppMetricsMonitor(null);
    }
    const stopDS = getStopDiskSpaceMonitor();
    if (stopDS) {
      stopDS();
      setStopDiskSpaceMonitor(null);
    }
    const rps = getResourceProfileService();
    if (rps) {
      rps.stop();
      setResourceProfileService(null);
    }

    const wpb = getWorktreePortBrokerRef();
    if (wpb) wpb.dispose();
    setWorktreePortBrokerRef(null);
    const ws = getWorkspaceClientRef();
    if (ws) ws.dispose();
    setWorkspaceClientRef(null);
    disposeWorkspaceClient();

    // Drop PluginService's WorkspaceClient reference so plugin event handlers
    // can't fire into the disposed instance during late teardown.
    try {
      const { pluginService } = await import("../services/PluginService.js");
      pluginService.setWorkspaceClient(null);
    } catch {
      // module load errors during teardown are non-fatal
    }

    disposeTaskOrchestrator();
    disposeAgentRouter();
    disposePowerSaveBlockerService();
    disposeAgentAvailabilityStore();

    const pty = getPtyClient();
    if (pty) pty.dispose();
    setPtyClientRef(null);
    disposePtyClient();

    const watchdog = getMainProcessWatchdogClientRef();
    if (watchdog) watchdog.dispose();
    setMainProcessWatchdogClientRef(null);
    disposeMainProcessWatchdog();

    // Clean up IPC handlers and reset guards so next window re-registers fresh
    const cleanupIpc = getCleanupIpcHandlers();
    if (cleanupIpc) {
      cleanupIpc();
      setCleanupIpcHandlers(null);
    }
    const cleanupErr = getCleanupErrorHandlers();
    if (cleanupErr) {
      cleanupErr();
      setCleanupErrorHandlers(null);
    }
    setIpcHandlersRegistered(false);
    // Reset the global init guard so the next window re-runs
    // initGlobalServices() from a clean slate.
    setGlobalServicesInitialized(false);
    resetDeferredQueue();

    getHibernationService().stop();
    getIdleTerminalNotificationService().stop();
    getCrashRecoveryService().stopBackupTimer();
    getSystemSleepService().dispose();
    gitHubTokenHealthService.dispose();
    agentConnectivityService.dispose();
    getServiceConnectivityRegistry().dispose();
    notificationService.dispose();
    const ans = getAgentNotificationServiceRef();
    if (ans) {
      ans.dispose();
      setAgentNotificationServiceRef(null);
    }
    preAgentSnapshotService.dispose();
    const aus = getAutoUpdaterServiceRef();
    if (aus) {
      aus.dispose();
      setAutoUpdaterServiceRef(null);
    }
  });
}
