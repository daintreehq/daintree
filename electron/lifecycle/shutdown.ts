import { flushCompileCache } from "node:module";
import { app, dialog } from "electron";
import type { PtyClient } from "../services/PtyClient.js";
import type { WorkspaceClient } from "../services/WorkspaceClient.js";
import { projectStore } from "../services/ProjectStore.js";
import { journalAgentSession } from "../services/pty/agentSessionJournal.js";
import { getLifecycleLedger } from "../services/pty/lifecycleLedger.js";
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
import { getPeriodicCleanupService } from "../services/PeriodicCleanupService.js";
import { getHibernationService } from "../services/HibernationService.js";
import { getIdleBackgroundAutoCloseService } from "../services/IdleBackgroundAutoCloseService.js";
import { getIdleTerminalNotificationService } from "../services/IdleTerminalNotificationService.js";
import { getSystemSleepService } from "../services/SystemSleepService.js";
import { getOsDndService } from "../services/OsDndService.js";
import { isE2EMode } from "../setup/runtimeFlags.js";
import {
  agentConnectivityService,
  getServiceConnectivityRegistry,
} from "../services/connectivity/index.js";
import { notificationService } from "../services/NotificationService.js";
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
import { haltDeferredQueue } from "../window/deferredInitQueue.js";
import { closeSharedDb } from "../services/persistence/db.js";
import { closeTelemetry } from "../services/TelemetryService.js";
import { isSmokeTest } from "../setup/environment.js";
import { stopPerformanceTraceIfActive } from "../utils/performanceTrace.js";
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
      !isE2EMode && !isSignalShutdown() && deps.windowRegistry?.getPrimary()?.browserWindow != null;

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

    // Halt the deferred init queue before anything yields to the event loop —
    // a pending setImmediate drain step could otherwise re-initialize services
    // the cleanup chain below is about to tear down (issue #9881). Placed
    // after the quit-confirmation dialog deliberately: halting is permanent,
    // so a cancelled quit must never reach it (an abandoned drain chain cannot
    // be resumed). Tasks that start during the dialog run against a fully live
    // app and are torn down by the cleanup chain like any other service.
    haltDeferredQueue();

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

    // Persist compile-cache entries on clean quit. Synchronous and cheap (one
    // fs write), placed here before the async graceful-shutdown chain so it
    // can't race the cleanup timeout. We've already committed to quitting
    // (isQuitting = true), so this never fires on a cancelled quit dialog.
    try {
      if (typeof flushCompileCache === "function") {
        flushCompileCache();
      }
    } catch (err) {
      console.warn("[MAIN] flushCompileCache at quit failed:", err);
    }

    console.log("[MAIN] Starting graceful shutdown...");
    const { drainRateLimitQueues } = await import("../ipc/utils.js");
    drainRateLimitQueues();

    const ptyClient = deps.getPtyClient();
    const workspaceClient = deps.getWorkspaceClient();
    const gracefulShutdownPromise = (async () => {
      if (!ptyClient) return;
      try {
        // Snapshot terminal infos before the kills — info is gone once the PTY
        // exits — so each captured agent session can be journaled below. Outside
        // the 4s kill race; a failed snapshot just no-ops the journal step.
        let terminalInfoById = new Map<
          string,
          Awaited<ReturnType<PtyClient["getAllTerminalsAsync"]>>[number]
        >();
        try {
          const allTerminals = await ptyClient.getAllTerminalsAsync();
          terminalInfoById = new Map(allTerminals.map((t) => [t.id, t]));
        } catch {
          // Snapshot is best-effort; journaling below skips when info is absent.
        }
        // Freeze each terminal's launch generation alongside the info snapshot,
        // before any kill — the journal write below must stay attributed to the
        // incarnation being shut down.
        const ledger = getLifecycleLedger();
        const generationById = new Map<string, number | undefined>(
          [...terminalInfoById.keys()].map((id) => [id, ledger.currentGeneration(id)])
        );

        const allProjects = projectStore.getAllProjects();
        const projectIds = allProjects.map((p) => p.id);
        // Cap each project's graceful kill independently (in parallel) rather
        // than racing the whole batch against one 4s deadline: a single slow
        // project must not discard the captured sessions of projects that did
        // finish in time — both the projectStore write and the resume journal
        // below depend on those partial results. Wall-clock stays ~4s (parallel).
        const allResults = await Promise.all(
          projectIds.map((pid) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            return Promise.race([
              ptyClient.gracefulKillByProject(pid),
              new Promise<Array<{ id: string; agentSessionId: string | null }>>((resolve) => {
                timer = setTimeout(() => resolve([]), 4000);
              }),
            ]).finally(() => {
              if (timer) clearTimeout(timer);
            });
          })
        );

        for (let i = 0; i < projectIds.length; i++) {
          const results = allResults[i];
          const captured = results.filter((r) => r.agentSessionId);
          if (captured.length === 0) continue;

          await projectStore.enqueueProjectStateUpdate(projectIds[i], (state) => {
            if (!state?.terminals) return null;
            for (const result of captured) {
              const snapshot = state.terminals.find((t: { id: string }) => t.id === result.id);
              if (snapshot) {
                snapshot.agentSessionId = result.agentSessionId ?? undefined;
              }
            }
            return state;
          });
        }

        // Journal a resume record per captured agent session, matching the
        // trash-expiry / kill / gracefulKill close paths. Non-agent terminals
        // and sessions with no resumable id are skipped. Branch lookups are
        // time-boxed (200ms each, parallel over unique worktrees) so a stalled
        // workspace-host can't push the chain past the cleanup budget (#7151).
        const capturedAgents = allResults
          .flat()
          .filter((r) => r.agentSessionId)
          .map((r) => ({ result: r, info: terminalInfoById.get(r.id) }))
          .filter((c): c is { result: typeof c.result; info: NonNullable<typeof c.info> } =>
            Boolean(c.info?.launchAgentId)
          );

        if (capturedAgents.length > 0) {
          const uniqueWorktreeIds = [
            ...new Set(
              capturedAgents
                .map((c) => c.info.worktreeId)
                .filter((w): w is string => typeof w === "string" && w.length > 0)
            ),
          ];
          const branchByWorktree = new Map<string, string>();
          await Promise.all(
            uniqueWorktreeIds.map(async (wid) => {
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                const snapshot = await Promise.race([
                  workspaceClient ? workspaceClient.getMonitorAsync(wid) : Promise.resolve(null),
                  new Promise<null>((resolve) => {
                    timer = setTimeout(() => resolve(null), 200);
                  }),
                ]);
                const branch = snapshot?.branch;
                if (branch && branch !== "HEAD") branchByWorktree.set(wid, branch);
              } catch {
                // best-effort
              } finally {
                if (timer) clearTimeout(timer);
              }
            })
          );

          for (const { result, info } of capturedAgents) {
            try {
              // Exactly-once funnel: the ledger key (terminalId, generation)
              // drops a record another close path (e.g. a user kill landing
              // mid-shutdown) already journaled for this incarnation.
              await journalAgentSession(
                {
                  sessionId: result.agentSessionId as string,
                  agentId: info.launchAgentId as string,
                  worktreeId: info.worktreeId ?? null,
                  // Prefer the observed task title, matching the trash-expiry
                  // and kill close paths — except under a user lock, where the
                  // record should read the same as the frozen live tab.
                  title:
                    (info.titleMode === "user"
                      ? info.title
                      : (info.lastObservedTitle ?? info.title)) ?? null,
                  projectId: info.projectId ?? null,
                  agentLaunchFlags: info.agentLaunchFlags,
                  agentModelId: info.agentModelId,
                  cwd: info.cwd ?? undefined,
                  branch: info.worktreeId ? branchByWorktree.get(info.worktreeId) : undefined,
                },
                { terminalId: result.id, generation: generationById.get(result.id) }
              );
            } catch (err) {
              console.warn("[MAIN] Failed to journal agent session on shutdown:", err);
            }
          }
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
      // Stop the DB maintenance worker BEFORE the audit flushNow() calls
      // below. The drain wait is capped (a wedged worker must not eat the
      // shutdown budget), so it is best-effort — shutdownDbWorker() advances
      // the write fence afterwards, making any ring write a slow worker
      // commits later in the shutdown window a no-op. Post-shutdown, every
      // ring write executes synchronously on main, so the final flushNow()
      // snapshots are durable and cannot be clobbered.
      try {
        const { shutdownDbWorker } = await import("../services/persistence/dbWorkerClient.js");
        await shutdownDbWorker();
      } catch (err) {
        console.warn("[MAIN] DB worker shutdown failed:", err);
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
          // Flush any debounced plugin-audit records before exit — the flush
          // timer is unref'd, so the tail of a session would otherwise be lost.
          // Lazy-import guarded like MCP: skip silently if init never ran.
          import("../services/PluginActionAuditService.js")
            .then(({ getPluginActionAuditService }) => getPluginActionAuditService().flushNow())
            .catch(() => {}),
          // Flush any forge audit records still inside the 2s debounce window.
          // The flush timer is unref()'d so Node won't keep the process alive
          // for it — without this drain, the last few records are lost on quit.
          // Lazy-imported: the module only loads if a forge handler ran.
          import("../services/forge/forgeAuditService.js")
            .then(({ forgeAuditService }) => forgeAuditService.flushNow())
            .catch(() => {}),
          // Mirror for the durable run-history ring (#9949). Same unref'd 2s
          // debounce, same loss-on-quit if not drained explicitly.
          import("../services/runHistory/runHistoryService.js")
            .then(({ runHistoryLog }) => runHistoryLog.flushNow())
            .catch(() => {}),
          // Mirror for the plugin-MCP inbound audit ring (#9234). Same unref'd
          // 2s debounce, same loss-on-quit if not drained explicitly.
          import("../services/plugin-mcp/instances.js")
            .then(({ getPluginMcpAuditService }) => getPluginMcpAuditService().flushNow())
            .catch(() => {}),
          // Revoke and remove any in-flight help-session dirs. Same lazy-import
          // guard as MCP — the module only loads if a help session was provisioned.
          import("../services/HelpSessionService.js")
            .then(({ helpSessionService }) => helpSessionService.revokeAll())
            .catch(() => {}),
          // Tear down every supervised plugin MCP subprocess (#9233). Same
          // lazy-import guard — if no plugin ever activated an MCP server, the
          // supervisor module never loaded and there is nothing to stop.
          import("../services/PluginMcpSupervisor.js")
            .then(({ getPluginMcpSupervisor }) => getPluginMcpSupervisor().shutdownAll())
            .catch(() => {}),
          // Close the CLI control socket and unlink the socket file (F32). Same
          // lazy-import guard — the module only loaded if the deferred task ran.
          import("../services/PluginCliServer.js")
            .then(({ stopPluginCliServer }) => stopPluginCliServer())
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
              getIdleBackgroundAutoCloseService().stop();
            } catch (err) {
              console.warn("[MAIN] IdleBackgroundAutoCloseService.stop failed:", err);
            }
            try {
              getSystemSleepService().dispose();
            } catch (err) {
              console.warn("[MAIN] SystemSleepService.dispose failed:", err);
            }
            try {
              getOsDndService().dispose();
            } catch (err) {
              console.warn("[MAIN] OsDndService.dispose failed:", err);
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

        // Stop the periodic cleanup timer and drain any in-flight sweep before
        // DB maintenance, so no tick races the final WAL checkpoint (#9537).
        try {
          await getPeriodicCleanupService().dispose();
        } catch (error) {
          console.warn("[MAIN] Periodic cleanup dispose failed:", error);
        }

        // Stop the opt-in plugin update checker and drain any in-flight pass
        // (#10893) — its timers/wake listeners must not survive teardown.
        try {
          const { getPluginUpdateCheckService } =
            await import("../services/PluginUpdateCheckService.js");
          await getPluginUpdateCheckService().dispose();
        } catch (error) {
          console.warn("[MAIN] Plugin update check dispose failed:", error);
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
        // Flush the perf trace (if --trace was active) while the GPU/renderer
        // child processes are still alive. app.exit() bypasses will-quit, so
        // this is the only reliable point to stop tracing before exit; no-op
        // for normal runs. Awaited so the trace file isn't truncated.
        await stopPerformanceTraceIfActive();
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
        // Best-effort trace flush on the error path too — a partial trace is
        // still useful, and the call is a no-op when tracing is off.
        await stopPerformanceTraceIfActive();
        app.exit(1);
      });
  });
}
