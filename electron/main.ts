import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  powerMonitor,
  MessageChannelMain,
  protocol,
  net,
} from "electron";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import os from "os";
import { randomBytes } from "crypto";
import fixPath from "fix-path";
import { isTrustedRendererUrl } from "../shared/utils/trustedRenderer.js";
import type { IpcMainInvokeEvent } from "electron";

fixPath();

// Wrap ipcMain.handle globally to enforce sender validation on ALL IPC handlers
// This must run before any handlers are registered
function enforceIpcSenderValidation() {
  const originalHandle = ipcMain.handle.bind(ipcMain);
  const originalHandleOnce = ipcMain.handleOnce?.bind(ipcMain);

  ipcMain.handle = function (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<any> | any
  ) {
    return originalHandle(channel, async (event, ...args) => {
      const senderUrl = event.senderFrame?.url;
      if (!senderUrl || !isTrustedRendererUrl(senderUrl)) {
        throw new Error(
          `IPC call from untrusted origin rejected: channel=${channel}, url=${senderUrl || "unknown"}`
        );
      }
      return listener(event, ...args);
    });
  } as typeof ipcMain.handle;

  if (originalHandleOnce) {
    ipcMain.handleOnce = function (
      channel: string,
      listener: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<any> | any
    ) {
      return originalHandleOnce(channel, async (event, ...args) => {
        const senderUrl = event.senderFrame?.url;
        if (!senderUrl || !isTrustedRendererUrl(senderUrl)) {
          throw new Error(
            `IPC call from untrusted origin rejected: channel=${channel}, url=${senderUrl || "unknown"}`
          );
        }
        return listener(event, ...args);
      });
    } as typeof ipcMain.handleOnce;
  }

  console.log("[MAIN] IPC sender validation enforced globally");
}

// CRITICAL: Run this before any IPC handlers are registered
enforceIpcSenderValidation();

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

// Increase V8 heap size for renderer processes to handle large clipboard data
// Maximum is 4GB due to V8 pointer compression in Electron 9+
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=4096");

import { registerIpcHandlers, sendToRenderer } from "./ipc/handlers.js";
import { registerErrorHandlers } from "./ipc/errorHandlers.js";
import { PtyClient, disposePtyClient } from "./services/PtyClient.js";
import {
  getWorkspaceClient,
  disposeWorkspaceClient,
  WorkspaceClient,
} from "./services/WorkspaceClient.js";
import { CliAvailabilityService } from "./services/CliAvailabilityService.js";
import { AgentVersionService } from "./services/AgentVersionService.js";
import { AgentUpdateHandler } from "./services/AgentUpdateHandler.js";
import { SidecarManager } from "./services/SidecarManager.js";
import { createWindowWithState } from "./windowState.js";
import { setLoggerWindow, initializeLogger } from "./utils/logger.js";
import { openExternalUrl } from "./utils/openExternal.js";
import { EventBuffer } from "./services/EventBuffer.js";
import { CHANNELS } from "./ipc/channels.js";
import { createApplicationMenu } from "./menu.js";
import { resolveAppUrlToDistPath, getMimeType, buildHeaders } from "./utils/appProtocol.js";
import { projectStore } from "./services/ProjectStore.js";
import { taskQueueService } from "./services/TaskQueueService.js";
import { store } from "./store.js";
import { MigrationRunner } from "./services/StoreMigrations.js";
import { migrations } from "./services/migrations/index.js";
import { initializeHibernationService } from "./services/HibernationService.js";
import { GitHubAuth } from "./services/github/GitHubAuth.js";
import { secureStorage } from "./services/SecureStorage.js";
import {
  initializeSystemSleepService,
  getSystemSleepService,
} from "./services/SystemSleepService.js";
import { notificationService } from "./services/NotificationService.js";
import { registerCommands } from "./services/commands/index.js";
import {
  initializeTaskOrchestrator,
  disposeTaskOrchestrator,
} from "./services/TaskOrchestrator.js";

