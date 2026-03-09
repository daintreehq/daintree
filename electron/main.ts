import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  powerMonitor,
  MessageChannelMain,
  MessagePortMain,
  protocol,
  net,
  session,
} from "electron";
import path from "path";
import { existsSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import os from "os";
import { randomBytes } from "crypto";
import fixPath from "fix-path";
import { isTrustedRendererUrl } from "../shared/utils/trustedRenderer.js";
import { isLocalhostUrl } from "../shared/utils/urlUtils.js";
import { getDevServerUrl } from "../shared/config/devServer.js";
import { PERF_MARKS } from "../shared/perf/marks.js";
import type { IpcMainInvokeEvent } from "electron";
import {
  markPerformance,
  startEventLoopLagMonitor,
  startProcessMemoryMonitor,
} from "./utils/performance.js";

fixPath();

// In development, use a separate userData directory so the dev instance
// doesn't conflict with the production app's single-instance lock or storage.
if (!app.isPackaged) {
  app.setPath("userData", path.join(app.getPath("appData"), `${app.name}-dev`));
}

// Enable native Wayland support on Linux (Electron < 38)
// Electron 38+ auto-detects via XDG_SESSION_TYPE; this flag is ignored.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("ozone-platform-hint", "auto");
  if (process.env.XDG_SESSION_TYPE === "wayland") {
    app.commandLine.appendSwitch("enable-features", "WaylandWindowDecorations");
    app.commandLine.appendSwitch("enable-wayland-ime");
  }
}

if (process.platform === "win32") {
  const extraPaths = [
    path.join(os.homedir(), "AppData", "Local", "Programs", "Git", "cmd"),
    "C:\\Program Files\\Git\\cmd",
    path.join(os.homedir(), ".local", "bin"),
  ];
  const current = process.env.PATH || "";
  const existingEntries = current.split(path.delimiter).map((e) => e.toLowerCase());
  const missing = extraPaths.filter(
    (p) => !existingEntries.includes(p.toLowerCase()) && existsSync(p)
  );
  if (missing.length) {
    process.env.PATH = [...missing, current].join(path.delimiter);
  }
}

const isSmokeTest = process.argv.includes("--smoke-test");
const smokeTestStart = isSmokeTest ? Date.now() : 0;
if (isSmokeTest) {
  console.log("[SMOKE] Smoke test mode enabled");
  console.log("[SMOKE] Platform:", process.platform, process.arch);
  console.log("[SMOKE] Electron:", process.versions.electron);
  console.log("[SMOKE] Node:", process.versions.node);
  console.log("[SMOKE] Chrome:", process.versions.chrome);

  // Fail fast on renderer or child process crashes
  app.on("render-process-gone", (_event, _wc, details) => {
    if (details.reason !== "clean-exit") {
      console.error(
        `[SMOKE] FAILED — renderer process gone: reason=${details.reason}, exitCode=${details.exitCode}`
      );
      app.exit(1);
    }
  });
  app.on("child-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit") {
      console.error(
        `[SMOKE] FAILED — child process gone: type=${details.type}, reason=${details.reason}, exitCode=${details.exitCode}`
      );
      if (details.type === "GPU" || details.type === "Utility") {
        app.exit(1);
      }
    }
  });

  // Verify native module (node-pty) loads and bindings work
  try {
    const pty = await import("node-pty");
    const testProc = pty.spawn(process.platform === "win32" ? "cmd.exe" : "echo", ["smoke"], {
      cols: 80,
      rows: 24,
    });
    testProc.kill();
    console.log("[SMOKE] CHECK: node-pty native module — OK");
  } catch (err) {
    console.error("[SMOKE] FAILED — node-pty native module:", (err as Error).message);
    app.exit(1);
  }
}

app.enableSandbox();

// Prevent macOS keychain prompt ("canopy-app Safe Storage").
// Chromium encrypts cookies/network state via the OS keychain by default.
// We don't rely on Chromium cookie encryption — all secrets are in electron-store.
app.commandLine.appendSwitch("use-mock-keychain");

