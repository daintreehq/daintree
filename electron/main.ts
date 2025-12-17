import { app, BrowserWindow, ipcMain, dialog, powerMonitor, MessageChannelMain } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import fixPath from "fix-path";

fixPath();

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
import { SidecarManager } from "./services/SidecarManager.js";
import { createWindowWithState } from "./windowState.js";
import { setLoggerWindow, initializeLogger } from "./utils/logger.js";
import { openExternalUrl } from "./utils/openExternal.js";
import { EventBuffer } from "./services/EventBuffer.js";
import { CHANNELS } from "./ipc/channels.js";
import { createApplicationMenu } from "./menu.js";

// Initialize logger early with userData path
initializeLogger(app.getPath("userData"));

import { projectStore } from "./services/ProjectStore.js";
import { store } from "./store.js";
import { MigrationRunner } from "./services/StoreMigrations.js";
import { migrations } from "./services/migrations/index.js";
import { initializeHibernationService } from "./services/HibernationService.js";
import {
  initializeSystemSleepService,
  getSystemSleepService,
} from "./services/SystemSleepService.js";
import { notificationService } from "./services/NotificationService.js";

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

  app.whenReady().then(createWindow);

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
    migrationRunner.runMigrations(migrations);
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

  console.log("[MAIN] Creating window...");
  mainWindow = createWindowWithState({
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 14 },
    backgroundColor: "#18181b",
  });

  console.log("[MAIN] Window created, loading content immediately (Paint First)...");

  // LOAD RENDERER IMMEDIATELY
  if (process.env.NODE_ENV === "development") {
    console.log("[MAIN] Loading Vite dev server at http://localhost:5173");
    mainWindow.loadURL("http://localhost:5173");
  } else {
    console.log("[MAIN] Loading production build");
    mainWindow.loadFile(path.join(__dirname, "../../dist/index.html"));
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

  mainWindow.on("enter-full-screen", () => {
    sendToRenderer(mainWindow!, CHANNELS.WINDOW_FULLSCREEN_CHANGE, true);
  });
  mainWindow.on("leave-full-screen", () => {
    sendToRenderer(mainWindow!, CHANNELS.WINDOW_FULLSCREEN_CHANGE, false);
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

  // Attach crash listeners immediately to avoid race conditions
  ptyClient.on("host-crash-details", (details) => {
    console.error(`[MAIN] Pty Host crashed:`, details);

    // Forward to renderer with crash metadata
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(CHANNELS.TERMINAL_BACKEND_CRASHED, {
        crashType: details.crashType,
        code: details.code,
        signal: details.signal,
        timestamp: details.timestamp,
      });
    }
  });
  ptyClient.on("host-crash", (code) => {
    console.error(`[MAIN] Pty Host crashed with code ${code} (max restarts exceeded)`);
  });
  ptyClient.setPortRefreshCallback(() => {
    console.log("[MAIN] Pty Host restarted, refreshing ports...");
    createAndDistributePorts();

    // Notify renderer that backend is back
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(CHANNELS.TERMINAL_BACKEND_READY);
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
    sidecarManager
  );
  cleanupErrorHandlers = registerErrorHandlers(mainWindow, workspaceClient, ptyClient);

  function createAndDistributePorts(): void {
    const { port1, port2 } = new MessageChannelMain();

    if (ptyClient) {
      ptyClient.connectMessagePort(port2);
      // console.log("[MAIN] MessagePort sent to Pty Host");
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.postMessage("terminal-port", null, [port1]);
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
  try {
    await Promise.all([
      ptyClient.waitForReady(),
      workspaceClient.waitForReady(),
      projectStore.initialize(),
    ]);
    console.log("[MAIN] All critical services ready");
  } catch (error) {
    console.error("[MAIN] Critical service initialization failed:", error);
    // Continue anyway? Or show error?
    // If critical services fail, app is broken. But we have error handlers.
  }

  // Now fully ready
  createAndDistributePorts();
  sendToRenderer(mainWindow, CHANNELS.SYSTEM_BACKEND_READY);

  // Spawn Default Terminal
  console.log("[MAIN] Spawning default terminal...");
  try {
    ptyClient.spawn(DEFAULT_TERMINAL_ID, {
      cwd: process.env.HOME || os.homedir(),
      cols: 80,
      rows: 30,
    });
  } catch (error) {
    console.error("[MAIN] Failed to spawn default terminal:", error);
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
          win.webContents.send(CHANNELS.SYSTEM_WAKE, {
            sleepDuration,
            timestamp: Date.now(),
          });
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

    if (workspaceClient) workspaceClient.dispose();
    disposeWorkspaceClient();

    if (sidecarManager) sidecarManager.destroy();

    if (ptyClient) ptyClient.dispose();
    disposePtyClient();

    getSystemSleepService().dispose();
    notificationService.dispose();

    setLoggerWindow(null);
    mainWindow = null;
  });
}
