import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  MessageChannelMain,
  MessagePortMain,
  session,
} from "electron";
import os from "os";
import { randomBytes } from "crypto";
import type { HandlerDependencies } from "../ipc/types.js";
import { registerIpcHandlers, sendToRenderer } from "../ipc/handlers.js";
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
import { GitHubAuth } from "../services/github/GitHubAuth.js";
import { secureStorage } from "../services/SecureStorage.js";
import { notificationService } from "../services/NotificationService.js";
import { agentNotificationService } from "../services/AgentNotificationService.js";
import {
  initializeAgentAvailabilityStore,
  disposeAgentAvailabilityStore,
} from "../services/AgentAvailabilityStore.js";
import {
  initializePowerSaveBlockerService,
  disposePowerSaveBlockerService,
} from "../services/PowerSaveBlockerService.js";
import { initializeAgentRouter, disposeAgentRouter } from "../services/AgentRouter.js";
import { initializeWorkflowEngine, disposeWorkflowEngine } from "../services/WorkflowEngine.js";
import { workflowLoader } from "../services/WorkflowLoader.js";
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
import { startDiskSpaceMonitor, getCurrentDiskSpaceStatus } from "../services/DiskSpaceMonitor.js";
import { SCROLLBACK_BACKGROUND } from "../../shared/config/scrollback.js";
import { logInfo, setLoggerWindow } from "../utils/logger.js";
import { PERF_MARKS } from "../../shared/perf/marks.js";
import { isSmokeTest, isDemoMode, smokeTestStart, exposeGc } from "../setup/environment.js";
import { extractCliPath, getPendingCliPath, setPendingCliPath } from "../lifecycle/appLifecycle.js";

const DEFAULT_TERMINAL_ID = "default";

