// Environment setup must run first (GC exposure, userData, flags, sandbox)
import "./setup/environment.js";

import { app, crashReporter, protocol } from "electron";
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
import { pruneOldLogs, initializeLogger } from "./utils/logger.js";
import { registerCommands } from "./services/commands/index.js";
import { initializeTelemetry } from "./services/TelemetryService.js";
import { initializeCrashRecoveryService } from "./services/CrashRecoveryService.js";
import { initializeGpuCrashMonitor } from "./services/GpuCrashMonitorService.js";
import { initializeTrashedPidCleanup } from "./services/TrashedPidTracker.js";
import { initializeCrashLoopGuard, getCrashLoopGuard } from "./services/CrashLoopGuardService.js";

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

// V8 tuning for renderer processes: heap size, compact code preference, and GC exposure
app.commandLine.appendSwitch(
  "js-flags",
  "--max-old-space-size=4096 --optimize-for-size --expose-gc"
);

// Keep the renderer process at full priority and prevent AudioContext suspension
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
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
  registerCommands();

  void initializeTelemetry();

  crashReporter.start({ uploadToServer: false });
  initializeCrashLoopGuard();
  registerGlobalErrorHandlers();

  const distPath = path.join(__dirname, "../../dist");

  initializeCrashRecoveryService();
  initializeTrashedPidCleanup();
  initializeGpuCrashMonitor();

  const windowRegistry = new WindowRegistry();
  setWindowRegistry(windowRegistry);

  async function createWindow(): Promise<void> {
    const currentWindow = getMainWindow();
    if (currentWindow && !currentWindow.isDestroyed()) {
      console.log("[MAIN] Main window already exists, focusing");
      if (currentWindow.isMinimized()) currentWindow.restore();
      currentWindow.focus();
      return;
    }

    setupPermissionLockdown();

    const { win, loadRenderer, smokeTestTimer, smokeRendererUnresponsive } =
      setupBrowserWindow(__dirname);
    setMainWindow(win);
    windowRegistry.register(win);

    await setupWindowServices(win, {
      loadRenderer,
      smokeTestTimer,
      smokeRendererUnresponsive,
      windowRegistry,
    });

    setupPowerMonitor({
      getPtyClient,
      getWorkspaceClient: getWorkspaceClientRef,
    });

    win.on("closed", () => {
      setMainWindow(null);
    });
  }

  registerAppLifecycleHandlers({
    onCreateWindow: createWindow,
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
    getMainWindow,
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