// Initialize logger early with userData path
initializeLogger(app.getPath("userData"));

// Register commands early so they're available when IPC handlers start
registerCommands();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.on("uncaughtException", (error) => {
  console.error("[FATAL] Uncaught Exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[FATAL] Unhandled Promise Rejection at:", promise, "reason:", reason);
});

let mainWindow: BrowserWindow | null = null;
let ptyClient: PtyClient | null = null;
let workspaceClient: WorkspaceClient | null = null;
let cliAvailabilityService: CliAvailabilityService | null = null;
let agentVersionService: AgentVersionService | null = null;
let agentUpdateHandler: AgentUpdateHandler | null = null;
let sidecarManager: SidecarManager | null = null;
let cleanupIpcHandlers: (() => void) | null = null;
let cleanupErrorHandlers: (() => void) | null = null;
let eventBuffer: EventBuffer | null = null;
let eventBufferUnsubscribe: (() => void) | null = null;

const DEFAULT_TERMINAL_ID = "default";

let isQuitting = false;
let resumeTimeout: NodeJS.Timeout | null = null;

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log("[MAIN] Another instance is already running. Quitting...");
  app.quit();
} else {
  app.on("second-instance", (_event, _commandLine, _workingDirectory) => {
    console.log("[MAIN] Second instance detected, focusing main window");
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    registerAppProtocol();
    createWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  app.on("before-quit", (event) => {
    if (isQuitting || !mainWindow) {
      return;
    }

    event.preventDefault();
    isQuitting = true;

    console.log("[MAIN] Starting graceful shutdown...");

    // NOTE: Terminal state is persisted by the renderer via appClient.setState()
    // in terminalRegistrySlice.ts. We don't overwrite it here because:
    // 1. Renderer state includes command/location fields needed for restoration
    // 2. PtyManager only has runtime state (id/type/title/cwd), missing persistence fields
    // 3. Overwriting would strip command field, breaking agent terminal restoration

    Promise.all([
      workspaceClient ? workspaceClient.dispose() : Promise.resolve(),
      new Promise<void>((resolve) => {
        // Dispose orchestrator before ptyClient to prevent event handlers from firing
        disposeTaskOrchestrator();

        if (ptyClient) {
          ptyClient.dispose();
          ptyClient = null;
        }
        disposePtyClient();
        disposeWorkspaceClient();
        resolve();
      }),
    ])
      .then(() => {
        if (cleanupIpcHandlers) {
          cleanupIpcHandlers();
          cleanupIpcHandlers = null;
        }
        if (cleanupErrorHandlers) {
          cleanupErrorHandlers();
          cleanupErrorHandlers = null;
        }
        console.log("[MAIN] Graceful shutdown complete");
        app.exit(0);
      })
      .catch((error) => {
        console.error("[MAIN] Error during cleanup:", error);
        app.exit(1);
      });
  });
}

function registerAppProtocol(): void {
  const distPath = path.join(__dirname, "../../dist");

  protocol.handle("app", async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: buildHeaders("text/plain"),
      });
    }

    const { filePath, error } = resolveAppUrlToDistPath(request.url, distPath, {
      expectedHostname: "canopy",
    });

    if (error || !filePath) {
      console.error("[MAIN] App protocol error:", error);
      return new Response("Not Found", {
        status: 404,
        headers: buildHeaders("text/plain"),
      });
    }

    try {
      const fileUrl = pathToFileURL(filePath).toString();
      const response = await net.fetch(fileUrl);

      if (!response.ok) {
        return new Response("Not Found", {
          status: 404,
          headers: { "Content-Type": "text/plain" },
        });
      }

      const mimeType = getMimeType(filePath);
      const headers = buildHeaders(mimeType);
      const buffer = await response.arrayBuffer();

      return new Response(buffer, {
        status: 200,
        headers: headers,
      });
    } catch (err) {
      console.error("[MAIN] Error serving file:", filePath, err);
      return new Response("Internal Server Error", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }
  });
}