// Wrap ipcMain.handle globally to enforce sender validation on ALL IPC handlers
// This must run before any handlers are registered
function enforceIpcSenderValidation() {
  const originalHandle = ipcMain.handle.bind(ipcMain);
  const originalHandleOnce = ipcMain.handleOnce?.bind(ipcMain);

  ipcMain.handle = function (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown> | unknown
  ) {
    return originalHandle(channel, async (event, ...args) => {
      const senderUrl = event.senderFrame?.url;
      if (!senderUrl || !isTrustedRendererUrl(senderUrl)) {
        throw new Error(
          `IPC call from untrusted origin rejected: channel=${channel}, url=${senderUrl || "unknown"}`
        );
      }
      try {
        return await listener(event, ...args);
      } catch (error) {
        if (app.isPackaged) {
          console.error(`[IPC] Error on channel ${channel}:`, error);
          const msg = (error instanceof Error ? error.message : String(error))
            .replace(/\/(?:Users|home|tmp|private|var)\/[^\s:]+/gi, "<path>")
            .replace(/[A-Z]:[/\\](?:Users|Program Files|Windows|ProgramData)[^\s:]*/gi, "<path>")
            .replace(/\\\\(?:[^\s\\]+)\\(?:[^\s:]+)/g, "<path>");
          const safe = new Error(msg);
          safe.stack = undefined;
          throw safe;
        }
        throw error;
      }
    });
  } as typeof ipcMain.handle;

  if (originalHandleOnce) {
    ipcMain.handleOnce = function (
      channel: string,
      listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown> | unknown
    ) {
      return originalHandleOnce(channel, async (event, ...args) => {
        const senderUrl = event.senderFrame?.url;
        if (!senderUrl || !isTrustedRendererUrl(senderUrl)) {
          throw new Error(
            `IPC call from untrusted origin rejected: channel=${channel}, url=${senderUrl || "unknown"}`
          );
        }
        try {
          return await listener(event, ...args);
        } catch (error) {
          if (app.isPackaged) {
            console.error(`[IPC] Error on channel ${channel}:`, error);
            const msg = (error instanceof Error ? error.message : String(error))
              .replace(/\/(?:Users|home|tmp|private|var)\/[^\s:]+/gi, "<path>")
              .replace(/[A-Z]:[/\\](?:Users|Program Files|Windows|ProgramData)[^\s:]*/gi, "<path>")
              .replace(/\\\\(?:[^\s\\]+)\\(?:[^\s:]+)/g, "<path>");
            const safe = new Error(msg);
            safe.stack = undefined;
            throw safe;
          }
          throw error;
        }
      });
    } as typeof ipcMain.handleOnce;
  }

  // Extend validation to ipcMain.on (fire-and-forget channels like terminal:input).
  // Unlike handle channels which can throw, on channels silently drop untrusted messages.
  // We maintain a listener map so removeListener/off can find wrapped versions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- IPC listeners have heterogeneous signatures
  type IpcOnListener = (...args: any[]) => void;
  const onListenerMap = new Map<string, Map<IpcOnListener, IpcOnListener>>();

  const originalOn = ipcMain.on.bind(ipcMain);
  ipcMain.on = function (channel: string, listener: IpcOnListener) {
    const wrapped = (event: Electron.IpcMainEvent, ...args: unknown[]) => {
      const senderUrl = event.senderFrame?.url;
      if (!senderUrl || !isTrustedRendererUrl(senderUrl)) {
        console.warn(
          `[IPC] Rejected ipcMain.on message from untrusted origin: channel=${channel}, url=${senderUrl || "unknown"}`
        );
        return;
      }
      return listener(event, ...args);
    };

    if (!onListenerMap.has(channel)) onListenerMap.set(channel, new Map());
    onListenerMap.get(channel)!.set(listener, wrapped);

    return originalOn(channel, wrapped);
  } as typeof ipcMain.on;

  const originalRemoveListener = ipcMain.removeListener.bind(ipcMain);
  ipcMain.removeListener = function (channel: string, listener: IpcOnListener) {
    const channelMap = onListenerMap.get(channel);
    const wrapped = channelMap?.get(listener);
    if (wrapped) {
      channelMap!.delete(listener);
      if (channelMap!.size === 0) onListenerMap.delete(channel);
      return originalRemoveListener(channel, wrapped as IpcOnListener);
    }
    return originalRemoveListener(channel, listener);
  } as typeof ipcMain.removeListener;

  ipcMain.off = ipcMain.removeListener;

  const originalRemoveAllListeners = ipcMain.removeAllListeners.bind(ipcMain);
  ipcMain.removeAllListeners = function (channel?: string) {
    if (channel !== undefined) {
      onListenerMap.delete(channel);
    } else {
      onListenerMap.clear();
    }
    return originalRemoveAllListeners(channel);
  } as typeof ipcMain.removeAllListeners;

  console.log("[MAIN] IPC sender validation enforced globally (handle + on)");
}

