import { app, dialog } from "electron";
import type { PtyClient } from "../services/PtyClient.js";
import type { WorkspaceClient } from "../services/WorkspaceClient.js";
import { projectStore } from "../services/ProjectStore.js";
import { getActiveAgentCount, showQuitWarning } from "../utils/quitWarning.js";
import {
  disposeAgentAvailabilityStore,
  getAgentAvailabilityStore,
} from "../services/AgentAvailabilityStore.js";
import { disposePowerSaveBlockerService } from "../services/PowerSaveBlockerService.js";
import { disposePtyClient } from "../services/PtyClient.js";
import { helpSessionJobService } from "../services/HelpSessionJobService.js";
import { disposeWorkspaceClient } from "../services/WorkspaceClient.js";
import { disposeMainProcessWatchdog } from "../services/MainProcessWatchdogClient.js";
import { getCrashRecoveryService } from "../services/CrashRecoveryService.js";
import { getCrashLoopGuard } from "../services/CrashLoopGuardService.js";
import { getPanelSuspectLedger } from "../services/PanelSuspectLedgerService.js";
import { getDatabaseMaintenanceService } from "../services/DatabaseMaintenanceService.js";
import { getHibernationService } from "../services/HibernationService.js";
import { getIdleTerminalNotificationService } from "../services/IdleTerminalNotificationService.js";
import { getSystemSleepService } from "../services/SystemSleepService.js";
import { gitHubTokenHealthService } from "../services/github/GitHubTokenHealthService.js";
import {
  agentConnectivityService,
  getServiceConnectivityRegistry,
} from "../services/connectivity/index.js";
import { notificationService } from "../services/NotificationService.js";
import { preAgentSnapshotService } from "../services/PreAgentSnapshotService.js";
import {
  getCcrConfigService,
  setCcrConfigService,
  getResourceProfileService,
  setResourceProfileService,
  getWorktreePortBrokerRef,
  setWorktreePortBrokerRef,
  setWorkspaceClientRef,
  getMainProcessWatchdogClientRef,
  setMainProcessWatchdogClientRef,
  getAgentNotificationServiceRef,
  setAgentNotificationServiceRef,
  getAutoUpdaterServiceRef,
  setAutoUpdaterServiceRef,
  getWindowsStoreNotifierServiceRef,
  setWindowsStoreNotifierServiceRef,
} from "../window/serviceRefs.js";
import { closeSharedDb } from "../services/persistence/db.js";
import { closeTelemetry } from "../services/TelemetryService.js";
import { isSmokeTest } from "../setup/environment.js";
import { isSignalShutdown, clearSafetyBeltTimer } from "./signalShutdownState.js";
import { CLEANUP_TIMEOUT_MS } from "./shutdownConfig.js";

export { CLEANUP_TIMEOUT_MS };

export interface ShutdownDeps {
  getPtyClient: () => PtyClient | null;
  setPtyClient: (v: PtyClient | null) => void;
  getWorkspaceClient: () => WorkspaceClient | null;
  getCleanupIpcHandlers: () => (() => void) | null;
  setCleanupIpcHandlers: (v: (() => void) | null) => void;
  getCleanupErrorHandlers: () => (() => void) | null;
  setCleanupErrorHandlers: (v: (() => void) | null) => void;
  getStopEventLoopLagMonitor: () => (() => void) | null;
  setStopEventLoopLagMonitor: (v: (() => void) | null) => void;
  getStopProcessMemoryMonitor: () => (() => void) | null;
  setStopProcessMemoryMonitor: (v: (() => void) | null) => void;
  getStopAppMetricsMonitor: () => (() => void) | null;
  setStopAppMetricsMonitor: (v: (() => void) | null) => void;
  getStopDiskSpaceMonitor: () => (() => void) | null;
  setStopDiskSpaceMonitor: (v: (() => void) | null) => void;
  windowRegistry?: import("../window/WindowRegistry.js").WindowRegistry;
}

let isQuitting = false;
let isConfirmingQuit = false;

