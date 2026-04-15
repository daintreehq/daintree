// Environment setup must run first (GC exposure, userData, flags, sandbox)
import "./setup/environment.js";

import { app, BrowserWindow, crashReporter, protocol } from "electron";
import { registerGlobalErrorHandlers } from "./setup/globalErrorHandlers.js";
import path from "path";
import { fileURLToPath } from "url";
import { PERF_MARKS } from "../shared/perf/marks.js";
import { markPerformance } from "./utils/performance.js";
import { enforceIpcSenderValidation, setupPermissionLockdown } from "./setup/security.js";
import {
  registerAppProtocol,
  registerDaintreeFileProtocol,
  setupWebviewCSP,
} from "./setup/protocols.js";
import { registerAppLifecycleHandlers } from "./lifecycle/appLifecycle.js";
import { registerShutdownHandler } from "./lifecycle/shutdown.js";
import {
  setMainWindow,
  getMainWindow,
  setWindowRegistry,
  setProjectViewManager,
  getProjectViewManager,
} from "./window/windowRef.js";
import { WindowRegistry } from "./window/WindowRegistry.js";
import { ProjectViewManager } from "./window/ProjectViewManager.js";
import { setupBrowserWindow } from "./window/createWindow.js";
import { distributePortsToView } from "./window/portDistribution.js";
import {
  setupWindowServices,
  getPtyClient,
  setPtyClientRef,
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
} from "./window/windowServices.js";
import {
  setupPowerMonitor,
  setupWindowFocusThrottle,
  registerWindowForFocusThrottle,
} from "./window/powerMonitor.js";
import { getProjectStatsService } from "./ipc/handlers/projectCrud.js";
import { isSmokeTest } from "./setup/environment.js";
import { store } from "./store.js";
import { pruneOldLogs, initializeLogger, registerLoggerTransport } from "./utils/logger.js";
import { broadcastToRenderer } from "./ipc/utils.js";
import { registerCommands } from "./services/commands/index.js";
import { initializeTelemetry } from "./services/TelemetryService.js";
import { initializeCrashRecoveryService } from "./services/CrashRecoveryService.js";
import { initializeGpuCrashMonitor } from "./services/GpuCrashMonitorService.js";
import { initializeTrashedPidCleanup } from "./services/TrashedPidTracker.js";
import { initializeCrashLoopGuard, getCrashLoopGuard } from "./services/CrashLoopGuardService.js";
import { initializeDatabaseMaintenance } from "./services/DatabaseMaintenanceService.js";
import { readLastActiveProjectIdSync } from "./services/persistence/readLastProjectId.js";

// CRITICAL: Run IPC sender validation before any handlers are registered
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
      codeCache: true,
    },
  },
  {
    scheme: "daintree-file",
    privileges: {
      secure: true,
      supportFetchAPI: true,
    },
  },
]);

// V8 tuning for renderer processes: heap limits and GC exposure
app.commandLine.appendSwitch(
  "js-flags",
  "--max-old-space-size=768 --max-semi-space-size=64 --expose-gc"
);