async function initializeDeferredServices(
  window: BrowserWindow,
  cliService: CliAvailabilityService,
  eventBuf: EventBuffer
): Promise<void> {
  console.log("[MAIN] Initializing deferred services in background...");
  const startTime = Date.now();

  // Parallelize independent async services
  const results = await Promise.allSettled([
    cliService.checkAvailability().then((availability) => {
      console.log("[MAIN] CLI availability checked:", availability);
      console.log("[MAIN] Rebuilding menu with agent availability...");
      createApplicationMenu(window, cliService);
      return availability;
    }),
  ]);

  // Log any failures
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const serviceName = ["CliAvailabilityService"][index];
      console.error(`[MAIN] ${serviceName} initialization failed:`, result.reason);
    }
  });

  // Synchronous services
  initializeHibernationService();
  console.log("[MAIN] HibernationService initialized");

  initializeSystemSleepService();
  console.log("[MAIN] SystemSleepService initialized");

  eventBuf.start();
  console.log("[MAIN] EventBuffer started");

  const elapsed = Date.now() - startTime;
  console.log(`[MAIN] All deferred services initialized in ${elapsed}ms`);
}

async function createWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    console.log("[MAIN] Main window already exists, focusing");
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return;
  }

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

  // Initialize GitHubAuth with SecureStorage (must happen in main process, before workspace client starts)
  GitHubAuth.initializeStorage({
    get: () => secureStorage.get("userConfig.githubToken"),
    set: (token) => secureStorage.set("userConfig.githubToken", token),
    delete: () => secureStorage.delete("userConfig.githubToken"),
  });
  console.log("[MAIN] GitHubAuth initialized with SecureStorage");

  // If there's a stored token, validate it to cache user info
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

  console.log("[MAIN] Creating window...");
  mainWindow = createWindowWithState({
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 18 },
    backgroundColor: "#18181b",
  });

  console.log("[MAIN] Window created, loading content immediately (Paint First)...");

  // LOAD RENDERER IMMEDIATELY
  if (process.env.NODE_ENV === "development") {
    console.log("[MAIN] Loading Vite dev server at http://localhost:5173");
    mainWindow.loadURL("http://localhost:5173");
  } else {
    console.log("[MAIN] Loading production build via app:// protocol");
    mainWindow.loadURL("app://canopy/index.html");
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.log("[MAIN] setWindowOpenHandler triggered with URL:", url);
    if (
      url &&
      (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:"))
    ) {
      void openExternalUrl(url).catch((error) => {
        console.error("[MAIN] Failed to open external URL:", error);
      });
    } else {
      console.warn(`[MAIN] Blocked window.open for unsupported/empty URL: ${url}`);
    }
    return { action: "deny" };
  });

  // Block same-window navigations to untrusted origins (defense-in-depth)
  const webContents = mainWindow.webContents;
  webContents.on("will-navigate", (event, navigationUrl) => {
    if (!isTrustedRendererUrl(navigationUrl)) {
      console.error(
        "[MAIN] Blocked navigation to untrusted URL:",
        navigationUrl,
        "from:",
        webContents.getURL()
      );
      event.preventDefault();
    }
  });

  webContents.on("will-redirect", (event, redirectUrl) => {
    if (!isTrustedRendererUrl(redirectUrl)) {
      console.error(
        "[MAIN] Blocked redirect to untrusted URL:",
        redirectUrl,
        "from:",
        webContents.getURL()
      );
      event.preventDefault();
    }
  });

  // Harden webview security - prevent XSS from injecting malicious webviews
  mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    // Only allow localhost URLs (for dev servers) and the specific partitions we use
    const allowedPartitions = ["persist:browser", "persist:dev-preview"];
    const isLocalhostUrl =
      params.src.startsWith("http://localhost") || params.src.startsWith("http://127.0.0.1");
    const isValidPartition = allowedPartitions.includes(params.partition || "");

    if (!isLocalhostUrl || !isValidPartition) {
      console.warn(
        `[MAIN] Blocked webview attachment: url=${params.src}, partition=${params.partition}`
      );
      event.preventDefault();
      return;
    }

    // Strip any preload script to prevent privilege escalation
    delete webPreferences.preload;

    // Force secure settings
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
  });

  // Intercept Cmd+W (macOS) / Ctrl+W (Windows/Linux) to prevent window close.
  mainWindow.webContents.on("before-input-event", (event, input) => {
    const isMac = process.platform === "darwin";
    const isCloseShortcut =
      input.key.toLowerCase() === "w" &&
      ((isMac && input.meta && !input.control) || (!isMac && input.control && !input.meta)) &&
      !input.alt;

    if (isCloseShortcut) {
      event.preventDefault();
    }
  });

  setLoggerWindow(mainWindow);

  // Use simple-fullscreen events for pre-Lion fullscreen that extends into notch area
  mainWindow.on("enter-full-screen", () => {
    sendToRenderer(mainWindow!, CHANNELS.WINDOW_FULLSCREEN_CHANGE, true);
  });
  mainWindow.on("leave-full-screen", () => {
    sendToRenderer(mainWindow!, CHANNELS.WINDOW_FULLSCREEN_CHANGE, false);
  });
  // Simple fullscreen events (pre-Lion style, extends into notch)
  mainWindow.on("enter-html-full-screen", () => {
    sendToRenderer(mainWindow!, CHANNELS.WINDOW_FULLSCREEN_CHANGE, true);
  });
  mainWindow.on("leave-html-full-screen", () => {
    sendToRenderer(mainWindow!, CHANNELS.WINDOW_FULLSCREEN_CHANGE, false);
  });

  // IPC handler for toggling simple fullscreen from renderer
  ipcMain.handle(CHANNELS.WINDOW_TOGGLE_FULLSCREEN, () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const isSimpleFullScreen = mainWindow.isSimpleFullScreen();
      mainWindow.setSimpleFullScreen(!isSimpleFullScreen);
      return !isSimpleFullScreen;
    }
    return false;
  });

  ipcMain.handle(CHANNELS.WINDOW_RELOAD, (event) => {
    event.sender.reload();
  });

  ipcMain.handle(CHANNELS.WINDOW_FORCE_RELOAD, (event) => {
    event.sender.reloadIgnoringCache();
  });

  ipcMain.handle(CHANNELS.WINDOW_TOGGLE_DEVTOOLS, (event) => {
    event.sender.toggleDevTools();
  });

  const getZoomStep = () => 0.5;

  ipcMain.handle(CHANNELS.WINDOW_ZOOM_IN, (event) => {
    const current = event.sender.getZoomLevel();
    event.sender.setZoomLevel(current + getZoomStep());
  });

  ipcMain.handle(CHANNELS.WINDOW_ZOOM_OUT, (event) => {
    const current = event.sender.getZoomLevel();
    event.sender.setZoomLevel(current - getZoomStep());
  });

  ipcMain.handle(CHANNELS.WINDOW_ZOOM_RESET, (event) => {
    event.sender.setZoomLevel(0);
  });

  ipcMain.handle(CHANNELS.WINDOW_CLOSE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.close();
  });

  console.log("[MAIN] Creating application menu (initial, no agent availability yet)...");
  cliAvailabilityService = new CliAvailabilityService();
  createApplicationMenu(mainWindow, cliAvailabilityService);

  // Initialize Notification Service
  notificationService.initialize(mainWindow);
  console.log("[MAIN] NotificationService initialized");

  // Initialize Service Instances (Start processes in background)
  console.log("[MAIN] Starting critical services...");

  ptyClient = new PtyClient({
    maxRestartAttempts: 3,
    healthCheckIntervalMs: 30000,
    showCrashDialog: true,
  });

  // Initialize agent version and update services after ptyClient is available
  agentVersionService = new AgentVersionService(cliAvailabilityService);
  agentUpdateHandler = new AgentUpdateHandler(
    ptyClient,
    agentVersionService,
    cliAvailabilityService
  );

  // Attach crash listeners immediately to avoid race conditions
  ptyClient.on("host-crash-details", (details) => {
    console.error(`[MAIN] Pty Host crashed:`, details);

    // Forward to renderer with crash metadata
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      try {
        mainWindow.webContents.send(CHANNELS.TERMINAL_BACKEND_CRASHED, {
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
  ptyClient.setPortRefreshCallback(() => {
    console.log("[MAIN] Pty Host restarted, refreshing ports...");
    createAndDistributePorts();

    // Notify renderer that backend is back
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      try {
        mainWindow.webContents.send(CHANNELS.TERMINAL_BACKEND_READY);
      } catch {
        // Silently ignore send failures during window disposal.
      }
    }
  });

  workspaceClient = getWorkspaceClient({
    maxRestartAttempts: 3,
    healthCheckIntervalMs: 60000,
    showCrashDialog: true,
  });

  // Initialize Placeholder Services
  eventBuffer = new EventBuffer(1000);
  sidecarManager = new SidecarManager(mainWindow);

  // Register Handlers IMMEDIATELY (so IPC doesn't fail if UI is fast)
  console.log("[MAIN] Registering IPC handlers...");
  cleanupIpcHandlers = registerIpcHandlers(
    mainWindow,
    ptyClient,
    workspaceClient,
    eventBuffer,
    cliAvailabilityService,
    agentVersionService,
    agentUpdateHandler,
    sidecarManager
  );
  cleanupErrorHandlers = registerErrorHandlers(mainWindow, workspaceClient, ptyClient);

  function createAndDistributePorts(): void {
    const { port1, port2 } = new MessageChannelMain();
    const handshakeToken = randomBytes(32).toString("hex");

    if (ptyClient) {
      ptyClient.connectMessagePort(port2);
      // console.log("[MAIN] MessagePort sent to Pty Host");
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.postMessage("terminal-port-token", { token: handshakeToken });
      mainWindow.webContents.postMessage("terminal-port", { token: handshakeToken }, [port1]);
      // console.log("[MAIN] MessagePort sent to renderer");
    }
  }

  // Handle reloads
  mainWindow.webContents.on("did-finish-load", () => {
    console.log("[MAIN] Renderer loaded, ensuring MessagePort connection...");
    createAndDistributePorts();
  });

  workspaceClient.on("host-crash", (code: number) => {
    console.error(`[MAIN] Workspace Host crashed with code ${code}`);
  });

  // WAIT for services to be ready (Parallel)
  console.log("[MAIN] Waiting for services to initialize...");
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

      // Show error dialog so user knows something went wrong
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
    // This shouldn't happen with allSettled, but handle it just in case
    console.error("[MAIN] Unexpected error during service initialization:", error);
  }

  // Only set up PTY-related features if PTY is ready
  if (ptyReady) {
    createAndDistributePorts();

    // Ensure PTY host has an active project context even on cold start (no explicit switch yet).
    // This is important for project-aware PTY spawns that don't explicitly set projectId.
    const currentProjectId = projectStore.getCurrentProjectId();
    ptyClient.setActiveProject(currentProjectId);

    // Initialize TaskOrchestrator for task queue coordination
    initializeTaskOrchestrator(ptyClient);
    console.log("[MAIN] TaskOrchestrator initialized");

    // Spawn Default Terminal
    console.log("[MAIN] Spawning default terminal...");
    try {
      ptyClient.spawn(DEFAULT_TERMINAL_ID, {
        cwd: process.env.HOME || os.homedir(),
        cols: 80,
        rows: 30,
        projectId: currentProjectId ?? undefined,
      });
    } catch (error) {
      console.error("[MAIN] Failed to spawn default terminal:", error);
    }
  } else {
    console.warn("[MAIN] PTY service unavailable - skipping terminal setup");
  }

  // Load the current project's worktrees if workspace service is ready
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

  // Initialize task queue for the current project
  if (currentProject) {
    console.log("[MAIN] Initializing task queue for current project:", currentProject.name);
    try {
      await taskQueueService.initialize(currentProject.id);
      console.log("[MAIN] Task queue initialized for current project");
    } catch (error) {
      console.error("[MAIN] Failed to initialize task queue:", error);
    }
  }

  let eventInspectorActive = false;
  ipcMain.on(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE, () => {
    eventInspectorActive = true;
  });
  ipcMain.on(CHANNELS.EVENT_INSPECTOR_UNSUBSCRIBE, () => {
    eventInspectorActive = false;
  });

  const unsubscribeFromEventBuffer = eventBuffer.onRecord((record) => {
    if (!eventInspectorActive) return;
    sendToRenderer(mainWindow!, CHANNELS.EVENT_INSPECTOR_EVENT, record);
  });

  eventBufferUnsubscribe = () => {
    unsubscribeFromEventBuffer();
    ipcMain.removeAllListeners(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE);
    ipcMain.removeAllListeners(CHANNELS.EVENT_INSPECTOR_UNSUBSCRIBE);
  };

  // Power Monitor
  let suspendTime: number | null = null;
  powerMonitor.on("suspend", () => {
    if (resumeTimeout) clearTimeout(resumeTimeout);
    resumeTimeout = null;
    if (ptyClient) {
      ptyClient.pauseHealthCheck();
      ptyClient.pauseAll();
    }
    if (workspaceClient) {
      workspaceClient.pauseHealthCheck();
      workspaceClient.setPollingEnabled(false);
    }
    suspendTime = Date.now();
  });

  powerMonitor.on("resume", () => {
    if (resumeTimeout) clearTimeout(resumeTimeout);
    resumeTimeout = setTimeout(async () => {
      resumeTimeout = null;
      try {
        if (ptyClient) {
          ptyClient.resumeAll();
          ptyClient.resumeHealthCheck();
        }
        if (workspaceClient) {
          await workspaceClient.waitForReady();
          workspaceClient.setPollingEnabled(true);
          workspaceClient.resumeHealthCheck();
          await workspaceClient.refresh();
        }
        const sleepDuration = suspendTime ? Date.now() - suspendTime : 0;
        BrowserWindow.getAllWindows().forEach((win) => {
          if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
            try {
              win.webContents.send(CHANNELS.SYSTEM_WAKE, {
                sleepDuration,
                timestamp: Date.now(),
              });
            } catch {
              // Silently ignore send failures during window disposal.
            }
          }
        });
        suspendTime = null;
      } catch (error) {
        console.error("[MAIN] Error during resume:", error);
      }
    }, 2000);
  });

  // Initialize Deferred Services
  initializeDeferredServices(mainWindow, cliAvailabilityService!, eventBuffer!).catch((error) => {
    console.error("[MAIN] Deferred services initialization failed:", error);
  });

  // Cleanup handler
  mainWindow.on("closed", async () => {
    if (eventBufferUnsubscribe) eventBufferUnsubscribe();
    if (eventBuffer) eventBuffer.stop();
    if (cleanupIpcHandlers) cleanupIpcHandlers();
    if (cleanupErrorHandlers) cleanupErrorHandlers();

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
    disposeWorkspaceClient();

    if (sidecarManager) sidecarManager.destroy();

    disposeTaskOrchestrator();

    if (ptyClient) ptyClient.dispose();
    disposePtyClient();

    getSystemSleepService().dispose();
    notificationService.dispose();

    setLoggerWindow(null);
    mainWindow = null;
  });
}
