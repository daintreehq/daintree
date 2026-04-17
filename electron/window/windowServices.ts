import { app, BrowserWindow, dialog, ipcMain, session, webContents } from "electron";
import os from "os";
import type { HandlerDependencies } from "../ipc/types.js";
import { registerIpcHandlers, sendToRenderer } from "../ipc/handlers.js";
import { getAppWebContents } from "./webContentsRegistry.js";
import { distributePortsToView } from "./portDistribution.js";
import { registerErrorHandlers, flushPendingErrors } from "../ipc/errorHandlers.js";
import { PtyClient, disposePtyClient } from "../services/PtyClient.js";
import {
  getWorkspaceClient,
  disposeWorkspaceClient,
  WorkspaceClient,
} from "../services/WorkspaceClient.js";
import { CliAvailabilityService } from "../services/CliAvailabilityService.js";
import { AgentVersionService } from "../services/AgentVersionService.js";
import { AgentUpdateHandler } from "../services/AgentUpdateHandler.js";
import { PortalManager } from "../services/PortalManager.js";
import { EventBuffer } from "../services/EventBuffer.js";
import { CHANNELS } from "../ipc/channels.js";
import { createApplicationMenu, handleDirectoryOpen } from "../menu.js";
import { ProjectSwitchService } from "../services/ProjectSwitchService.js";
import { projectStore } from "../services/ProjectStore.js";
import { taskQueueService } from "../services/TaskQueueService.js";
import { store } from "../store.js";
import { MigrationRunner } from "../services/StoreMigrations.js";
import { migrations } from "../services/migrations/index.js";
import { initializeTelemetry } from "../services/TelemetryService.js";
import { GitHubAuth } from "../services/github/GitHubAuth.js";
import { secureStorage } from "../services/SecureStorage.js";
import { notificationService } from "../services/NotificationService.js";
import { agentNotificationService } from "../services/AgentNotificationService.js";
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
import { autoUpdaterService } from "../services/AutoUpdaterService.js";
import { runSmokeFunctionalChecks } from "../services/smokeTest.js";
import {
  initializeHibernationService,
  getHibernationService,
} from "../services/HibernationService.js";
import { initializeIdleTerminalNotificationService } from "../services/IdleTerminalNotificationService.js";
import {
  initializeSystemSleepService,
  getSystemSleepService,
} from "../services/SystemSleepService.js";
import {
  evictSessionFiles,
  SESSION_EVICTION_TTL_MS,
  SESSION_EVICTION_MAX_BYTES,
} from "../services/pty/terminalSessionPersistence.js";
import { mcpServerService } from "../services/McpServerService.js";
import { getCrashRecoveryService } from "../services/CrashRecoveryService.js";
import {
  markPerformance,
  startEventLoopLagMonitor,
  startProcessMemoryMonitor,
} from "../utils/performance.js";
import { startAppMetricsMonitor } from "../services/ProcessMemoryMonitor.js";
import { ResourceProfileService } from "../services/ResourceProfileService.js";
import { startDiskSpaceMonitor, getCurrentDiskSpaceStatus } from "../services/DiskSpaceMonitor.js";
import { SCROLLBACK_BACKGROUND } from "../../shared/config/scrollback.js";
import { logInfo } from "../utils/logger.js";
import { PERF_MARKS } from "../../shared/perf/marks.js";
import { isSmokeTest, isDemoMode, smokeTestStart, exposeGc } from "../setup/environment.js";
import { extractCliPath, getPendingCliPath, setPendingCliPath } from "../lifecycle/appLifecycle.js";
import type { WindowContext, WindowRegistry } from "./WindowRegistry.js";

const DEFAULT_TERMINAL_ID = "default";

// Guard: process.argv CLI path should only be consumed by the first window
let processArgvCliHandled = false;