// CRITICAL: Run this before any IPC handlers are registered
enforceIpcSenderValidation();
markPerformance(PERF_MARKS.APP_BOOT_START);

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

// Keep the renderer process at full priority and prevent AudioContext suspension
// when the window loses focus — required for continuous voice recording in the background.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
// Prevent macOS occlusion-based throttling when the window is covered by another app.
if (process.platform === "darwin") {
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
}

import { registerIpcHandlers, sendToRenderer } from "./ipc/handlers.js";
import type { HandlerDependencies } from "./ipc/types.js";
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
import {
  classifyPartition,
  getLocalhostDevCSP,
  mergeCspHeaders,
  isDevPreviewPartition,
} from "./utils/webviewCsp.js";
import { EventBuffer } from "./services/EventBuffer.js";
import { CHANNELS } from "./ipc/channels.js";
import { createApplicationMenu, handleDirectoryOpen } from "./menu.js";
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
import { agentNotificationService } from "./services/AgentNotificationService.js";
import { registerCommands } from "./services/commands/index.js";
import {
  initializeTaskOrchestrator,
  disposeTaskOrchestrator,
} from "./services/TaskOrchestrator.js";
import {
  initializeAgentAvailabilityStore,
  disposeAgentAvailabilityStore,
} from "./services/AgentAvailabilityStore.js";
import { initializeAgentRouter, disposeAgentRouter } from "./services/AgentRouter.js";
import { initializeWorkflowEngine, disposeWorkflowEngine } from "./services/WorkflowEngine.js";
import { workflowLoader } from "./services/WorkflowLoader.js";
import { autoUpdaterService } from "./services/AutoUpdaterService.js";
import { SMOKE_BOOT_TIMEOUT_MS, runSmokeFunctionalChecks } from "./services/smokeTest.js";
import { initializeTelemetry } from "./services/TelemetryService.js";
import { mcpServerService } from "./services/McpServerService.js";
import {
  initializeCrashRecoveryService,
  getCrashRecoveryService,
} from "./services/CrashRecoveryService.js";

// Initialize logger early with userData path
initializeLogger(app.getPath("userData"));

// Register commands early so they're available when IPC handlers start
registerCommands();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Telemetry must be initialized before error handlers so Sentry captures uncaught errors
void initializeTelemetry();

process.on("uncaughtException", (error) => {
  console.error("[FATAL] Uncaught Exception:", error);
  // Note: crash recording is handled by the running.lock marker approach — the marker
  // written at startup is only removed on clean exit, so actual process deaths are
  // automatically detected on the next launch without needing recordCrash() here.
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[FATAL] Unhandled Promise Rejection at:", promise, "reason:", reason);
  // Same as above — the marker handles crash detection; rejections may not kill the process.
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
// Retain strong references to MessagePorts to prevent V8 GC from collecting them,
// which can cause ACCESS_VIOLATION crashes on Windows (the C++ backing objects get freed
// while the utility process still references them).
let activeRendererPort: MessagePortMain | null = null;
let activePtyHostPort: MessagePortMain | null = null;
let stopEventLoopLagMonitor: (() => void) | null = null;
let stopProcessMemoryMonitor: (() => void) | null = null;

const DEFAULT_TERMINAL_ID = "default";

let isQuitting = false;
let resumeTimeout: NodeJS.Timeout | null = null;

/** Path passed via CLI that hasn't been opened yet (app may still be initializing) */
let pendingCliPath: string | null = null;

function extractCliPath(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cli-path" && argv[i + 1]) {
      return argv[i + 1];
    }
    if (argv[i].startsWith("--cli-path=")) {
      return argv[i].slice("--cli-path=".length);
    }
  }
  return null;
}