// Module-level mutable service refs
let ptyClient: PtyClient | null = null;
let workspaceClient: WorkspaceClient | null = null;
let cliAvailabilityService: CliAvailabilityService | null = null;
let agentVersionService: AgentVersionService | null = null;
let agentUpdateHandler: AgentUpdateHandler | null = null;
let portalManager: PortalManager | null = null;
let projectSwitchService: ProjectSwitchService | null = null;
let cleanupIpcHandlers: (() => void) | null = null;
let cleanupErrorHandlers: (() => void) | null = null;
let eventBuffer: EventBuffer | null = null;
let eventBufferUnsubscribe: (() => void) | null = null;
let activeRendererPort: MessagePortMain | null = null;
let activePtyHostPort: MessagePortMain | null = null;
let stopEventLoopLagMonitor: (() => void) | null = null;
let stopProcessMemoryMonitor: (() => void) | null = null;
let stopAppMetricsMonitor: (() => void) | null = null;
let stopDiskSpaceMonitor: (() => void) | null = null;

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
export function getProjectSwitchServiceRef(): ProjectSwitchService | null {
  return projectSwitchService;
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

function createAndDistributePorts(win: BrowserWindow): void {
  if (activeRendererPort) {
    try {
      activeRendererPort.close();
    } catch {
      /* ignore */
    }
  }
  if (activePtyHostPort) {
    try {
      activePtyHostPort.close();
    } catch {
      /* ignore */
    }
  }

  const { port1, port2 } = new MessageChannelMain();
  const handshakeToken = randomBytes(32).toString("hex");

  activeRendererPort = port1;
  activePtyHostPort = port2;

  if (ptyClient) {
    ptyClient.connectMessagePort(port2);
  }

  if (win && !win.isDestroyed()) {
    win.webContents.postMessage("terminal-port-token", { token: handshakeToken });
    win.webContents.postMessage("terminal-port", { token: handshakeToken }, [port1]);
  }
}

async function initializeDeferredServices(
  window: BrowserWindow,
  cliService: CliAvailabilityService,
  eventBuf: EventBuffer
): Promise<void> {
  console.log("[MAIN] Initializing deferred services in background...");
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

  initializeSystemSleepService();
  console.log("[MAIN] SystemSleepService initialized");

  eventBuf.start();
  console.log("[MAIN] EventBuffer started");

  mcpServerService.start(window).catch((err) => {
    console.error("[MAIN] MCP server failed to start:", err);
  });

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
  console.log(`[MAIN] All deferred services initialized in ${elapsed}ms`);
}

export interface SetupWindowServicesOptions {
  loadRenderer: (reason: string) => void;
  smokeTestTimer: ReturnType<typeof setTimeout> | undefined;
  smokeRendererUnresponsive: () => boolean;
  windowRegistry?: import("./WindowRegistry.js").WindowRegistry;
}

export async function setupWindowServices(
  win: BrowserWindow,
  opts: SetupWindowServicesOptions
): Promise<void> {
  // Store migrations
  console.log("[MAIN] Running store migrations...");
  try {
    const migrationRunner = new MigrationRunner(store);
    await migrationRunner.runMigrations(migrations);
    console.log("[MAIN] Store migrations completed");
  } catch (error) {
    console.error("[MAIN] Store migration failed:", error);
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox(
      "Migration Failed",
      `Failed to migrate application data:\n\n${message}\n\nThe application will now exit. Please check the logs for details.`
    );
    app.exit(1);
    return;
  }

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

  // Menu & Notifications
  console.log("[MAIN] Creating application menu (initial, no agent availability yet)...");
  cliAvailabilityService = new CliAvailabilityService();
  createApplicationMenu(win, cliAvailabilityService);

  notificationService.initialize(win);
  agentNotificationService.initialize();
  console.log("[MAIN] NotificationService initialized");

  // Critical services
  console.log("[MAIN] Starting critical services...");

  ptyClient = new PtyClient({
    maxRestartAttempts: 3,
    healthCheckIntervalMs: 30000,
    showCrashDialog: true,
  });

  agentVersionService = new AgentVersionService(cliAvailabilityService);
  agentUpdateHandler = new AgentUpdateHandler(
    ptyClient,
    agentVersionService,
    cliAvailabilityService
  );

  ptyClient.on("host-crash-details", (details) => {
    console.error(`[MAIN] Pty Host crashed:`, details);
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      try {
        win.webContents.send(CHANNELS.TERMINAL_BACKEND_CRASHED, {
          crashType: details.crashType,
          code: details.code,
          signal: details.signal,
          timestamp: details.timestamp,
        });
      } catch {
        // Silently ignore send failures during window disposal.
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
    try {
      sendToRenderer(win, CHANNELS.WINDOW_RECLAIM_MEMORY, { reason: "pty-host-pressure" });
    } catch {
      /* non-critical */
    }
    try {
      ptyClient!.trimState(SCROLLBACK_BACKGROUND);
    } catch {
      /* non-critical */
    }
  });
  ptyClient.setPortRefreshCallback(() => {
    console.log("[MAIN] Pty Host restarted, refreshing ports...");
    createAndDistributePorts(win);
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      try {
        win.webContents.send(CHANNELS.TERMINAL_BACKEND_READY);
      } catch {
        // Silently ignore send failures during window disposal.
      }
    }
  });

  eventBuffer = new EventBuffer(1000);
  portalManager = new PortalManager(win);

  console.log("[MAIN] Registering IPC handlers...");
  const handlerDeps: HandlerDependencies = {
    mainWindow: win,
    ptyClient,
    eventBuffer,
    portalManager,
    cliAvailabilityService,
    agentVersionService,
    agentUpdateHandler,
    isDemoMode,
    windowRegistry: opts.windowRegistry,
  };

  projectSwitchService = new ProjectSwitchService(handlerDeps);
  handlerDeps.projectSwitchService = projectSwitchService;

  cleanupIpcHandlers = registerIpcHandlers(handlerDeps);

  // Wait for pty-host before workspace-host
  console.log("[MAIN] Waiting for Pty Host to be ready before starting Workspace Host...");
  try {
    await ptyClient.waitForReady();
    console.log("[MAIN] Pty Host ready, starting Workspace Host...");
  } catch (error) {
    console.error("[MAIN] Pty Host failed to start:", error);
  }

  workspaceClient = getWorkspaceClient({
    maxRestartAttempts: 3,
    healthCheckIntervalMs: 60000,
    showCrashDialog: true,
  });

  handlerDeps.worktreeService = workspaceClient;

  const { armRestoreQuota } = await import("../ipc/utils.js");
  armRestoreQuota(50, 120_000);

  opts.loadRenderer("after-services-ready");

  cleanupErrorHandlers = registerErrorHandlers(win, workspaceClient, ptyClient);

  console.log("[MAIN] All critical services ready");

  // Handle reloads
  win.webContents.on("did-finish-load", () => {
    const currentUrl = win.webContents.getURL();
    if (currentUrl.includes("recovery.html")) {
      console.log("[MAIN] Recovery page loaded, skipping normal renderer bootstrap");
      return;
    }
    console.log("[MAIN] Renderer loaded, ensuring MessagePort connection...");
    if (isSmokeTest) console.error("[SMOKE] CHECK: Renderer did-finish-load — OK");
    markPerformance(PERF_MARKS.RENDERER_READY);
    createAndDistributePorts(win);
    flushPendingErrors();
    const diskStatus = getCurrentDiskSpaceStatus();
    if (diskStatus.status !== "normal") {
      sendToRenderer(win, CHANNELS.WINDOW_DISK_SPACE_STATUS, diskStatus);
    }
  });

  workspaceClient.on("host-crash", (code: number) => {
    console.error(`[MAIN] Workspace Host crashed with code ${code}`);
  });

  // Wait for remaining services
  console.log("[MAIN] Waiting for remaining services to initialize...");
  let ptyReady = false;
  let workspaceReady = false;

  try {
    const results = await Promise.allSettled([
      ptyClient.waitForReady(),
      workspaceClient.waitForReady(),
      projectStore.initialize(),
    ]);

    ptyReady = results[0].status === "fulfilled";
    workspaceReady = results[1].status === "fulfilled";
    const projectStoreReady = results[2].status === "fulfilled";

    if (ptyReady && workspaceReady && projectStoreReady) {
      console.log("[MAIN] All critical services ready");
    } else {
      const failures: string[] = [];
      if (!ptyReady)
        failures.push(
          `PTY service: ${results[0].status === "rejected" ? results[0].reason?.message || "unknown error" : "timeout"}`
        );
      if (!workspaceReady)
        failures.push(
          `Workspace service: ${results[1].status === "rejected" ? results[1].reason?.message || "unknown error" : "timeout"}`
        );
      if (!projectStoreReady)
        failures.push(
          `Project store: ${results[2].status === "rejected" ? results[2].reason?.message || "unknown error" : "timeout"}`
        );

      console.error("[MAIN] Service initialization failed:", failures);

      dialog
        .showMessageBox({
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
    createAndDistributePorts(win);

    const currentProjectId = projectStore.getCurrentProjectId();
    ptyClient.setActiveProject(currentProjectId);

    const availabilityStore = initializeAgentAvailabilityStore();
    const agentRouter = initializeAgentRouter(availabilityStore);
    initializePowerSaveBlockerService();
    console.log("[MAIN] AgentAvailabilityStore, AgentRouter, and PowerSaveBlocker initialized");

    initializeTaskOrchestrator(ptyClient, agentRouter);
    console.log("[MAIN] TaskOrchestrator initialized");

    const pendingCliPath = extractCliPath(process.argv) ?? getPendingCliPath();
    if (pendingCliPath) {
      console.log("[MAIN] CLI path pending, skipping default terminal spawn");
    } else {
      console.log("[MAIN] Spawning default terminal...");
      try {
        ptyClient.spawn(DEFAULT_TERMINAL_ID, {
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

  // Load worktrees
  const currentProject = projectStore.getCurrentProject();
  if (currentProject && workspaceClient && workspaceReady) {
    console.log("[MAIN] Loading worktrees for current project:", currentProject.name);
    try {
      await workspaceClient.loadProject(currentProject.path);
      console.log("[MAIN] Worktrees loaded for current project");
    } catch (error) {
      console.error("[MAIN] Failed to load worktrees for current project:", error);
    }
  } else if (currentProject && !workspaceReady) {
    console.warn("[MAIN] Workspace service unavailable - skipping worktree loading");
  }

  // Task queue & workflow
  if (currentProject) {
    console.log("[MAIN] Initializing task queue for current project:", currentProject.name);
    try {
      await taskQueueService.initialize(currentProject.id);
      console.log("[MAIN] Task queue initialized for current project");
    } catch (error) {
      console.error("[MAIN] Failed to initialize task queue:", error);
    }

    try {
      await workflowLoader.initialize();
      initializeWorkflowEngine();
      console.log("[MAIN] WorkflowEngine initialized");
    } catch (error) {
      console.error("[MAIN] Failed to initialize workflow engine:", error);
    }
  }

  // Event inspector
  let eventInspectorActive = false;
  ipcMain.on(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE, () => {
    eventInspectorActive = true;
  });
  ipcMain.on(CHANNELS.EVENT_INSPECTOR_UNSUBSCRIBE, () => {
    eventInspectorActive = false;
  });

  const unsubscribeFromEventBuffer = eventBuffer.onRecord((record) => {
    if (!eventInspectorActive) return;
    sendToRenderer(win, CHANNELS.EVENT_INSPECTOR_EVENT, record);
  });

  eventBufferUnsubscribe = () => {
    unsubscribeFromEventBuffer();
    ipcMain.removeAllListeners(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE);
    ipcMain.removeAllListeners(CHANNELS.EVENT_INSPECTOR_UNSUBSCRIBE);
  };

  // Auto-updater
  autoUpdaterService.initialize(win);

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
  initializeDeferredServices(win, cliAvailabilityService!, eventBuffer!).catch((error) => {
    console.error("[MAIN] Deferred services initialization failed:", error);
  });

  getCrashRecoveryService().startBackupTimer();

  // Disk space monitor
  if (!stopDiskSpaceMonitor) {
    stopDiskSpaceMonitor = startDiskSpaceMonitor({
      sendStatus: (payload) => {
        sendToRenderer(win, CHANNELS.WINDOW_DISK_SPACE_STATUS, payload);
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

  // CLI path handling
  const firstLaunchCliPath = extractCliPath(process.argv);
  const cliPath = firstLaunchCliPath ?? getPendingCliPath();
  if (cliPath) {
    setPendingCliPath(null);
    console.log("[MAIN] Opening CLI path from launch args:", cliPath);
    handleDirectoryOpen(cliPath, win, cliAvailabilityService ?? undefined).catch((err) =>
      console.error("[MAIN] Failed to open CLI path:", err)
    );
  }

  // Performance monitors
  if (!stopEventLoopLagMonitor) {
    stopEventLoopLagMonitor = startEventLoopLagMonitor();
  }
  if (process.env.CANOPY_PERF_CAPTURE === "1" && !stopProcessMemoryMonitor) {
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
        try {
          sendToRenderer(win, CHANNELS.WINDOW_RECLAIM_MEMORY, { reason: "memory-pressure" });
        } catch {
          /* non-critical */
        }
      },
      destroyHiddenWebviews: async (tier) => {
        // Destroy hidden portal tabs (main-process WebContentsViews)
        try {
          if (portalManager) {
            const evictedTabIds = portalManager.destroyHiddenTabs();
            if (evictedTabIds.length > 0) {
              sendToRenderer(win, CHANNELS.PORTAL_TABS_EVICTED, { tabIds: evictedTabIds });
            }
          }
        } catch {
          /* non-critical */
        }
        // Signal renderer to destroy hidden <webview> tags
        try {
          sendToRenderer(win, CHANNELS.WINDOW_DESTROY_HIDDEN_WEBVIEWS, { tier });
        } catch {
          /* non-critical */
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

  // Cleanup handler
  win.on("closed", async () => {
    if (eventBufferUnsubscribe) eventBufferUnsubscribe();
    if (eventBuffer) eventBuffer.stop();
    if (cleanupIpcHandlers) cleanupIpcHandlers();
    if (cleanupErrorHandlers) cleanupErrorHandlers();
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

    // Clean up window-specific IPC handlers
    ipcMain.removeHandler(CHANNELS.WINDOW_TOGGLE_FULLSCREEN);
    ipcMain.removeHandler(CHANNELS.WINDOW_RELOAD);
    ipcMain.removeHandler(CHANNELS.WINDOW_FORCE_RELOAD);
    ipcMain.removeHandler(CHANNELS.WINDOW_TOGGLE_DEVTOOLS);
    ipcMain.removeHandler(CHANNELS.WINDOW_ZOOM_IN);
    ipcMain.removeHandler(CHANNELS.WINDOW_ZOOM_OUT);
    ipcMain.removeHandler(CHANNELS.WINDOW_ZOOM_RESET);
    ipcMain.removeHandler(CHANNELS.WINDOW_CLOSE);

    if (workspaceClient) workspaceClient.dispose();
    workspaceClient = null;
    disposeWorkspaceClient();

    if (portalManager) portalManager.destroy();
    portalManager = null;

    disposeTaskOrchestrator();
    disposeAgentRouter();
    disposePowerSaveBlockerService();
    disposeAgentAvailabilityStore();
    disposeWorkflowEngine();

    projectSwitchService = null;

    if (ptyClient) ptyClient.dispose();
    ptyClient = null;
    disposePtyClient();

    getSystemSleepService().dispose();
    notificationService.dispose();
    agentNotificationService.dispose();
    autoUpdaterService.dispose();

    setLoggerWindow(null);
  });
}