// ── Global service refs (shared across all windows) ──
let ptyClient: PtyClient | null = null;
let workspaceClient: WorkspaceClient | null = null;
let cliAvailabilityService: CliAvailabilityService | null = null;
let agentVersionService: AgentVersionService | null = null;
let agentUpdateHandler: AgentUpdateHandler | null = null;
let cleanupIpcHandlers: (() => void) | null = null;
let cleanupErrorHandlers: (() => void) | null = null;
let stopEventLoopLagMonitor: (() => void) | null = null;
let stopProcessMemoryMonitor: (() => void) | null = null;
let stopAppMetricsMonitor: (() => void) | null = null;
let stopDiskSpaceMonitor: (() => void) | null = null;
let resourceProfileService: ResourceProfileService | null = null;
let worktreePortBroker: import("../services/WorktreePortBroker.js").WorktreePortBroker | null =
  null;

// Guard: IPC handlers are globally scoped (ipcMain.handle throws on re-registration)
let ipcHandlersRegistered = false;

// Guard: one-time global initialization (migrations, GitHubAuth, etc.)
let globalServicesInitialized = false;

// Expose getters for shutdown handler
export function getPtyClient(): PtyClient | null {
  return ptyClient;
}
export function setPtyClientRef(v: PtyClient | null): void {
  ptyClient = v;
}
export function getWorkspaceClientRef(): WorkspaceClient | null {
  return workspaceClient;
}
export function getWorktreePortBrokerRef():
  | import("../services/WorktreePortBroker.js").WorktreePortBroker
  | null {
  return worktreePortBroker;
}
export function getCliAvailabilityServiceRef(): CliAvailabilityService | null {
  return cliAvailabilityService;
}
export function getCleanupIpcHandlers(): (() => void) | null {
  return cleanupIpcHandlers;
}
export function setCleanupIpcHandlers(v: (() => void) | null): void {
  cleanupIpcHandlers = v;
}
export function getCleanupErrorHandlers(): (() => void) | null {
  return cleanupErrorHandlers;
}
export function setCleanupErrorHandlers(v: (() => void) | null): void {
  cleanupErrorHandlers = v;
}
export function getStopEventLoopLagMonitor(): (() => void) | null {
  return stopEventLoopLagMonitor;
}
export function setStopEventLoopLagMonitor(v: (() => void) | null): void {
  stopEventLoopLagMonitor = v;
}
export function getStopProcessMemoryMonitor(): (() => void) | null {
  return stopProcessMemoryMonitor;
}
export function setStopProcessMemoryMonitor(v: (() => void) | null): void {
  stopProcessMemoryMonitor = v;
}
export function getStopAppMetricsMonitor(): (() => void) | null {
  return stopAppMetricsMonitor;
}
export function setStopAppMetricsMonitor(v: (() => void) | null): void {
  stopAppMetricsMonitor = v;
}
export function getStopDiskSpaceMonitor(): (() => void) | null {
  return stopDiskSpaceMonitor;
}
export function setStopDiskSpaceMonitor(v: (() => void) | null): void {
  stopDiskSpaceMonitor = v;
}

function createAndDistributePorts(win: BrowserWindow, ctx: WindowContext): void {
  const wc = getAppWebContents(win);
  distributePortsToView(win, ctx, wc, ptyClient);
}

