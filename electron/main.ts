// Environment setup must run first (GC exposure, userData, flags, sandbox)
import "./setup/environment.js";

import nodeV8 from "node:v8";
import { app, BrowserWindow, crashReporter, protocol } from "electron";

// Ask V8 to auto-dump a heap snapshot when the main process is genuinely close
// to its heap limit. Complements the existing dev-only 600 MB RSS heuristic in
// ProcessMemoryMonitor, but works in packaged builds too. Snapshot files land
// in the process CWD (or wherever `--diagnostic-dir` points). count=2 caps
// lifetime auto-dumps so a thrashing process can't fill the disk.
nodeV8.setHeapSnapshotNearHeapLimit(2);
import { registerGlobalErrorHandlers } from "./setup/globalErrorHandlers.js";
import { startDevDiagnostics } from "./setup/devDiagnostics.js";
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
import { effectiveCachedProjectViews } from "./utils/cachedProjectViews.js";
import { setupBrowserWindow } from "./window/createWindow.js";
import { distributePortsToView } from "./window/portDistribution.js";
import { toDisposable } from "./utils/lifecycle.js";
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
  getMainProcessWatchdogClientRef,
} from "./window/windowServices.js";
import {
  setupPowerMonitor,
  setupWindowFocusThrottle,
  registerWindowForFocusThrottle,
} from "./window/powerMonitor.js";
import { getProjectStatsService } from "./ipc/handlers/projectCrud/index.js";
import { getIdleTerminalNotificationService } from "./services/IdleTerminalNotificationService.js";
import { preAgentSnapshotService } from "./services/PreAgentSnapshotService.js";
import { isSmokeTest } from "./setup/environment.js";
import { store } from "./store.js";
import {
  pruneOldLogs,
  initializeLogger,
  registerLoggerTransport,
  setLogLevelOverrides,
} from "./utils/logger.js";
import { broadcastToRenderer } from "./ipc/utils.js";
import { registerCommands } from "./services/commands/index.js";
import { initializeCrashRecoveryService } from "./services/CrashRecoveryService.js";
import { initializeGpuCrashMonitor } from "./services/GpuCrashMonitorService.js";
import { initializeTrashedPidCleanup } from "./services/TrashedPidTracker.js";
import { initializeCrashLoopGuard, getCrashLoopGuard } from "./services/CrashLoopGuardService.js";
import { initializeDatabaseMaintenance } from "./services/DatabaseMaintenanceService.js";
import { readLastActiveProjectIdSync } from "./services/persistence/readLastProjectId.js";
import { emergencyLogMainFatal } from "./utils/emergencyLog.js";

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

  // Seed per-module level overrides from persisted store so main-process
  // logging filters correctly from the very first log line. Utility processes
  // receive the same map after their first `ready` event.
  setLogLevelOverrides(store.get("logLevelOverrides") ?? {});

  registerLoggerTransport(broadcastToRenderer, () => BrowserWindow.getAllWindows().length > 0);

  registerCommands();

  crashReporter.start({ uploadToServer: false });
  initializeCrashLoopGuard();
  registerGlobalErrorHandlers();

  if (!app.isPackaged) {
    startDevDiagnostics();
  }

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
        // Each cleanup is isolated: if removeDirectPort throws, the worktree
        // port must still close. Partial cleanup leaves a live producer
        // posting into a soon-to-be-destroyed renderer.
        try {
          getWorkspaceClientRef()?.removeDirectPort(wcId);
        } catch (err) {
          console.error("[main] removeDirectPort failed during eviction:", err);
        }
        try {
          getWorktreePortBrokerRef()?.closePortsForView(wcId);
        } catch (err) {
          console.error("[main] closePortsForView failed during eviction:", err);
        }
        // Revoke help-session tokens bound to this evicted WebContents view.
        // Done synchronously off the eviction hook (lesson #5009) so a
        // renderer-side cleanup IPC can't go missing on view destruction.
        import("./services/HelpSessionService.js")
          .then(({ helpSessionService }) => helpSessionService.revokeByWebContentsId(wcId))
          .catch((err) => {
            console.warn("[main] revokeByWebContentsId failed during eviction:", err);
          });
      },
      onViewCached: (wcId) => {
        // Same producer cleanup as eviction: a cached view becomes
        // freeze-eligible once setBackgroundThrottling(true) is applied.
        // Live worktree/workspace ports would otherwise queue messages
        // into a frozen renderer (#6273). Reactivation re-brokers a fresh
        // port via activateProjectView in projectCrud/switch.ts.
        // Each cleanup is isolated so a throw in one path can't leave the
        // other producer alive — that's the exact failure mode this PR
        // exists to prevent.
        try {
          getWorkspaceClientRef()?.removeDirectPort(wcId);
        } catch (err) {
          console.error("[main] removeDirectPort failed during cache:", err);
        }
        try {
          getWorktreePortBrokerRef()?.closePortsForView(wcId);
        } catch (err) {
          console.error("[main] closePortsForView failed during cache:", err);
        }
      },
      onViewCrashed: () => {
        // Tear down the per-window PTY MessagePort on renderer crash so the
        // pty-host's PortQueueManager can drop stale queue accounting before
        // reload re-issues a fresh port. Without this, a stale port keeps the
        // safety-timeout pause loop wedged for the entire reload window (#6244).
        if (win.isDestroyed()) return;
        getPtyClient()?.disconnectMessagePort(win.id);
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

    // E2E hooks: expose PVM accessor and heap-snapshot writer so the
    // nightly evicted-view leak spec can read main-process state and
    // dump a v8 snapshot from app.evaluate(). Mirrors the
    // __daintreeResetRateLimits / __daintreeFaultRegistry pattern.
    if (process.env.DAINTREE_E2E_MODE === "1") {
      (globalThis as Record<string, unknown>).__daintreeGetPvm = getProjectViewManager;
      (globalThis as Record<string, unknown>).__daintreeWriteHeapSnapshot = (filePath: string) =>
        nodeV8.writeHeapSnapshot(filePath);
    }

    // Clean up ProjectViewManager when the window's cleanup runs.
    // Registered before setupWindowServices so pvm.dispose() runs first —
    // views must close before per-window ports/event-buffer disconnect.
    ctx.cleanup.add(
      toDisposable(() => {
        pvm.dispose();
        setProjectViewManager(null);
      })
    );

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
        getMainProcessWatchdogClient: getMainProcessWatchdogClientRef,
      });
      setupWindowFocusThrottle({
        getPtyClient,
        getWorkspaceClient: getWorkspaceClientRef,
        getProjectStatsService,
        getIdleTerminalNotificationService: () => getIdleTerminalNotificationService(),
        getPreAgentSnapshotService: () => preAgentSnapshotService,
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
      // Startup crashes hard-exit without running before-quit, which means
      // markCleanExit() never fires and the CrashLoopGuard counts this as a
      // crash. That is correct — but without an on-disk trace the next
      // session has no way to diagnose the loop, since main-crash.log never
      // captures this path (it only logs from globalErrorHandlers). Wire it
      // here so a repeating startup failure leaves a stack behind.
      try {
        emergencyLogMainFatal("STARTUP_FAILED", error);
      } catch {
        // best-effort
      }
      app.exit(1);
    }
  });
}