const gotTheLock = isSmokeTest || app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log("[MAIN] Another instance is already running. Quitting...");
  app.quit();
} else {
  // Initialize crash recovery only in the winning instance — a losing second instance
  // must not consume/delete the current session's marker before it quits.
  initializeCrashRecoveryService();

  app.on("second-instance", (_event, commandLine, _workingDirectory) => {
    console.log("[MAIN] Second instance detected, focusing main window");
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const cliPath = extractCliPath(commandLine);
    if (cliPath) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log("[MAIN] Opening CLI path from second instance:", cliPath);
        handleDirectoryOpen(cliPath, mainWindow, cliAvailabilityService ?? undefined).catch((err) =>
          console.error("[MAIN] Failed to open CLI path:", err)
        );
      } else {
        // Window not ready yet — queue for when createWindow() completes
        pendingCliPath = cliPath;
        console.log("[MAIN] Queuing CLI path for when window is ready:", cliPath);
      }
    }
  });

  app.whenReady().then(async () => {
    try {
      registerAppProtocol();
      setupWebviewCSP();
      await createWindow();
    } catch (error) {
      console.error("[MAIN] Startup failed:", error);
      app.exit(1);
    }
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
    if (isQuitting || !mainWindow || isSmokeTest) {
      return;
    }

    event.preventDefault();
    isQuitting = true;

    console.log("[MAIN] Starting graceful shutdown...");
    getCrashRecoveryService().cleanupOnExit();

    // NOTE: Terminal state is persisted by the renderer via appClient.setState()
    // in terminalRegistrySlice.ts. We don't overwrite it here because:
    // 1. Renderer state includes command/location fields needed for restoration
    // 2. PtyManager only has runtime state (id/type/title/cwd), missing persistence fields
    // 3. Overwriting would strip command field, breaking agent terminal restoration

    Promise.all([
      workspaceClient ? workspaceClient.dispose() : Promise.resolve(),
      mcpServerService.stop(),
      new Promise<void>((resolve) => {
        // Dispose orchestrator and routing before ptyClient to prevent event handlers from firing
        disposeTaskOrchestrator();
        disposeAgentRouter();
        disposeAgentAvailabilityStore();
        disposeWorkflowEngine();

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
        if (stopEventLoopLagMonitor) {
          stopEventLoopLagMonitor();
          stopEventLoopLagMonitor = null;
        }
        if (stopProcessMemoryMonitor) {
          stopProcessMemoryMonitor();
          stopProcessMemoryMonitor = null;
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

/**
 * Configures CSP headers for webview partitions.
 * Applies idempotent CSP injection to prevent multiple registrations.
 * Sidecar is excluded to preserve origin CSP from external sites.
 */
function setupWebviewCSP(): void {
  const configuredPartitions = new Set<string>();

  const applyCSP = (partition: string): void => {
    if (configuredPartitions.has(partition)) {
      return;
    }

    const partitionType = classifyPartition(partition);
    if (partitionType === "unknown" || partitionType === "sidecar") {
      // Skip unknown partitions and sidecar (external sites keep their own CSP)
      return;
    }

    const ses = session.fromPartition(partition);
    const cspPolicy = getLocalhostDevCSP();

    ses.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: mergeCspHeaders(details, cspPolicy),
      });
    });

    configuredPartitions.add(partition);
    console.log(`[MAIN] CSP configured for partition: ${partition} (${partitionType})`);
  };

  // Configure static partitions (browser only - sidecar excluded)
  applyCSP("persist:browser");

  // Monitor for dynamic dev-preview partitions
  // Dev preview uses dynamic partitions like "persist:dev-preview-project-worktree-panel"
  // We intercept will-attach-webview to detect and configure them
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (_event, _webPreferences, params) => {
      const partition = params.partition;
      if (partition && isDevPreviewPartition(partition)) {
        applyCSP(partition);
      }
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

  mcpServerService.start(window).catch((err) => {
    console.error("[MAIN] MCP server failed to start:", err);
  });

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

  let smokeTestTimer: ReturnType<typeof setTimeout> | undefined;
  let smokeRendererUnresponsive = false;
  if (isSmokeTest) {
    console.log("[SMOKE] Starting %ds startup safety timeout", SMOKE_BOOT_TIMEOUT_MS / 1000);
    smokeTestTimer = setTimeout(() => {
      console.error("[SMOKE] FAILED — app did not finish loading within startup timeout");
      app.exit(1);
    }, SMOKE_BOOT_TIMEOUT_MS);
    smokeTestTimer.unref();
  }

  // Lock down permissions on untrusted sessions to prevent OS permission prompts
  // Deny all for untrusted content (browser, dev-preview, sidecar)
  // Allow minimal permissions for trusted app renderer (clipboard read/write only)
  function lockdownUntrustedPermissions(ses: Electron.Session): void {
    ses.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
  }

  function lockdownTrustedPermissions(ses: Electron.Session): void {
    const trustedPermissions = new Set(["clipboard-sanitized-write", "clipboard-read", "media"]);
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(trustedPermissions.has(permission));
    });
    ses.setPermissionCheckHandler((_wc, permission) => {
      return trustedPermissions.has(permission);
    });
  }

  // Lock down default session (trusted app renderer) with clipboard allowlist
  lockdownTrustedPermissions(session.defaultSession);

  // Lock down known untrusted sessions
  lockdownUntrustedPermissions(session.fromPartition("persist:browser"));

  // Sidecar needs clipboard access for AI chat copy buttons (navigator.clipboard.writeText)
  // but all other permissions (camera, mic, geolocation, etc.) remain denied
  const sidecarSession = session.fromPartition("persist:sidecar");
  sidecarSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "clipboard-sanitized-write");
  });
  sidecarSession.setPermissionCheckHandler((_wc, permission) => {
    return permission === "clipboard-sanitized-write";
  });

  // Catch all dynamically created sessions (e.g., persist:dev-preview-*)
  app.on("session-created", (ses) => {
    const partition = (ses as any).partition ?? "";
    // Dev-preview and any other dynamic partitions are untrusted
    if (partition.startsWith("persist:dev-preview") || partition.startsWith("persist:browser")) {
      lockdownUntrustedPermissions(ses);
    }
  });

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

  // Initialize GitHubAuth with storage (must happen in main process, before workspace client starts)
  GitHubAuth.initializeStorage({
    get: () => secureStorage.get("userConfig.githubToken"),
    set: (token) => secureStorage.set("userConfig.githubToken", token),
    delete: () => secureStorage.delete("userConfig.githubToken"),
  });
  console.log("[MAIN] GitHubAuth initialized with storage");

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
      navigateOnDragDrop: false,
      backgroundThrottling: false,
    },
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 12, y: 18 },
        }
      : {
          titleBarStyle: "hidden" as const,
          ...(process.platform === "win32" && {
            titleBarOverlay: {
              color: "#19191a",
              symbolColor: "#a1a1aa",
              height: 36,
            },
          }),
        }),
    backgroundColor: "#19191a",
  });
  markPerformance(PERF_MARKS.MAIN_WINDOW_CREATED);

  if (isSmokeTest) {
    mainWindow.on("unresponsive", () => {
      smokeRendererUnresponsive = true;
      console.error("[SMOKE] FAILED — main window became unresponsive");
    });
  }

  let rendererLoadRequested = false;
  const loadRenderer = (reason: string): void => {
    if (!mainWindow || mainWindow.isDestroyed() || rendererLoadRequested) return;
    rendererLoadRequested = true;
    console.log(`[MAIN] Loading renderer (${reason})...`);
    if (process.env.NODE_ENV === "development") {
      const devServerUrl = getDevServerUrl();
      console.log(`[MAIN] Loading Vite dev server at ${devServerUrl}`);
      mainWindow.loadURL(devServerUrl);
    } else {
      console.log("[MAIN] Loading production build via app:// protocol");
      mainWindow.loadURL("app://canopy/index.html");
    }
  };

  // Renderer load is deferred until after IPC handlers are registered to prevent
  // race conditions where the renderer makes IPC calls before handlers exist.

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
    const isAllowedLocalhostUrl = isLocalhostUrl(params.src);
    const isValidPartition =
      allowedPartitions.includes(params.partition || "") ||
      (params.partition?.startsWith("persist:dev-preview-") ?? false);

    if (!isAllowedLocalhostUrl || !isValidPartition) {
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
    webPreferences.navigateOnDragDrop = false;
    webPreferences.disableBlinkFeatures = "Auxclick";
  });

  // Prevent Cmd+W (macOS) / Ctrl+W (Windows/Linux) from closing the window.
  // Using setIgnoreMenuShortcuts instead of event.preventDefault() so the keypress
  // still reaches the renderer's keybinding system (which dispatches terminal.close).
  const wc = mainWindow.webContents;
  wc.on("before-input-event", (_event, input) => {
    const isMac = process.platform === "darwin";
    const isCloseShortcut =
      input.type === "keyDown" &&
      input.key.toLowerCase() === "w" &&
      ((isMac && input.meta && !input.control) || (!isMac && input.control && !input.meta)) &&
      !input.alt;

    wc.setIgnoreMenuShortcuts(isCloseShortcut);
  });

  setLoggerWindow(mainWindow);

  // Detect renderer crashes and record them
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    console.error("[MAIN] Renderer process gone:", details.reason, details.exitCode);
    getCrashRecoveryService().recordCrash(
      new Error(`Renderer process gone: ${details.reason} (exit code ${details.exitCode})`)
    );
  });

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
    if (!app.isPackaged) {
      event.sender.toggleDevTools();
    }
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
  agentNotificationService.initialize();
  console.log("[MAIN] NotificationService initialized");

  // Initialize Service Instances
  // On Windows, stagger utility process forks to reduce resource contention
  // that can cause ACCESS_VIOLATION (0xC0000005) crashes on CI runners.
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

  // Initialize synchronous services before handler registration
  eventBuffer = new EventBuffer(1000);
  sidecarManager = new SidecarManager(mainWindow);

  // Register IPC handlers BEFORE loading the renderer so that no IPC calls
  // arrive before handlers exist. The deps object is mutable — workspaceClient
  // is assigned after pty-host is ready, and handlers access it lazily.
  console.log("[MAIN] Registering IPC handlers...");
  const handlerDeps: HandlerDependencies = {
    mainWindow,
    ptyClient,
    eventBuffer,
    sidecarManager,
    cliAvailabilityService,
    agentVersionService,
    agentUpdateHandler,
  };
  cleanupIpcHandlers = registerIpcHandlers(handlerDeps);

  // Wait for pty-host to be ready before forking workspace-host.
  // Staggering prevents two utility processes from simultaneously loading
  // native modules (node-pty, simple-git) which can crash on Windows CI.
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

  // Assign late-init workspaceClient to deps so handlers see it
  handlerDeps.worktreeService = workspaceClient;

  // Now safe to load renderer — all handlers registered and all services ready
  loadRenderer("after-services-ready");

  cleanupErrorHandlers = registerErrorHandlers(mainWindow, workspaceClient, ptyClient);

  console.log("[MAIN] All critical services ready");

  function createAndDistributePorts(): void {
    // Close previous ports before creating new ones
    if (activeRendererPort) {
      try {
        activeRendererPort.close();
      } catch {
        // ignore
      }
    }
    if (activePtyHostPort) {
      try {
        activePtyHostPort.close();
      } catch {
        // ignore
      }
    }

    const { port1, port2 } = new MessageChannelMain();
    const handshakeToken = randomBytes(32).toString("hex");

    // Retain strong references to prevent V8 GC from freeing the C++ backing
    // objects while utility processes still hold references — this can cause
    // ACCESS_VIOLATION (0xC0000005) crashes on Windows.
    activeRendererPort = port1;
    activePtyHostPort = port2;

    if (ptyClient) {
      ptyClient.connectMessagePort(port2);
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.postMessage("terminal-port-token", { token: handshakeToken });
      mainWindow.webContents.postMessage("terminal-port", { token: handshakeToken }, [port1]);
    }
  }

  // Handle reloads
  mainWindow.webContents.on("did-finish-load", () => {
    console.log("[MAIN] Renderer loaded, ensuring MessagePort connection...");
    if (isSmokeTest) console.log("[SMOKE] CHECK: Renderer did-finish-load — OK");
    markPerformance(PERF_MARKS.RENDERER_READY);
    createAndDistributePorts();
  });

  workspaceClient.on("host-crash", (code: number) => {
    console.error(`[MAIN] Workspace Host crashed with code ${code}`);
  });

  // WAIT for remaining services (pty-host already awaited above during staggered startup)
  console.log("[MAIN] Waiting for remaining services to initialize...");
  let ptyReady = false;
  let workspaceReady = false;

  try {
    // pty-host was already awaited before workspace-host fork; re-check resolves instantly
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

    // Initialize agent availability tracking and routing
    const availabilityStore = initializeAgentAvailabilityStore();
    const agentRouter = initializeAgentRouter(availabilityStore);
    console.log("[MAIN] AgentAvailabilityStore and AgentRouter initialized");

    // Initialize TaskOrchestrator for task queue coordination
    initializeTaskOrchestrator(ptyClient, agentRouter);
    console.log("[MAIN] TaskOrchestrator initialized");

    // Spawn Default Terminal
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

    // Initialize WorkflowEngine after task queue is ready
    try {
      await workflowLoader.initialize();
      initializeWorkflowEngine();
      console.log("[MAIN] WorkflowEngine initialized");
    } catch (error) {
      console.error("[MAIN] Failed to initialize workflow engine:", error);
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

  // Initialize auto-updater (checks for updates on startup and periodically)
  autoUpdaterService.initialize(mainWindow);

  if (isSmokeTest) {
    if (smokeTestTimer) clearTimeout(smokeTestTimer);
    const bootMs = Date.now() - smokeTestStart;
    console.log("[SMOKE] CHECK: Window created — OK");
    console.log("[SMOKE] CHECK: PTY service — %s", ptyReady ? "OK" : "FAILED");
    console.log("[SMOKE] CHECK: Workspace service — %s", workspaceReady ? "OK" : "FAILED");
    console.log("[SMOKE] CHECK: Auto-updater module — OK");
    console.log("[SMOKE] GPU feature status:", JSON.stringify(app.getGPUFeatureStatus()));
    console.log("[SMOKE] Boot completed in %dms", bootMs);

    if (!ptyReady || !workspaceReady) {
      console.error("[SMOKE] FAILED — one or more services did not start");
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
      workspaceClient.dispose();
      ptyClient.dispose();
      app.exit(1);
      return;
    }

    // ptyClient is guaranteed non-null here since ptyReady is true,
    // but TypeScript can't narrow through the boolean check.
    const smokeClient = ptyClient!;
    const allPassed = await runSmokeFunctionalChecks(
      mainWindow,
      smokeClient,
      () => smokeRendererUnresponsive
    );

    // Destroy window first to stop renderer IPC calls, then dispose clients
    // to suppress host-exit handlers, then exit.
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    try {
      workspaceClient.dispose();
    } catch {
      // Ignore cleanup errors in smoke mode.
    }
    try {
      ptyClient.dispose();
    } catch {
      // Ignore cleanup errors in smoke mode.
    }
    app.exit(allPassed ? 0 : 1);
    return;
  }

  // Initialize Deferred Services
  initializeDeferredServices(mainWindow, cliAvailabilityService!, eventBuffer!).catch((error) => {
    console.error("[MAIN] Deferred services initialization failed:", error);
  });

  // Start periodic session backups for crash recovery
  getCrashRecoveryService().startBackupTimer();

  // Handle path provided via CLI on first launch (e.g. `canopy /path/to/repo`)
  const firstLaunchCliPath = extractCliPath(process.argv);
  const cliPath = firstLaunchCliPath ?? pendingCliPath;
  if (cliPath) {
    pendingCliPath = null;
    console.log("[MAIN] Opening CLI path from launch args:", cliPath);
    handleDirectoryOpen(cliPath, mainWindow, cliAvailabilityService ?? undefined).catch((err) =>
      console.error("[MAIN] Failed to open CLI path:", err)
    );
  }

  if (process.env.CANOPY_PERF_CAPTURE === "1" && !stopEventLoopLagMonitor) {
    stopEventLoopLagMonitor = startEventLoopLagMonitor();
  }
  if (process.env.CANOPY_PERF_CAPTURE === "1" && !stopProcessMemoryMonitor) {
    stopProcessMemoryMonitor = startProcessMemoryMonitor();
  }

  // Cleanup handler
  mainWindow.on("closed", async () => {
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
    disposeAgentRouter();
    disposeAgentAvailabilityStore();
    disposeWorkflowEngine();

    if (ptyClient) ptyClient.dispose();
    disposePtyClient();

    getSystemSleepService().dispose();
    notificationService.dispose();
    agentNotificationService.dispose();
    autoUpdaterService.dispose();

    setLoggerWindow(null);
    mainWindow = null;
  });
}