async function initializeDeferredServices(
  window: BrowserWindow,
  cliService: CliAvailabilityService,
  eventBuf: EventBuffer,
  windowRegistry?: WindowRegistry
): Promise<void> {
  console.log("[MAIN] Initializing deferred services in background...");
  markPerformance(PERF_MARKS.DEFERRED_SERVICES_START);
  const startTime = Date.now();

  const results = await Promise.allSettled([
    cliService.checkAvailability().then((availability) => {
      console.log("[MAIN] CLI availability checked:", availability);
      console.log("[MAIN] Rebuilding menu with agent availability...");
      createApplicationMenu(window, cliService);
      return availability;
    }),
  ]);

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const serviceName = ["CliAvailabilityService"][index];
      console.error(`[MAIN] ${serviceName} initialization failed:`, result.reason);
    }
  });

  initializeHibernationService();
  console.log("[MAIN] HibernationService initialized");

  initializeIdleTerminalNotificationService();
  console.log("[MAIN] IdleTerminalNotificationService initialized");

  initializeSystemSleepService();
  console.log("[MAIN] SystemSleepService initialized");

  eventBuf.start();
  console.log("[MAIN] EventBuffer started");

  if (windowRegistry) {
    mcpServerService.start(windowRegistry).catch((err) => {
      console.error("[MAIN] MCP server failed to start:", err);
    });
  }

  // Fire-and-forget session file eviction
  (async () => {
    try {
      const allProjects = projectStore.getAllProjects();
      const knownIds = new Set<string>();

      const states = await Promise.all(allProjects.map((p) => projectStore.getProjectState(p.id)));
      for (const state of states) {
        if (state?.terminals) {
          for (const t of state.terminals) {
            knownIds.add(t.id);
          }
        }
      }

      const appTerminals = store.get("appState")?.terminals;
      if (Array.isArray(appTerminals)) {
        for (const t of appTerminals) {
          knownIds.add(t.id);
        }
      }

      const result = await evictSessionFiles({
        ttlMs: SESSION_EVICTION_TTL_MS,
        maxBytes: SESSION_EVICTION_MAX_BYTES,
        knownIds,
      });

      if (result.deleted > 0) {
        console.log(
          `[MAIN] Session eviction: deleted ${result.deleted} file(s), freed ${(result.bytesFreed / 1024 / 1024).toFixed(1)} MB`
        );
      }
    } catch (err) {
      console.warn("[MAIN] Session eviction failed:", err);
    }
  })();

  const elapsed = Date.now() - startTime;
  markPerformance(PERF_MARKS.DEFERRED_SERVICES_COMPLETE, { durationMs: elapsed });
  console.log(`[MAIN] All deferred services initialized in ${elapsed}ms`);
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

  markPerformance(PERF_MARKS.MAIN_WINDOW_CREATED);

  // ── One-time global initialization (first window only) ──
  if (!globalServicesInitialized) {
    globalServicesInitialized = true;
    markPerformance(PERF_MARKS.SERVICE_INIT_START);

    // Store migrations
    console.log("[MAIN] Running store migrations...");
    try {
      const migrationRunner = new MigrationRunner(store);
      await migrationRunner.runMigrations(migrations);
      console.log("[MAIN] Store migrations completed");
      markPerformance(PERF_MARKS.SERVICE_INIT_MIGRATIONS_DONE);
    } catch (error) {
      console.error("[MAIN] Store migration failed:", error);
      const message = error instanceof Error ? error.message : String(error);
      dialog
        .showMessageBox(win, {
          type: "error",
          title: "Migration Failed",
          message: `Failed to migrate application data:\n\n${message}\n\nThe application will now exit. Please check the logs for details.`,
          buttons: ["OK"],
        })
        .then(() => app.exit(1))
        .catch(() => app.exit(1));
      return;
    }

    // Initialize Sentry after migrations — reads privacy.telemetryLevel,
    // which is guaranteed populated by migration014.
    void initializeTelemetry();

    // Initialize GitHubAuth
    GitHubAuth.initializeStorage({
      get: () => secureStorage.get("userConfig.githubToken"),
      set: (token) => secureStorage.set("userConfig.githubToken", token),
      delete: () => secureStorage.delete("userConfig.githubToken"),
    });
    console.log("[MAIN] GitHubAuth initialized with storage");

    if (GitHubAuth.hasToken()) {
      const token = GitHubAuth.getToken();
      if (token) {
        const versionAtStart = GitHubAuth.getTokenVersion();
        GitHubAuth.validate(token)
          .then((validation) => {
            if (validation.valid && validation.username) {
              GitHubAuth.setValidatedUserInfo(
                validation.username,
                validation.avatarUrl,
                validation.scopes,
                versionAtStart
              );
              console.log("[MAIN] GitHubAuth user info cached for:", validation.username);
            }
          })
          .catch((err) => {
            console.warn("[MAIN] Failed to validate stored GitHub token:", err);
          });
      }
    }

    // Notifications (global singletons)
    agentNotificationService.initialize();
    preAgentSnapshotService.initialize();

    // Auto-updater
    autoUpdaterService.initialize();
  }

  // ── Per-window initialization ──

  // Menu & Notifications (per-window: menu references this window)
  console.log("[MAIN] Creating application menu (initial, no agent availability yet)...");
  if (!cliAvailabilityService) {
    cliAvailabilityService = new CliAvailabilityService();
  }
  createApplicationMenu(win, cliAvailabilityService);

  if (windowRegistry) {
    notificationService.initialize(windowRegistry);
  }
  console.log("[MAIN] NotificationService initialized");

  // Critical services (global, first window only)
  if (!ptyClient) {
    console.log("[MAIN] Starting critical services...");

    ptyClient = new PtyClient({
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
      showCrashDialog: false,
    });

    agentVersionService = new AgentVersionService(cliAvailabilityService);
    agentUpdateHandler = new AgentUpdateHandler(
      ptyClient,
      agentVersionService,
      cliAvailabilityService
    );

    ptyClient.on("host-crash-details", (details) => {
      console.error(`[MAIN] Pty Host crashed:`, details);
      // Broadcast to all windows
      if (windowRegistry) {
        for (const wCtx of windowRegistry.all()) {
          const w = wCtx.browserWindow;
          if (!w.isDestroyed()) {
            const wc = getAppWebContents(w);
            if (!wc.isDestroyed()) {
              try {
                wc.send(CHANNELS.TERMINAL_BACKEND_CRASHED, {
                  crashType: details.crashType,
                  code: details.code,
                  signal: details.signal,
                  timestamp: details.timestamp,
                });
              } catch {
                // Silently ignore send failures during window disposal.
              }
            }
          }
        }
      }
    });
    ptyClient.on("host-crash", (code) => {
      console.error(`[MAIN] Pty Host crashed with code ${code} (max restarts exceeded)`);
    });
    ptyClient.on("host-throttled", (payload) => {
      if (!payload.isThrottled) {
        logInfo("pty-host-resumed", { duration: payload.duration });
        return;
      }
      logInfo("pty-host-throttled", { reason: payload.reason });
      try {
        session.defaultSession.clearCache().catch(() => {});
      } catch {
        /* non-critical */
      }
      // Broadcast to all windows
      if (windowRegistry) {
        for (const wCtx of windowRegistry.all()) {
          const w = wCtx.browserWindow;
          if (!w.isDestroyed()) {
            try {
              sendToRenderer(w, CHANNELS.WINDOW_RECLAIM_MEMORY, { reason: "pty-host-pressure" });
            } catch {
              /* non-critical */
            }
          }
        }
      }
      try {
        ptyClient!.trimState(SCROLLBACK_BACKGROUND);
      } catch {
        /* non-critical */
      }
    });
    ptyClient.setPortRefreshCallback(() => {
      console.log("[MAIN] Pty Host restarted, refreshing ports...");
      // Refresh ports for ALL registered windows — target the active view
      if (windowRegistry) {
        for (const wCtx of windowRegistry.all()) {
          if (!wCtx.browserWindow.isDestroyed()) {
            const wc = getAppWebContents(wCtx.browserWindow);
            if (!wc.isDestroyed()) {
              distributePortsToView(wCtx.browserWindow, wCtx, wc, ptyClient);
              try {
                wc.send(CHANNELS.TERMINAL_BACKEND_READY);
              } catch {
                // Silently ignore send failures during window disposal.
              }
            }
          }
        }
      }
    });
  }

  // Per-window services
  ctx.services.eventBuffer = new EventBuffer(1000);
  ctx.services.portalManager = new PortalManager(win);
  ctx.services.projectSwitchService = new ProjectSwitchService({
    mainWindow: win,
    ptyClient: ptyClient ?? undefined,
    eventBuffer: ctx.services.eventBuffer,
    portalManager: ctx.services.portalManager,
    cliAvailabilityService,
    agentVersionService,
    agentUpdateHandler,
    isDemoMode,
    windowRegistry,
  } as HandlerDependencies);

  // Per-window cleanup: ports, portalManager, eventBuffer
  ctx.cleanup.push(() => {
    // Notify PTY host to disconnect this window's port before closing it
    if (ptyClient) {
      ptyClient.disconnectMessagePort(ctx.windowId);
    }
    if (ctx.services.activeRendererPort) {
      try {
        ctx.services.activeRendererPort.close();
      } catch {
        /* ignore */
      }
      ctx.services.activeRendererPort = undefined;
    }
    if (ctx.services.activePtyHostPort) {
      try {
        ctx.services.activePtyHostPort.close();
      } catch {
        /* ignore */
      }
      ctx.services.activePtyHostPort = undefined;
    }
    if (ctx.services.portalManager) {
      ctx.services.portalManager.destroy();
      ctx.services.portalManager = undefined;
    }
    if (ctx.services.eventBuffer) {
      ctx.services.eventBuffer.stop();
      ctx.services.eventBuffer = undefined;
    }
    ctx.services.projectSwitchService = undefined;
    if (workspaceClient) {
      workspaceClient.unregisterWindow(win.id);
    }
  });

  console.log("[MAIN] Registering IPC handlers...");
  const handlerDeps: HandlerDependencies = {
    mainWindow: win,
    ptyClient: ptyClient ?? undefined,
    eventBuffer: ctx.services.eventBuffer,
    portalManager: ctx.services.portalManager,
    cliAvailabilityService,
    agentVersionService: agentVersionService ?? undefined,
    agentUpdateHandler: agentUpdateHandler ?? undefined,
    isDemoMode,
    windowRegistry,
  };

  handlerDeps.projectSwitchService = ctx.services.projectSwitchService;

  // IPC handlers are globally scoped — register only once
  if (!ipcHandlersRegistered) {
    ipcHandlersRegistered = true;
    cleanupIpcHandlers = registerIpcHandlers(handlerDeps);
    markPerformance(PERF_MARKS.SERVICE_INIT_IPC_READY);

    try {
      const { pluginService } = await import("../services/PluginService.js");
      await pluginService.initialize();
    } catch (error) {
      console.error("[MAIN] PluginService initialization failed:", error);
    }
  }

  // Initialize workspace client (first window only) — per-project hosts
  // are started on-demand when loadProject() is called, not at init time.
  if (!workspaceClient) {
    console.log("[MAIN] Waiting for Pty Host to be ready before initializing Workspace Client...");
    try {
      await ptyClient!.waitForReady();
      console.log("[MAIN] Pty Host ready, initializing Workspace Client...");
      markPerformance(PERF_MARKS.SERVICE_INIT_PTY_READY);
    } catch (error) {
      console.error("[MAIN] Pty Host failed to start:", error);
    }

    workspaceClient = getWorkspaceClient({
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 60000,
      showCrashDialog: false,
    });

    markPerformance(PERF_MARKS.SERVICE_INIT_WORKSPACE_READY);

    // Create WorktreePortBroker alongside WorkspaceClient
    if (!worktreePortBroker) {
      const { WorktreePortBroker } = await import("../services/WorktreePortBroker.js");
      worktreePortBroker = new WorktreePortBroker();
    }

    handlerDeps.worktreeService = workspaceClient;
    handlerDeps.worktreePortBroker = worktreePortBroker ?? undefined;

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
    // Refresh workspace direct port on reload (preload context is reset)
    if (workspaceClient) {
      workspaceClient.attachDirectPort(win.id, appWc);

      // Re-broker worktree port for initial view reload
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
      sendToRenderer(win, CHANNELS.WINDOW_DISK_SPACE_STATUS, diskStatus);
    }
  });

  markPerformance(PERF_MARKS.SERVICE_INIT_COMPLETE);
  opts.loadRenderer("after-services-ready", opts.initialProjectId);

  // Error handlers also use ipcMain.handle — register once
  if (!cleanupErrorHandlers) {
    cleanupErrorHandlers = registerErrorHandlers(workspaceClient, ptyClient);
  }

  console.log("[MAIN] All critical services ready");

  // Wait for remaining services
  console.log("[MAIN] Waiting for remaining services to initialize...");
  let ptyReady = false;
  // Workspace client is always "ready" — per-project hosts start on-demand via loadProject()
  const workspaceReady = true;

  try {
    const results = await Promise.allSettled([
      ptyClient!.waitForReady(),
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

  // PTY-related features
  if (ptyReady) {
    createAndDistributePorts(win, ctx);

    const currentProjectId = projectStore.getCurrentProjectId();
    const currentProjectPath = currentProjectId
      ? projectStore.getProjectById(currentProjectId)?.path
      : undefined;
    ptyClient!.setActiveProject(win.id, currentProjectId, currentProjectPath);

    const availabilityStore = initializeAgentAvailabilityStore();
    const agentRouter = initializeAgentRouter(availabilityStore);
    initializePowerSaveBlockerService();
    console.log("[MAIN] AgentAvailabilityStore, AgentRouter, and PowerSaveBlocker initialized");

    initializeTaskOrchestrator(ptyClient!, agentRouter);
    console.log("[MAIN] TaskOrchestrator initialized");

    const processArgvCli = !processArgvCliHandled ? extractCliPath(process.argv) : null;
    const skipDefaultSpawn =
      opts.initialProjectPath || processArgvCli || getPendingCliPath() || currentProjectId;
    if (skipDefaultSpawn) {
      console.log(
        "[MAIN] CLI path, initial project path, or existing project set, skipping default terminal spawn"
      );
    } else {
      const terminalId = `${DEFAULT_TERMINAL_ID}-${win.id}`;
      console.log("[MAIN] Spawning default terminal:", terminalId);
      try {
        ptyClient!.spawn(terminalId, {
          cwd: os.homedir(),
          cols: 80,
          rows: 30,
          projectId: currentProjectId ?? undefined,
        });
      } catch (error) {
        console.error("[MAIN] Failed to spawn default terminal:", error);
      }
    }
  } else {
    console.warn("[MAIN] PTY service unavailable - skipping terminal setup");
  }

  // Register the initial view with ProjectViewManager once we know the project
  const currentProject = projectStore.getCurrentProject();
  if (opts.projectViewManager && opts.initialAppView && currentProject) {
    opts.projectViewManager.registerInitialView(
      opts.initialAppView,
      currentProject.id,
      currentProject.path
    );
  }

  // Add ProjectViewManager to handler deps for IPC handlers
  if (opts.projectViewManager) {
    handlerDeps.projectViewManager = opts.projectViewManager;
    ctx.services.projectViewManager = opts.projectViewManager;
  }

  // Load worktrees — prefer initialProjectPath for windows opened with a specific path
  const projectPathForWorktrees = opts.initialProjectPath ?? currentProject?.path;
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

  // Task queue & workflow (only initialize once for the first window)
  if (currentProject && !opts.initialProjectPath) {
    console.log("[MAIN] Initializing task queue for current project:", currentProject.name);
    try {
      await taskQueueService.initialize(currentProject.id);
      console.log("[MAIN] Task queue initialized for current project");
    } catch (error) {
      console.error("[MAIN] Failed to initialize task queue:", error);
    }
  }

  // Event inspector (per-window: uses named listeners for safe per-window cleanup)
  let eventInspectorActive = false;
  const onEventInspectorSubscribe = () => {
    eventInspectorActive = true;
  };
  const onEventInspectorUnsubscribe = () => {
    eventInspectorActive = false;
  };
  ipcMain.on(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE, onEventInspectorSubscribe);
  ipcMain.on(CHANNELS.EVENT_INSPECTOR_UNSUBSCRIBE, onEventInspectorUnsubscribe);

  const unsubscribeFromEventBuffer = ctx.services.eventBuffer!.onRecord((record) => {
    if (!eventInspectorActive) return;
    sendToRenderer(win, CHANNELS.EVENT_INSPECTOR_EVENT, record);
  });

  ctx.cleanup.push(() => {
    unsubscribeFromEventBuffer();
    ipcMain.removeListener(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE, onEventInspectorSubscribe);
    ipcMain.removeListener(CHANNELS.EVENT_INSPECTOR_UNSUBSCRIBE, onEventInspectorUnsubscribe);
  });

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
      workspaceClient!.dispose();
      ptyClient!.dispose();
      app.exit(1);
      return;
    }

    const smokeClient = ptyClient!;
    const allPassed = await runSmokeFunctionalChecks(
      win,
      smokeClient,
      opts.smokeRendererUnresponsive
    );

    if (win && !win.isDestroyed()) win.destroy();
    try {
      workspaceClient!.dispose();
    } catch {
      /* ignore */
    }
    try {
      ptyClient!.dispose();
    } catch {
      /* ignore */
    }
    app.exit(allPassed ? 0 : 1);
    return;
  }

  // Deferred services
  initializeDeferredServices(
    win,
    cliAvailabilityService!,
    ctx.services.eventBuffer!,
    windowRegistry
  ).catch((error) => {
    console.error("[MAIN] Deferred services initialization failed:", error);
  });

  getCrashRecoveryService().startBackupTimer();

  // Disk space monitor (global)
  if (!stopDiskSpaceMonitor) {
    stopDiskSpaceMonitor = startDiskSpaceMonitor({
      sendStatus: (payload) => {
        // Broadcast to all windows
        if (windowRegistry) {
          for (const wCtx of windowRegistry.all()) {
            if (!wCtx.browserWindow.isDestroyed()) {
              sendToRenderer(wCtx.browserWindow, CHANNELS.WINDOW_DISK_SPACE_STATUS, payload);
            }
          }
        }
      },
      onCriticalChange: (isCritical) => {
        if (isCritical) {
          getCrashRecoveryService().stopBackupTimer();
          ptyClient?.suppressSessionPersistence(true);
        } else {
          getCrashRecoveryService().startBackupTimer();
          ptyClient?.suppressSessionPersistence(false);
        }
      },
      showNativeNotification: (title, body) => {
        notificationService.showNativeNotification(title, body);
      },
      isWindowFocused: () => notificationService.isWindowFocused(),
    });
  }

  // CLI path handling — skip if this window was opened with an explicit initialProjectPath
  if (!opts.initialProjectPath) {
    const firstLaunchCliPath = !processArgvCliHandled ? extractCliPath(process.argv) : null;
    if (firstLaunchCliPath) processArgvCliHandled = true;
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

  // Performance monitors (global)
  if (!stopEventLoopLagMonitor) {
    stopEventLoopLagMonitor = startEventLoopLagMonitor();
  }
  if (process.env.DAINTREE_PERF_CAPTURE === "1" && !stopProcessMemoryMonitor) {
    stopProcessMemoryMonitor = startProcessMemoryMonitor();
  }

  if (!stopAppMetricsMonitor) {
    stopAppMetricsMonitor = startAppMetricsMonitor({
      clearCaches: async () => {
        try {
          await session.defaultSession.clearCache();
        } catch {
          /* non-critical */
        }
        try {
          await session.defaultSession.clearStorageData({
            storages: ["shadercache", "cachestorage"],
          });
        } catch {
          /* non-critical */
        }
        try {
          exposeGc?.();
        } catch {
          /* non-critical */
        }
        // Broadcast to all windows
        if (windowRegistry) {
          for (const wCtx of windowRegistry.all()) {
            if (!wCtx.browserWindow.isDestroyed()) {
              try {
                sendToRenderer(wCtx.browserWindow, CHANNELS.WINDOW_RECLAIM_MEMORY, {
                  reason: "memory-pressure",
                });
              } catch {
                /* non-critical */
              }
            }
          }
        }
      },
      destroyHiddenWebviews: async (tier) => {
        // Destroy hidden portal tabs for ALL windows
        if (windowRegistry) {
          for (const wCtx of windowRegistry.all()) {
            if (wCtx.browserWindow.isDestroyed()) continue;
            try {
              if (wCtx.services.portalManager) {
                const evictedTabIds = await wCtx.services.portalManager.destroyHiddenTabs();
                if (evictedTabIds.length > 0) {
                  sendToRenderer(wCtx.browserWindow, CHANNELS.PORTAL_TABS_EVICTED, {
                    tabIds: evictedTabIds,
                  });
                }
              }
            } catch {
              /* non-critical */
            }
            try {
              sendToRenderer(wCtx.browserWindow, CHANNELS.WINDOW_DESTROY_HIDDEN_WEBVIEWS, {
                tier,
              });
            } catch {
              /* non-critical */
            }
          }
        }
      },
      hibernateIdleProjects: async () => {
        await getHibernationService().hibernateUnderMemoryPressure();
      },
      trimPtyHostState: () => {
        ptyClient?.trimState(SCROLLBACK_BACKGROUND);
      },
    });
  }

  // Resource Profile Service
  if (!resourceProfileService) {
    resourceProfileService = new ResourceProfileService({
      getPtyClient: () => ptyClient,
      getWorkspaceClient: () => workspaceClient,
      getHibernationService: () => getHibernationService(),
    });
    resourceProfileService.start();
  }

  // ── Last-window-close: dispose global services ──
  // Per-window cleanup is handled by ctx.cleanup (run by WindowRegistry.unregister).
  // This handler only disposes global singletons when the last window closes.
  win.on("closed", async () => {
    if (windowRegistry && windowRegistry.size > 0) {
      // Other windows still open — do not dispose global services
      return;
    }

    // Last window closed — dispose global services
    if (stopEventLoopLagMonitor) {
      stopEventLoopLagMonitor();
      stopEventLoopLagMonitor = null;
    }
    if (stopProcessMemoryMonitor) {
      stopProcessMemoryMonitor();
      stopProcessMemoryMonitor = null;
    }
    if (stopAppMetricsMonitor) {
      stopAppMetricsMonitor();
      stopAppMetricsMonitor = null;
    }
    if (stopDiskSpaceMonitor) {
      stopDiskSpaceMonitor();
      stopDiskSpaceMonitor = null;
    }
    if (resourceProfileService) {
      resourceProfileService.stop();
      resourceProfileService = null;
    }

    if (worktreePortBroker) worktreePortBroker.dispose();
    worktreePortBroker = null;
    if (workspaceClient) workspaceClient.dispose();
    workspaceClient = null;
    disposeWorkspaceClient();

    disposeTaskOrchestrator();
    disposeAgentRouter();
    disposePowerSaveBlockerService();
    disposeAgentAvailabilityStore();

    if (ptyClient) ptyClient.dispose();
    ptyClient = null;
    disposePtyClient();

    // Clean up IPC handlers and reset guards so next window re-registers fresh
    if (cleanupIpcHandlers) {
      cleanupIpcHandlers();
      cleanupIpcHandlers = null;
    }
    if (cleanupErrorHandlers) {
      cleanupErrorHandlers();
      cleanupErrorHandlers = null;
    }
    ipcHandlersRegistered = false;
    globalServicesInitialized = false;

    getSystemSleepService().dispose();
    notificationService.dispose();
    agentNotificationService.dispose();
    preAgentSnapshotService.dispose();
    autoUpdaterService.dispose();
  });
}
