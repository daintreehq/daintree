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
  registerCanopyFileProtocol,
  setupWebviewCSP,
} from "./setup/protocols.js";
import { registerAppLifecycleHandlers } from "./lifecycle/appLifecycle.js";
import { registerShutdownHandler } from "./lifecycle/shutdown.js";
import { setMainWindow, getMainWindow, setWindowRegistry } from "./window/windowRef.js";
import { WindowRegistry } from "./window/WindowRegistry.js";
import { setupBrowserWindow } from "./window/createWindow.js";
import {
  setupWindowServices,
  getPtyClient,
  setPtyClientRef,
  getWorkspaceClientRef,
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
import { setupPowerMonitor } from "./window/powerMonitor.js";
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
    scheme: "canopy-file",
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

// Keep the renderer process at full priority and prevent AudioContext suspension
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
if (process.platform === "darwin") {
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
}

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

  setupPermissionLockdown();

  let powerMonitorInitialized = false;

  async function createWindow(initialProjectPath?: string | null): Promise<void> {
    const { win, loadRenderer, smokeTestTimer, smokeRendererUnresponsive } = setupBrowserWindow(
      __dirname,
      {
        onRecreateWindow: () => createWindow(initialProjectPath),
        onCreateWindow: (projectPath?: string) => createWindow(projectPath),
        projectPath: initialProjectPath,
      }
    );
    setMainWindow(win);
    windowRegistry.register(win, { projectPath: initialProjectPath ?? undefined });

    await setupWindowServices(win, {
      loadRenderer,
      smokeTestTimer,
      smokeRendererUnresponsive,
      windowRegistry,
      initialProjectPath: initialProjectPath ?? undefined,
    });

    if (!powerMonitorInitialized) {
      powerMonitorInitialized = true;
      setupPowerMonitor({
        getPtyClient,
        getWorkspaceClient: getWorkspaceClientRef,
      });
    }
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
      registerAppProtocol(distPath);
      registerCanopyFileProtocol();
      setupWebviewCSP();
      await createWindow();
      getCrashLoopGuard().startStabilityTimer();
    } catch (error) {
      console.error("[MAIN] Startup failed:", error);
      app.exit(1);
    }
  });
}