// Allow autoplay without user gesture (voice input, media panels).
// Per-view throttling is managed by ProjectViewManager.setBackgroundThrottling().
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
// Disable unused Chromium features: BackForwardCache wastes memory (no browser navigation),
// CalculateNativeWinOcclusion causes unnecessary power usage on macOS
const disabledFeatures = ["BackForwardCache"];
if (process.platform === "darwin") disabledFeatures.push("CalculateNativeWinOcclusion");
app.commandLine.appendSwitch("disable-features", disabledFeatures.join(","));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Acquire single-instance lock before any file I/O or service initialization.
// A second instance must not touch log files, telemetry, or crash reporters.
const gotTheLock = isSmokeTest || app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log("[MAIN] Another instance is already running. Quitting...");
  app.quit();
} else {
  // Prune old log files based on retention setting
  {
    const retentionDays = store.get("privacy")?.logRetentionDays ?? 30;
    if (retentionDays > 0) {
      pruneOldLogs(app.getPath("userData"), retentionDays);
    }
  }

  initializeLogger(app.getPath("userData"));

  registerLoggerTransport(broadcastToRenderer, () => BrowserWindow.getAllWindows().length > 0);

  registerCommands();

  void initializeTelemetry();

  crashReporter.start({ uploadToServer: false });
  initializeCrashLoopGuard();
  registerGlobalErrorHandlers();

  const distPath = path.join(__dirname, "../../dist");

  initializeCrashRecoveryService();
  initializeDatabaseMaintenance();
  initializeTrashedPidCleanup();
  initializeGpuCrashMonitor();

  const windowRegistry = new WindowRegistry();
  setWindowRegistry(windowRegistry);

  // Read last-active projectId synchronously from SQLite BEFORE creating any window.
  // This allows the initial WebContentsView to use the correct session partition,
  // giving crash isolation and V8 code cache benefits from the first render.
  const lastActiveProjectId = readLastActiveProjectIdSync();

  let powerMonitorInitialized = false;

  async function createWindow(
    initialProjectPath?: string | null,
    initialProjectId?: string
  ): Promise<void> {
    const { win, appView, loadRenderer, smokeTestTimer, smokeRendererUnresponsive } =
      setupBrowserWindow(__dirname, {
        onRecreateWindow: () => createWindow(initialProjectPath, initialProjectId),
        onCreateWindow: (projectPath?: string) => createWindow(projectPath),
        projectPath: initialProjectPath,
        initialProjectId,
      });
    setMainWindow(win);
    const ctx = windowRegistry.register(win, { projectPath: initialProjectPath ?? undefined });
    windowRegistry.registerAppViewWebContents(ctx.windowId, appView.webContents.id);

    const pvm = new ProjectViewManager(win, {
      dirname: __dirname,
      onRecreateWindow: () => createWindow(initialProjectPath, initialProjectId),
      windowRegistry,
      cachedProjectViews:
        store.get("terminalConfig")?.cachedProjectViews ??
        // E2E tests add and switch projects rapidly. Keeping more than one
        // cached view alive is required so the wizard rendered in the
        // originating project view survives a switch into a freshly added
        // project view. Increase the cache only when the e2e harness flag is
        // set so production behavior is unchanged.
        (process.env.DAINTREE_E2E_MODE ? 4 : undefined),
      onViewEvicted: (wcId) => {
        getWorkspaceClientRef()?.removeDirectPort(wcId);
        getWorktreePortBrokerRef()?.closePortsForView(wcId);
      },
      onViewReady: (wc) => {
        // Re-distribute PTY MessagePort on every view load/reload.
        // This ensures terminals work after view creation, crash recovery, or DevTools refresh.
        if (win.isDestroyed() || wc.isDestroyed()) return;
        const wCtx = windowRegistry.getByWindowId(win.id);
        if (wCtx) {
          distributePortsToView(win, wCtx, wc, getPtyClient());
        }
        // Refresh workspace direct port (preload context is reset on reload)
        getWorkspaceClientRef()?.attachDirectPort(win.id, wc);

        // Re-broker worktree port (preload context is reset on reload)
        const broker = getWorktreePortBrokerRef();
        const wsClient = getWorkspaceClientRef();
        if (broker && wsClient) {
          const pvm = getProjectViewManager();
          const projectId = pvm?.getProjectIdForWebContents(wc.id);
          if (projectId) {
            // Find the project path from PVM to look up the host
            const viewEntry = pvm?.getAllViews().find((v) => v.projectId === projectId);
            if (viewEntry) {
              const host = wsClient.getHostForProject(viewEntry.projectPath);
              if (host) {
                broker.brokerPort(host, wc);
              }
            }
          }
        }
      },
    });
    setProjectViewManager(pvm);

    // Clean up ProjectViewManager when window closes
    win.once("closed", () => {
      pvm.dispose();
      setProjectViewManager(null);
    });

    await setupWindowServices(win, {
      loadRenderer,
      smokeTestTimer,
      smokeRendererUnresponsive,
      windowRegistry,
      initialProjectPath: initialProjectPath ?? undefined,
      initialProjectId,
      projectViewManager: pvm,
      initialAppView: appView,
    });

    if (!powerMonitorInitialized) {
      powerMonitorInitialized = true;
      setupPowerMonitor({
        getPtyClient,
        getWorkspaceClient: getWorkspaceClientRef,
      });
      setupWindowFocusThrottle({
        getPtyClient,
        getWorkspaceClient: getWorkspaceClientRef,
        getProjectStatsService,
      });
    }

    registerWindowForFocusThrottle(win);
  }

  registerAppLifecycleHandlers({
    onCreateWindow: () => createWindow(),
    onCreateWindowForPath: (cliPath) => createWindow(cliPath),
    getMainWindow,
    getCliAvailabilityService: getCliAvailabilityServiceRef,
    windowRegistry,
  });

  registerShutdownHandler({
    getPtyClient,
    setPtyClient: setPtyClientRef,
    getWorkspaceClient: getWorkspaceClientRef,
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
    windowRegistry,
  });

  app.whenReady().then(async () => {
    try {
      setupPermissionLockdown();
      registerAppProtocol(distPath);
      registerDaintreeFileProtocol();
      setupWebviewCSP();
      await createWindow(undefined, lastActiveProjectId ?? undefined);
      getCrashLoopGuard().startStabilityTimer();
    } catch (error) {
      console.error("[MAIN] Startup failed:", error);
      app.exit(1);
    }
  });
}
