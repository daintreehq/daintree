// Environment setup must run first (GC exposure, userData, flags, sandbox)
import "./setup/environment.js";

/**
 * Wall-clock milliseconds at which the Electron process was created, captured
 * as early as possible. Used to compute `time_to_first_agent_task_ms` for the
 * activation funnel. Falls back to `Date.now()` on the rare platforms where
 * `process.getCreationTime()` returns null. Electron 41 does not ship
 * `app.getStartupTimestamp()`, so this is the earliest reliable origin point.
 */
export const APP_LAUNCH_MS: number =
  typeof process.getCreationTime === "function"
    ? (process.getCreationTime() ?? Date.now())
    : Date.now();

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
  registerCanopyFileProtocol,
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
import { effectiveCachedProjectViews } from "./utils/cachedProjectViews.js";
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
  // canopy-file remains privileged during the 0.7/0.8 migration window so
  // both the legacy Canopy build and the new Daintree build can resolve
  // pre-rebrand links and persisted references.
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

// Allow autoplay without user gesture (voice input, media panels).
// Per-view throttling is managed by ProjectViewManager.setBackgroundThrottling().
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
// BackForwardCache wastes memory in an Electron app (no browser navigation history).
const disabledFeatures = ["BackForwardCache"];
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
      // Resolve to the same value the IPC handler returns so the main-process
      // LRU cap and the renderer's Settings view agree on first boot. Invalid
      // persisted values fall through to the E2E override or RAM-based default
      // instead of leaking into ProjectViewManager.
      cachedProjectViews: effectiveCachedProjectViews(
        store.get("terminalConfig")?.cachedProjectViews
      ),
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
      appLaunchMs: APP_LAUNCH_MS,
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
      registerCanopyFileProtocol();
      setupWebviewCSP();
      await createWindow(undefined, lastActiveProjectId ?? undefined);
      getCrashLoopGuard().startStabilityTimer();
    } catch (error) {
      console.error("[MAIN] Startup failed:", error);
      app.exit(1);
    }
  });
}
