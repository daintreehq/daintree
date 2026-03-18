// Environment setup must run first (GC exposure, userData, flags, sandbox)
import "./setup/environment.js";

import { app, protocol } from "electron";
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
import { setMainWindow, getMainWindow } from "./window/windowRef.js";
import { setupBrowserWindow } from "./window/createWindow.js";
import {
  setupWindowServices,
  getPtyClient,
  setPtyClientRef,
  getWorkspaceClientRef,
  getProjectMcpManagerRef,
  getCliAvailabilityServiceRef,
  getProjectSwitchServiceRef,
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
} from "./window/windowServices.js";
import { setupPowerMonitor } from "./window/powerMonitor.js";
import { isSmokeTest } from "./setup/environment.js";
import { store } from "./store.js";
import { pruneOldLogs, initializeLogger } from "./utils/logger.js";
import { registerCommands } from "./services/commands/index.js";
import { initializeTelemetry } from "./services/TelemetryService.js";
import { initializeCrashRecoveryService } from "./services/CrashRecoveryService.js";
import { initializeGpuCrashMonitor } from "./services/GpuCrashMonitorService.js";

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
    },
  },
  {
    scheme: "canopy-file",
    privileges: {
      secure: true,
      bypassCSP: true,
      supportFetchAPI: true,
    },
  },
]);

// Increase V8 heap size for renderer processes to handle large clipboard data
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=4096");

// Keep the renderer process at full priority and prevent AudioContext suspension
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
if (process.platform === "darwin") {
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
}

// Prune old log files based on retention setting
{
  const retentionDays = store.get("privacy")?.logRetentionDays ?? 30;
  if (retentionDays > 0) {
    pruneOldLogs(app.getPath("userData"), retentionDays);
  }
}

initializeLogger(app.getPath("userData"));
registerCommands();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

void initializeTelemetry();

process.on("uncaughtException", (error) => {
  console.error("[FATAL] Uncaught Exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[FATAL] Unhandled Promise Rejection at:", promise, "reason:", reason);
});

const distPath = path.join(__dirname, "../../dist");

const gotTheLock = isSmokeTest || app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log("[MAIN] Another instance is already running. Quitting...");
  app.quit();
} else {
  initializeCrashRecoveryService();
  initializeGpuCrashMonitor();

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

    await setupWindowServices(win, {
      loadRenderer,
      smokeTestTimer,
      smokeRendererUnresponsive,
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
    getProjectSwitchService: getProjectSwitchServiceRef,
  });

  registerShutdownHandler({
    getPtyClient,
    setPtyClient: setPtyClientRef,
    getWorkspaceClient: getWorkspaceClientRef,
    getProjectMcpManager: getProjectMcpManagerRef,
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
    getMainWindow,
  });

  app.whenReady().then(async () => {
    try {
      registerAppProtocol(distPath);
      registerCanopyFileProtocol();
      setupWebviewCSP();
      await createWindow();
    } catch (error) {
      console.error("[MAIN] Startup failed:", error);
      app.exit(1);
    }
  });
}