export function registerShutdownHandler(deps: ShutdownDeps): void {
  app.on("before-quit", async (event) => {
    if (isQuitting || isSmokeTest) {
      return;
    }

    const canShowDialog =
      process.env.DAINTREE_E2E_MODE !== "1" &&
      !isSignalShutdown() &&
      deps.windowRegistry?.getPrimary()?.browserWindow != null;

    if (isConfirmingQuit) {
      event.preventDefault();
      return;
    }

    if (canShowDialog) {
      event.preventDefault();

      const activeCount = getActiveAgentCount(getAgentAvailabilityStore());
      if (activeCount > 0) {
        isConfirmingQuit = true;
        let confirmed = false;
        try {
          const primaryWindow = deps.windowRegistry?.getPrimary()?.browserWindow ?? null;
          confirmed = await showQuitWarning(activeCount, dialog.showMessageBox, primaryWindow);
        } catch (error) {
          console.error("[MAIN] Error showing quit warning:", error);
        } finally {
          isConfirmingQuit = false;
        }

        if (!confirmed) {
          return;
        }
      }
    } else {
      event.preventDefault();
    }

    isQuitting = true;

    // Eager snapshot at quit-intent so the next launch has a post-quit-intent
    // backup regardless of which branch of the cleanup race wins. Without this,
    // a hard-timeout dirty exit skips cleanupOnExit() entirely and leaves the
    // user with whatever the 60s backup timer last captured. takeBackup() is
    // synchronous and best-effort (swallows its own errors), so it cannot
    // block or fail the shutdown chain.
    try {
      getCrashRecoveryService().takeBackup();
    } catch (err) {
      console.warn("[MAIN] Eager takeBackup at quit-intent failed:", err);
    }

    console.log("[MAIN] Starting graceful shutdown...");
    const { drainRateLimitQueues } = await import("../ipc/utils.js");
    drainRateLimitQueues();

    const ptyClient = deps.getPtyClient();
    const workspaceClient = deps.getWorkspaceClient();
    const gracefulShutdownPromise = (async () => {
      if (!ptyClient) return;
      try {
        const allProjects = projectStore.getAllProjects();
        const projectIds = allProjects.map((p) => p.id);
        const allResults = await Promise.race([
          Promise.all(projectIds.map((pid) => ptyClient.gracefulKillByProject(pid))),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("graceful shutdown timeout")), 4000)
          ),
        ]);

        for (let i = 0; i < projectIds.length; i++) {
          const results = allResults[i];
          const captured = results.filter((r) => r.agentSessionId);
          if (captured.length === 0) continue;

          const state = await projectStore.getProjectState(projectIds[i]);
          if (!state?.terminals) continue;

          for (const result of captured) {
            const snapshot = state.terminals.find((t: { id: string }) => t.id === result.id);
            if (snapshot) {
              snapshot.agentSessionId = result.agentSessionId ?? undefined;
            }
          }
          await projectStore.saveProjectState(projectIds[i], state);
        }
      } catch (error) {
        console.warn("[MAIN] Graceful agent shutdown incomplete:", error);
      }
    })();

    let currentPhase = "service-disposal";
    let exitCalled = false;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;

    // Stop the CCR config watcher and unwire PluginService's WorkspaceClient
    // reference before the Promise.all that disposes the WorkspaceClient.
    // Running these sequentially guarantees no file-change callback can fire
    // into a half-disposed WorkspaceClient during the await. Both wrap their
    // own failures so a single throw can't strand the rest of shutdown.
    const preDisposePromise = gracefulShutdownPromise.then(async () => {
      const ccr = getCcrConfigService();
      if (ccr) {
        try {
          await ccr.stopWatching();
        } catch (err) {
          console.warn("[MAIN] CcrConfigService.stopWatching failed:", err);
        }
        setCcrConfigService(null);
      }
      try {
        const { pluginService } = await import("../services/PluginService.js");
        pluginService.setWorkspaceClient(null);
      } catch {
        // Module load errors during teardown are non-fatal (PluginService may
        // never have been loaded if shutdown fired before first-interactive).
      }
    });

    const cleanupPromise = preDisposePromise
      .then(() =>
        Promise.all([
          workspaceClient ? workspaceClient.dispose() : Promise.resolve(),
          // McpServerService is dynamically imported only after first-interactive.
          // If the deferred task never ran (early shutdown), the module never loaded
          // and there is nothing to stop — skip silently.
          import("../services/McpServerService.js")
            .then(({ mcpServerService }) => mcpServerService.stop())
            .catch(() => {}),
          // Revoke and remove any in-flight help-session dirs. Same lazy-import
          // guard as MCP — the module only loads if a help session was provisioned.
          import("../services/HelpSessionService.js")
            .then(({ helpSessionService }) => helpSessionService.revokeAll())
            .catch(() => {}),
          new Promise<void>((resolve) => {
            // Global singletons that previously tore down on last-window-close
            // (electron/window/windowServices.ts) live here now so they cover
            // the macOS dock-reactivate path without racing a new window's
            // re-init. Every dispose() wraps in try/catch so one failure can't
            // strand later cleanup (PTY/workspace/watchdog/DB) — matching the
            // pattern already used for closeSharedDb downstream.
            // Order: stop monitors and timers, then connectivity, then
            // notifiers, then port broker (before WorkspaceClient is killed),
            // then PTY/workspace/watchdog.
            try {
              getResourceProfileService()?.stop();
            } catch (err) {
              console.warn("[MAIN] ResourceProfileService.stop failed:", err);
            }
            setResourceProfileService(null);

            try {
              getHibernationService().stop();
            } catch (err) {
              console.warn("[MAIN] HibernationService.stop failed:", err);
            }
            try {
              getIdleTerminalNotificationService().stop();
            } catch (err) {
              console.warn("[MAIN] IdleTerminalNotificationService.stop failed:", err);
            }
            try {
              getSystemSleepService().dispose();
            } catch (err) {
              console.warn("[MAIN] SystemSleepService.dispose failed:", err);
            }

            try {
              gitHubTokenHealthService.dispose();
            } catch (err) {
              console.warn("[MAIN] gitHubTokenHealthService.dispose failed:", err);
            }
            try {
              agentConnectivityService.dispose();
            } catch (err) {
              console.warn("[MAIN] agentConnectivityService.dispose failed:", err);
            }
            try {
              getServiceConnectivityRegistry().dispose();
            } catch (err) {
              console.warn("[MAIN] ServiceConnectivityRegistry.dispose failed:", err);
            }

            try {
              notificationService.dispose();
            } catch (err) {
              console.warn("[MAIN] notificationService.dispose failed:", err);
            }
            try {
              getAgentNotificationServiceRef()?.dispose();
            } catch (err) {
              console.warn("[MAIN] AgentNotificationService.dispose failed:", err);
            }
            setAgentNotificationServiceRef(null);
            try {
              preAgentSnapshotService.dispose();
            } catch (err) {
              console.warn("[MAIN] preAgentSnapshotService.dispose failed:", err);
            }
            try {
              getAutoUpdaterServiceRef()?.dispose();
            } catch (err) {
              console.warn("[MAIN] AutoUpdaterService.dispose failed:", err);
            }
            setAutoUpdaterServiceRef(null);
            try {
              getWindowsStoreNotifierServiceRef()?.dispose();
            } catch (err) {
              console.warn("[MAIN] WindowsStoreNotifierService.dispose failed:", err);
            }
            setWindowsStoreNotifierServiceRef(null);

            try {
              getWorktreePortBrokerRef()?.dispose();
            } catch (err) {
              console.warn("[MAIN] WorktreePortBroker.dispose failed:", err);
            }
            setWorktreePortBrokerRef(null);

            try {
              disposePowerSaveBlockerService();
            } catch (err) {
              console.warn("[MAIN] disposePowerSaveBlockerService failed:", err);
            }
            try {
              disposeAgentAvailabilityStore();
            } catch (err) {
              console.warn("[MAIN] disposeAgentAvailabilityStore failed:", err);
            }
            if (ptyClient) {
              try {
                ptyClient.dispose();
              } catch (err) {
                console.warn("[MAIN] PtyClient.dispose failed:", err);
              }
              deps.setPtyClient(null);
            }
            try {
              disposePtyClient();
            } catch (err) {
              console.warn("[MAIN] disposePtyClient failed:", err);
            }
            // Disarm the POSIX crash-safe supervisor only after PTY teardown.
            // DISARM tells the supervisor this is a clean quit and it should not
            // SIGKILL on pipe close — but if we disarmed before the PTYs were
            // actually gone (e.g. the graceful-kill above timed out), a crash in
            // the intervening window would leave them orphaned. Disarming last
            // guarantees the cooperative kill has run first. No-op on Windows /
            // when no supervisor was started.
            try {
              helpSessionJobService.dispose();
            } catch (err) {
              console.warn("[MAIN] helpSessionJobService.dispose failed:", err);
            }
            try {
              disposeWorkspaceClient();
            } catch (err) {
              console.warn("[MAIN] disposeWorkspaceClient failed:", err);
            }
            setWorkspaceClientRef(null);
            try {
              getMainProcessWatchdogClientRef()?.dispose();
            } catch (err) {
              console.warn("[MAIN] MainProcessWatchdogClient.dispose failed:", err);
            }
            setMainProcessWatchdogClientRef(null);
            try {
              disposeMainProcessWatchdog();
            } catch (err) {
              console.warn("[MAIN] disposeMainProcessWatchdog failed:", err);
            }
            resolve();
          }),
        ])
      )
      .then(async () => {
        currentPhase = "ipc-cleanup";
        const cleanupIpc = deps.getCleanupIpcHandlers();
        if (cleanupIpc) {
          cleanupIpc();
          deps.setCleanupIpcHandlers(null);
        }
        const cleanupErr = deps.getCleanupErrorHandlers();
        if (cleanupErr) {
          cleanupErr();
          deps.setCleanupErrorHandlers(null);
        }
        const stopLag = deps.getStopEventLoopLagMonitor();
        if (stopLag) {
          stopLag();
          deps.setStopEventLoopLagMonitor(null);
        }
        const stopMem = deps.getStopProcessMemoryMonitor();
        if (stopMem) {
          stopMem();
          deps.setStopProcessMemoryMonitor(null);
        }
        const stopMetrics = deps.getStopAppMetricsMonitor();
        if (stopMetrics) {
          stopMetrics();
          deps.setStopAppMetricsMonitor(null);
        }
        const stopDisk = deps.getStopDiskSpaceMonitor();
        if (stopDisk) {
          stopDisk();
          deps.setStopDiskSpaceMonitor(null);
        }

        try {
          await getDatabaseMaintenanceService().dispose();
        } catch (error) {
          console.warn("[MAIN] Database maintenance dispose failed:", error);
        }

        try {
          closeSharedDb();
        } catch (error) {
          console.warn("[MAIN] Failed to close SQLite connection:", error);
        }
      });

    const timeoutPromise = new Promise<never>((_, reject) => {
      hardTimer = setTimeout(() => {
        reject(
          new Error(
            `Hard shutdown timeout after ${CLEANUP_TIMEOUT_MS}ms — stuck at phase: ${currentPhase}`
          )
        );
      }, CLEANUP_TIMEOUT_MS);
    });

    Promise.race([cleanupPromise, timeoutPromise])
      .then(async () => {
        if (exitCalled) return;
        exitCalled = true;
        clearTimeout(hardTimer);
        console.log("[MAIN] Graceful shutdown complete");
        // Mark the exit clean BEFORE telemetry — telemetry is best-effort and
        // a closeTelemetry failure must never make the next launch think we crashed.
        // Independent try blocks so a failure in one marker write doesn't skip the other.
        try {
          getCrashRecoveryService().cleanupOnExit();
        } catch (err) {
          console.warn("[MAIN] CrashRecoveryService.cleanupOnExit failed:", err);
        }
        try {
          getCrashLoopGuard().markCleanExit();
        } catch (err) {
          console.warn("[MAIN] CrashLoopGuard.markCleanExit failed:", err);
        }
        try {
          getPanelSuspectLedger().markCleanLaunch();
        } catch (err) {
          console.warn("[MAIN] PanelSuspectLedger.markCleanLaunch failed:", err);
        }
        // Defuse the signal-handler safety-belt the moment we've committed to a
        // clean exit. closeTelemetry below has a 2500ms internal cap, but
        // clearing first eliminates the dependency on that cap holding — if a
        // future refactor extends the telemetry budget, the belt won't be able
        // to fire after app.exit(0) and clobber the exit code with exit(1).
        clearSafetyBeltTimer();
        try {
          await closeTelemetry();
        } catch (err) {
          console.warn("[MAIN] closeTelemetry failed:", err);
        }
        app.exit(0);
      })
      .catch(async (error) => {
        if (exitCalled) return;
        exitCalled = true;
        clearTimeout(hardTimer);
        console.error("[MAIN] Error during cleanup:", error);
        // Intentionally do NOT clean up the marker on the error/timeout path —
        // leaving running.lock on disk is the dirty-exit signal for next launch.
        // Defuse the belt before telemetry flush for the same reason as the
        // clean branch above.
        clearSafetyBeltTimer();
        try {
          await closeTelemetry();
        } catch (err) {
          console.warn("[MAIN] closeTelemetry failed:", err);
        }
        app.exit(1);
      });
  });
}
