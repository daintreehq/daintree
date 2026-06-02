import { app, BrowserWindow, dialog, webContents } from "electron";
import os from "os";
import { registerIpcHandlers, sendToRenderer } from "../ipc/handlers.js";
import { getAppWebContents } from "./webContentsRegistry.js";
import { distributePortsToView } from "./portDistribution.js";
import { registerErrorHandlers, flushPendingErrors } from "../ipc/errorHandlers.js";
import { getWorkspaceClient } from "../services/WorkspaceClient.js";
import { CHANNELS } from "../ipc/channels.js";
import { handleDirectoryOpen } from "../menu.js";
import { projectStore } from "../services/ProjectStore.js";
import { scratchStore } from "../services/ScratchStore.js";
import { initializeAgentAvailabilityStore } from "../services/AgentAvailabilityStore.js";
import { initializePowerSaveBlockerService } from "../services/PowerSaveBlockerService.js";
import { runSmokeFunctionalChecks } from "../services/smokeTest.js";
import { markPerformance } from "../utils/performance.js";
import { getCurrentDiskSpaceStatus } from "../services/DiskSpaceMonitor.js";
import { PERF_MARKS } from "../../shared/perf/marks.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import {
  isSmokeTest,
  smokeTestStart,
  getEarlyPathRefreshPromise,
  kickOffEarlyPathRefresh,
} from "../setup/environment.js";
import { shouldDeferRendererLoadForE2E } from "./earlyRenderer.js";
import {
  extractCliPath,
  getPendingCliPath,
  setPendingCliPath,
  extractDntrPaths,
  getPendingDntrPaths,
  drainPendingDntrPaths,
  installDntrPath,
} from "../lifecycle/appLifecycle.js";
import type { WindowContext, WindowRegistry } from "./WindowRegistry.js";
import { resetDeferredQueue } from "./deferredInitQueue.js";
import { initGlobalServices } from "./globalServicesInit.js";
import { initPerWindowServices } from "./perWindowInit.js";
import {
  getPtyClient,
  getWorkspaceClientRef,
  setWorkspaceClientRef,
  getWorktreePortBrokerRef,
  setWorktreePortBrokerRef,
  getCliAvailabilityServiceRef,
  getCleanupErrorHandlers,
  setCleanupErrorHandlers,
  setCleanupIpcHandlers,
  getProcessArgvCliHandled,
  setProcessArgvCliHandled,
  getProcessArgvDntrHandled,
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
  const handlerDeps = await initPerWindowServices(win, ctx, windowRegistry);
  const cliAvailabilityService = getCliAvailabilityServiceRef();

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
  const deferRendererLoadForE2E = shouldDeferRendererLoadForE2E({ env: process.env });

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
    ptyClient.start();
  }

  // Initialize workspace client (first window only) — per-project hosts
  // are started on-demand when loadProject() is called, not at init time.
  if (!getWorkspaceClientRef()) {
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

    // Give PluginService the WorkspaceClient reference now that it's ready.
    // initialize() is deferred and may run before or after this point — the
    // service's pendingWorktreeSubs replay handles either ordering.
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
        if (process.env.DAINTREE_E2E_FAULT_MODE === "1") {
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

    initializeAgentAvailabilityStore();
    initializePowerSaveBlockerService();
    console.log("[MAIN] AgentAvailabilityStore and PowerSaveBlocker initialized");

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

      // Register the renderer in directPortViews so sendToEntryWindows
      // routes host events (worktree updates, PR detection, etc.) to it.
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

      // Surface the failure to the renderer so the sidebar shows the
      // WorktreeLoadErrorBanner instead of an infinite loading skeleton
      // (#8796). Without this, the worktree port is never brokered, the
      // renderer's worktree store stays `isLoading: true`, and the sidebar
      // hangs. Mirrors the project-switch path (projectCrud/switch.ts).
      // The send is deferred until `did-finish-load` while the renderer is
      // still loading — messages sent before the renderer wires its
      // ipcRenderer listener are silently dropped.
      const failedProjectId = restoreProject?.id;
      // Prefer the project view's webContents, but fall through to the
      // window's app webContents if it's already destroyed — selecting a
      // destroyed target would silently drop the message and re-hang.
      const initialViewWc = opts.initialAppView?.webContents;
      const statusTarget =
        initialViewWc && !initialViewWc.isDestroyed() ? initialViewWc : getAppWebContents(win);
      if (failedProjectId && statusTarget) {
        const worktreeLoadError = formatErrorMessage(error, "Failed to load worktrees");
        const sendLoadStatus = (): void => {
          if (statusTarget.isDestroyed()) return;
          statusTarget.send(CHANNELS.PROJECT_WORKTREE_LOAD_STATUS, {
            projectId: failedProjectId,
            worktreeLoadError,
          });
        };
        if (statusTarget.isLoading()) {
          statusTarget.once("did-finish-load", sendLoadStatus);
        } else {
          sendLoadStatus();
        }
      }
    }
  } else if (projectPathForWorktrees && !workspaceReady) {
    console.warn("[MAIN] Workspace service unavailable - skipping worktree loading");
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

  // `.dntr` plugin-archive handling — independent of project/CLI-path routing.
  // First-launch (cold double-click) archives arrive in process.argv; second
  // instances queue into pendingDntrPaths. Both are sideloaded once the first
  // window is ready so install toasts have a live renderer target. Fire-and-
  // forget: installs run sequentially through the installer's lock.
  const firstLaunchDntrPaths = !getProcessArgvDntrHandled()
    ? extractDntrPaths(process.argv, process.cwd())
    : [];
  if (firstLaunchDntrPaths.length > 0) setProcessArgvDntrHandled(true);
  if (firstLaunchDntrPaths.length > 0 || getPendingDntrPaths().length > 0) {
    void (async () => {
      for (const archivePath of firstLaunchDntrPaths) {
        await installDntrPath(archivePath);
      }
      await drainPendingDntrPaths();
    })().catch((err) => console.error("[MAIN] Failed to install .dntr plugin(s):", err));
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
}
