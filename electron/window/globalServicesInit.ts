// eager-import-allow: reads boot config via store.get synchronously while wiring global services
import { app, dialog, ipcMain } from "electron";
import {
  LATEST_SCHEMA_VERSION,
  MigrationRunner,
  isStoreMigrationError,
} from "../services/StoreMigrations.js";
import { initializeTelemetry, setOnboardingCompleteTag } from "../services/TelemetryService.js";
import { getServiceConnectivityRegistry } from "../services/connectivity/index.js";
import { notificationService } from "../services/NotificationService.js";
import { getActionBreadcrumbService } from "../services/ActionBreadcrumbService.js";
import { getPluginActionAuditService } from "../services/PluginActionAuditService.js";
import {
  initializeHibernationService,
  getHibernationService,
} from "../services/HibernationService.js";
import {
  evictSessionFiles,
  SESSION_EVICTION_TTL_MS,
  SESSION_EVICTION_MAX_BYTES,
} from "../services/pty/terminalSessionPersistence.js";
import { initializeSystemSleepService } from "../services/SystemSleepService.js";
import { initializeOsDndService } from "../services/OsDndService.js";
import { getDatabaseMaintenanceService } from "../services/DatabaseMaintenanceService.js";
import { getCrashRecoveryService } from "../services/CrashRecoveryService.js";
// Free for eager import: PtyClient already value-imports HelpSessionService,
// so this static edge adds zero boot cost — keep it that way.
import { helpSessionService } from "../services/HelpSessionService.js";
import {
  markPerformance,
  startEventLoopLagMonitor,
  startProcessMemoryMonitor,
} from "../utils/performance.js";
import { startMainIdleHeapCompaction } from "../services/mainHeapCompaction.js";
import {
  startAppMetricsMonitor,
  hasSustainedRendererSaturation,
} from "../services/ProcessMemoryMonitor.js";

import { startDiskSpaceMonitor } from "../services/DiskSpaceMonitor.js";
import { runScratchCleanup } from "../services/ScratchCleanupService.js";
import {
  initializeAgentCompileCacheCleanup,
  requestAgentCompileCacheCleanup,
} from "../services/AgentCompileCacheCleanupService.js";
import { runAssistantScratchCleanup } from "../services/AssistantScratchService.js";
import { getPeriodicCleanupService } from "../services/PeriodicCleanupService.js";
import {
  pruneOldLogs,
  pruneOldLogsAsync,
  pruneHeapSnapshots,
  pruneHeapSnapshotsAsync,
  MAX_HEAP_SNAPSHOTS,
  logError,
  logWarn,
} from "../utils/logger.js";
import { effectiveCachedProjectViews } from "../utils/cachedProjectViews.js";
import { SCROLLBACK_BACKGROUND } from "../../shared/config/scrollback.js";
import type { WorkerResourceSnapshot } from "../../shared/types/workerGovernance.js";
import { PERF_MARKS } from "../../shared/perf/marks.js";
import { CHANNELS } from "../ipc/channels.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { countResumableAgentPanels } from "../services/projectStateRestore.js";
import type { Project, ProjectState } from "../../shared/types/project.js";
import type { Scratch } from "../../shared/types/scratch.js";
import { sendToRenderer } from "../ipc/handlers.js";
import { wireUpdateMenuState } from "../menu.js";
import { getAppWebContents } from "./webContentsRegistry.js";
import type { WindowRegistry } from "./WindowRegistry.js";
import type { ProjectViewManager } from "./ProjectViewManager.js";
import {
  getProjectStatsService,
  getFleetSnapshotService,
} from "../ipc/handlers/projectCrud/index.js";
import { registerDeferredTask } from "./deferredInitQueue.js";
import { isSmokeTest } from "../setup/environment.js";
import { setPluginDirResolver } from "../setup/protocols.js";
import { isE2EFaultMode } from "../setup/runtimeFlags.js";
import { activateOpenFileInstaller } from "../setup/openFileInstall.js";
import { projectStore } from "../services/ProjectStore.js";
import { scratchStore } from "../services/ScratchStore.js";
import { registerCommands } from "../services/commands/index.js";
import { store, wasStoreFreshAtBoot } from "../store.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import type { ResourceProfile } from "../../shared/types/resourceProfile.js";
import {
  setCcrConfigService,
  getResourceProfileService,
  setResourceProfileService,
  getMainProcessWatchdogClientRef,
  getStopAppMetricsMonitor,
  setStopAppMetricsMonitor,
  getStopDiskSpaceMonitor,
  setStopDiskSpaceMonitor,
  getStopEventLoopLagMonitor,
  setStopEventLoopLagMonitor,
  getStopProcessMemoryMonitor,
  setStopProcessMemoryMonitor,
  getPtyClient,
  getWorkspaceClientRef,
  setAutoUpdaterServiceRef,
  getAutoUpdaterServiceRef,
  setAgentNotificationServiceRef,
  setWindowsStoreNotifierServiceRef,
  setGlobalServicesInitialized,
} from "./serviceRefs.js";

/**
 * Give rows a resume count without reading anything extra off disk (#11801).
 *
 * The count is normally maintained by the write that changes it, which leaves
 * one population uncovered: projects closed before the field existed, and never
 * saved since. Those are exactly the dormant rows the switcher's dot is for, so
 * lazy fill would leave the feature dark on the projects it exists to mark.
 *
 * It rides the session-eviction sweep rather than adding a pass of its own
 * because that sweep already loads every project's state for its own reasons —
 * so the backfill costs no file reads at all, and inherits the sweep's deferral
 * until after first interactive.
 *
 * `states` is index-aligned with `projects`, and each project's count was read
 * before its state was, which is what makes the compare-and-swap in
 * `reconcileResumableAgentCount` meaningful: a save that landed mid-sweep is
 * newer than anything here, and leaves the row alone.
 */
function reconcileResumableAgentCounts(projects: Project[], states: (ProjectState | null)[]): void {
  for (const [i, project] of projects.entries()) {
    const state = states[i];
    // Unreadable is neither empty nor countable. A quarantined or unparseable
    // state.json holds panels this build could not enumerate, so the row
    // retracts its claim instead of keeping a number nothing can back up —
    // holding the old count would keep promising agents that no longer restore.
    // A genuinely absent state.json is different: that is authoritative
    // emptiness, and a count of zero rather than an unknown.
    const count = projectStore.wasStateUnreadableThisSession(project.id)
      ? null
      : state
        ? countResumableAgentPanels(state.terminals, `resume-count-backfill(project:${project.id})`)
        : 0;

    try {
      const updated = projectStore.reconcileResumableAgentCount(
        project.id,
        project.resumableAgentCount ?? null,
        count
      );
      // Only rows that actually moved are broadcast, so a palette already open
      // redraws exactly the dots that changed and nothing else.
      if (updated) broadcastToRenderer(CHANNELS.PROJECT_UPDATED, updated);
    } catch (error) {
      console.warn(
        `[MAIN] Session eviction: failed to reconcile resume count for ${project.id}:`,
        error
      );
    }
  }
}

/**
 * The scratch half of the same backfill (#11821). Scratches persist their panel
 * grid under the shared `projects/<id>/` layout, so their states load through
 * the same call and the sweep costs no extra reads for them either.
 *
 * Kept beside the project pass rather than folded into it: the two write
 * different tables, return different entities and broadcast on different
 * channels, and the compare-and-swap each needs is the one its own store owns.
 */
function reconcileScratchResumableAgentCounts(
  scratches: Scratch[],
  states: (ProjectState | null)[]
): void {
  for (const [i, scratch] of scratches.entries()) {
    const state = states[i];
    // Same three-way reading as projects: unreadable retracts the claim,
    // genuinely absent state is authoritative emptiness, present state counts.
    const count = projectStore.wasStateUnreadableThisSession(scratch.id)
      ? null
      : state
        ? countResumableAgentPanels(state.terminals, `resume-count-backfill(scratch:${scratch.id})`)
        : 0;

    try {
      const updated = scratchStore.reconcileResumableAgentCount(
        scratch.id,
        scratch.resumableAgentCount ?? null,
        count
      );
      if (updated) broadcastToRenderer(CHANNELS.SCRATCH_UPDATED, updated);
    } catch (error) {
      console.warn(
        `[MAIN] Session eviction: failed to reconcile resume count for scratch ${scratch.id}:`,
        error
      );
    }
  }
}

async function evictStaleSessionFiles(): Promise<void> {
  try {
    const allProjects = projectStore.getAllProjects();
    const allScratches = scratchStore.getAllScratches();
    const knownIds = new Set<string>();

    const [states, scratchStates] = await Promise.all([
      Promise.all(allProjects.map((p) => projectStore.getProjectState(p.id))),
      Promise.all(allScratches.map((s) => projectStore.getProjectState(s.id))),
    ]);
    // Scratch terminals belong to the same `.restore` pool as project ones, so
    // they have to be declared known here or the orphan pass below would read a
    // live scratch's scrollback as unattributed and delete it.
    for (const state of [...states, ...scratchStates]) {
      if (state?.terminals) {
        for (const t of state.terminals) {
          knownIds.add(t.id);
        }
      }
    }

    reconcileResumableAgentCounts(allProjects, states);
    reconcileScratchResumableAgentCounts(allScratches, scratchStates);

    const appTerminals = store.get("appState")?.terminals;
    if (Array.isArray(appTerminals)) {
      for (const t of appTerminals) {
        knownIds.add(t.id);
      }
    }

    // If any workspace's state was unreadable this session, `knownIds` is
    // incomplete — it's missing every terminal id belonging to that workspace.
    // A .restore file carries only a bare terminal id (no workspace reference),
    // so the missing ids can't be attributed back to the affected workspace;
    // the orphan pass can't tell "this workspace's scrollback" from a genuine
    // orphan. Fail closed: skip the orphan-eviction pass entirely this cycle
    // (pass knownIds: undefined) rather than delete recoverable scrollback.
    // TTL and max-size passes don't depend on cross-workspace attribution, so
    // they keep running as backstops.
    //
    // Scratches count here for exactly the reason projects do: their .restore
    // files are in the same pool and are just as unattributable (#11821).
    const orphanSweepUnsafe = [...allProjects, ...allScratches].some((w) =>
      projectStore.wasStateUnreadableThisSession(w.id)
    );
    if (orphanSweepUnsafe) {
      console.warn(
        "[MAIN] Session eviction: skipping orphan pass — at least one workspace's state was unreadable or quarantined this session; retaining all .restore files to avoid deleting recoverable scrollback (TTL and size-cap passes still active)"
      );
    }

    const result = await evictSessionFiles({
      ttlMs: SESSION_EVICTION_TTL_MS,
      maxBytes: SESSION_EVICTION_MAX_BYTES,
      knownIds: orphanSweepUnsafe ? undefined : knownIds,
    });

    if (result.deleted > 0) {
      console.log(
        `[MAIN] Session eviction: deleted ${result.deleted} file(s), freed ${(result.bytesFreed / 1024 / 1024).toFixed(1)} MB`
      );
    }
  } catch (err) {
    console.warn("[MAIN] Session eviction failed:", err);
  }
}

/**
 * Run the once-per-app-lifecycle global initialization on the first window
 * setup. Migrations run inline (synchronous, blocking); everything else is
 * either a synchronous boot (ActionBreadcrumbService) or
 * registered as a deferred task that drains after first-interactive.
 *
 * Returns "exit-requested" when migrations fail and `app.exit(1)` has been
 * called — the caller MUST early-return without continuing setup.
 */
export async function initGlobalServices(
  windowRegistry?: WindowRegistry
): Promise<"ok" | "exit-requested"> {
  setGlobalServicesInitialized(true);
  markPerformance(PERF_MARKS.SERVICE_INIT_START);

  // Store migrations — lazy-load the migrations barrel only when the store is
  // out of sync with the latest schema version. In the common case (already up
  // to date), this skips parsing ~15KB of migration modules on startup.
  try {
    const migrationRunner = new MigrationRunner(store);
    const currentVersion = migrationRunner.getCurrentVersion();
    if (currentVersion === 0 && wasStoreFreshAtBoot()) {
      // Brand-new install: no config.json existed at boot, so there is no
      // pre-existing data for the chain to transform — store defaults already
      // match the latest schema. Stamp the version directly instead of
      // replaying every migration, each of which pays an atomic config write
      // on the boot-critical path (~100ms for the full chain).
      store.set("_schemaVersion", LATEST_SCHEMA_VERSION);
    } else if (currentVersion !== LATEST_SCHEMA_VERSION) {
      console.log(
        `[MAIN] Running store migrations (v${currentVersion} -> v${LATEST_SCHEMA_VERSION})...`
      );
      const { migrations } = await import("../services/migrations/index.js");
      await migrationRunner.runMigrations(migrations);
      console.log("[MAIN] Store migrations completed");
    }
    markPerformance(PERF_MARKS.SERVICE_INIT_MIGRATIONS_DONE);
  } catch (error) {
    console.error("[MAIN] Store migration failed:", error);
    const message = formatErrorMessage(error, "Store migration failed");
    const lines = [`Couldn't migrate application data: ${message}`];
    if (isStoreMigrationError(error)) {
      if (error.restored) {
        // After a successful restore, backupPath has been renamed over
        // storePath and no longer exists on disk — don't print it.
        lines.push("", "Your pre-migration data has been restored.");
      } else if (error.backupPath) {
        lines.push("", `Pre-migration backup is preserved at:\n${error.backupPath}`);
      }
      if (error.failedStatePath) {
        lines.push("", `Failed migration state preserved at:\n${error.failedStatePath}`);
      }
    }
    lines.push("", "The application will exit.");
    dialog.showErrorBox("Migration failed", lines.join("\n"));
    app.exit(1);
    return "exit-requested";
  }

  // Adaptive-recovery + watchdog E2E seams (#9599), gated on
  // DAINTREE_E2E_FAULT_MODE — never present in production. Drive a synthetic
  // resource-profile transition and a synthetic watchdog cap-hit so the
  // full-resilience specs can assert the side-effects (PVM fan-out, the
  // `watchdog:disabled` broadcast) without real memory pressure or three
  // genuine watchdog crashes. (The GitHub token seams moved into the
  // daintree.github plugin's main module alongside its token storage.)
  if (isE2EFaultMode) {
    const VALID_RESOURCE_PROFILES = new Set<ResourceProfile>([
      "performance",
      "balanced",
      "efficiency",
    ]);
    (globalThis as Record<string, unknown>).__daintreeForceResourceProfile = (
      profile: ResourceProfile
    ) => {
      if (!VALID_RESOURCE_PROFILES.has(profile)) {
        throw new Error(`__daintreeForceResourceProfile: unknown profile "${profile}"`);
      }
      const svc = getResourceProfileService();
      if (!svc) throw new Error("ResourceProfileService not initialized");
      svc._forceProfileForTesting(profile);
    };
    (globalThis as Record<string, unknown>).__daintreeSimulateWatchdogDisabled = () => {
      const client = getMainProcessWatchdogClientRef();
      if (!client) throw new Error("MainProcessWatchdogClient not initialized");
      client._emitDisabledForTesting();
    };
  }

  // Notifications (global singletons)
  // AgentNotificationService is deferred — agents can't emit state events
  // before the renderer is interactive, and the boot grace period now starts
  // from the deferred initialize() so the suppression window still covers the
  // actual agent startup interval.
  getActionBreadcrumbService().initialize();

  // Plugin-action audit log: subscribes to action:dispatched and records every
  // plugin-contributed dispatch. Plaintext args are persisted only when the
  // developer has opted in via appState.developerMode.pluginAuditPlaintext.
  getPluginActionAuditService().initialize({
    isPlaintextEnabled: () => store.get("appState")?.developerMode?.pluginAuditPlaintext === true,
  });

  // ── Group 1: cheap synchronous wires ──
  // These were previously run on the same tick as loadRenderer(), contending
  // with the renderer for event-loop time while React hydrated and painted.
  // They now drain sequentially after the renderer signals first-interactive
  // (or after a fallback timeout), with `setImmediate` interleaved between
  // tasks so IPC from the renderer stays responsive during drain. Drain order
  // is registration order: cheap synchronous wires first (this group), then
  // telemetry, then the heavy dynamic-import tasks — see the group headers.

  registerDeferredTask({
    name: "crash-recovery-backup-timer",
    run: () => {
      getCrashRecoveryService().startBackupTimer();
    },
  });

  registerDeferredTask({
    name: "hibernation-service",
    run: () => {
      const svc = initializeHibernationService();
      // Let user-initiated hibernation reach every window's cached project
      // renderers so it can evict them (#10668). Lazy lambda — windows open and
      // close after this wires, so re-read the registry on each call. Same
      // pattern ResourceProfileService uses below.
      svc.setProjectViewManagersProvider(
        () =>
          windowRegistry
            ?.all()
            .map((wCtx) => wCtx.services.projectViewManager)
            .filter((pvm): pvm is ProjectViewManager => pvm !== undefined) ?? []
      );
      // Keep background hibernation off a running Daintree Assistant (#11477).
      // The same binding + PTY-liveness pair `ProjectViewManager` is wired with
      // in main.ts: the binding alone survives an assistant that exited under
      // its own steam, and `hasTerminal` is PtyClient's synchronous main-local
      // spawn registry, so it is authoritative from the assistant's first
      // instant. Lazy, like the provider above — the PtyClient is not resolved
      // yet at wiring time.
      svc.setHasLiveAssistantBackend((projectId) => {
        const backend = helpSessionService.getAssistantBackend(projectId);
        if (!backend) return false;
        return getPtyClient()?.hasTerminal(backend.terminalId) === true;
      });
    },
  });

  registerDeferredTask({
    name: "system-sleep-service",
    run: () => {
      initializeSystemSleepService();
    },
  });

  registerDeferredTask({
    name: "os-dnd-service",
    run: () => {
      initializeOsDndService();
    },
  });

  // Deferred timer + suspend-listener install for DB maintenance. The probe
  // and recovery still run synchronously in main.ts before the shared DB is
  // opened — only the 5-minute maintenance tick and the SystemSleepService
  // suspend hook are deferred. Registered AFTER system-sleep-service so the
  // suspend listener attaches to a live service.
  registerDeferredTask({
    name: "database-maintenance",
    run: () => {
      getDatabaseMaintenanceService().startMaintenance();
    },
  });

  registerDeferredTask({
    name: "disk-space-monitor",
    run: () => {
      if (getStopDiskSpaceMonitor()) return;
      setStopDiskSpaceMonitor(
        startDiskSpaceMonitor({
          sendStatus: (payload) => {
            if (windowRegistry) {
              for (const wCtx of windowRegistry.all()) {
                if (!wCtx.browserWindow.isDestroyed()) {
                  sendToRenderer(wCtx.browserWindow, CHANNELS.EVENTS_PUSH, {
                    name: "window:disk-space-status",
                    payload,
                  });
                }
              }
            }
          },
          onCriticalChange: (isCritical) => {
            const ptyClient = getPtyClient();
            if (isCritical) {
              getCrashRecoveryService().stopBackupTimer();
              ptyClient?.suppressSessionPersistence(true);
              // Disk just crossed the critical threshold — proactively reclaim
              // space instead of waiting for the next boot or idle sweep
              // (#9537). This callback runs synchronously on the event loop, so
              // every reclamation routine is fire-and-forget and must never
              // block or throw. The scratch sweep reclaims mature tombstones
              // immediately (its hard-delete DB write is what `getWritesSuppressed()`
              // defers); newly-stale scratches are tombstoned now and reaped on a
              // later sweep once past the grace window (#11353).
              runScratchCleanup().catch((err) => {
                logError("[DiskSpaceMonitor] scratch cleanup threw", err);
              });
              runAssistantScratchCleanup().catch((err) => {
                logError("[DiskSpaceMonitor] assistant scratch cleanup threw", err);
              });
              // The agent compile cache is itself a plausible cause of the
              // pressure — it reached 9.3 GB unbounded in #11699 — so it is
              // worth reclaiming on the critical edge rather than waiting for
              // the next idle tick.
              requestAgentCompileCacheCleanup().catch((err) => {
                logError("[DiskSpaceMonitor] agent compile cache cleanup threw", err);
              });
              try {
                const retentionDays = store.get("privacy")?.logRetentionDays ?? 30;
                if (retentionDays > 0) {
                  pruneOldLogs(app.getPath("userData"), retentionDays);
                }
                pruneHeapSnapshots(app.getPath("logs"), MAX_HEAP_SNAPSHOTS);
              } catch (err) {
                logError("[DiskSpaceMonitor] log prune threw", err);
              }
            } else {
              getCrashRecoveryService().startBackupTimer();
              ptyClient?.suppressSessionPersistence(false);
            }
          },
          showNativeNotification: (title, body) => {
            notificationService.showNativeNotification(title, body);
          },
          isWindowFocused: () => notificationService.isWindowFocused(),
        })
      );
    },
  });

  registerDeferredTask({
    name: "event-loop-lag-monitor",
    run: () => {
      if (!getStopEventLoopLagMonitor()) {
        setStopEventLoopLagMonitor(startEventLoopLagMonitor());
      }
      if (process.env.DAINTREE_PERF_CAPTURE === "1" && !getStopProcessMemoryMonitor()) {
        setStopProcessMemoryMonitor(startProcessMemoryMonitor());
      }
    },
  });

  registerDeferredTask({
    name: "main-idle-heap-compaction",
    run: () => {
      startMainIdleHeapCompaction();
    },
  });

  registerDeferredTask({
    name: "app-metrics-monitor",
    run: () => {
      if (getStopAppMetricsMonitor()) return;
      setStopAppMetricsMonitor(
        startAppMetricsMonitor({
          destroyHiddenWebviews: async (tier) => {
            let tabsEvicted = 0;
            if (windowRegistry) {
              for (const wCtx of windowRegistry.all()) {
                if (wCtx.browserWindow.isDestroyed()) continue;
                try {
                  if (wCtx.services.portalManager) {
                    const evictedTabIds = await wCtx.services.portalManager.destroyHiddenTabs();
                    if (evictedTabIds.length > 0) {
                      tabsEvicted += evictedTabIds.length;
                      sendToRenderer(wCtx.browserWindow, CHANNELS.PORTAL_TABS_EVICTED, {
                        tabIds: evictedTabIds,
                      });
                    }
                  }
                } catch {
                  /* non-critical */
                }
                try {
                  sendToRenderer(wCtx.browserWindow, CHANNELS.EVENTS_PUSH, {
                    name: "window:destroy-hidden-webviews",
                    payload: { tier },
                  });
                } catch {
                  /* non-critical */
                }
              }
            }
            return tabsEvicted;
          },
          hibernateIdleProjects: async () => {
            await getHibernationService().hibernateUnderMemoryPressure();
          },
          evictCachedProjectViews: () => {
            if (!windowRegistry) return 0;
            let viewsEvicted = 0;
            for (const wCtx of windowRegistry.all()) {
              viewsEvicted +=
                wCtx.services.projectViewManager?.reclaimCachedViewsUnderPressure() ?? 0;
            }
            return viewsEvicted;
          },
          trimPtyHostState: async () => {
            const client = getPtyClient();
            if (!client) return { trimmed: 0, skipped: 0, shardsTotal: 0, shardsFailed: 0 };
            // Graduated lever: never at the cost of a working agent's history.
            return client.trimState(SCROLLBACK_BACKGROUND, "idle-only");
          },
          sampleBlinkMemory: () => {
            if (!windowRegistry) return;
            const requestId = `blink-${Date.now().toString(36)}`;
            for (const wCtx of windowRegistry.all()) {
              const w = wCtx.browserWindow;
              if (w.isDestroyed()) continue;
              // Per-window PVM tracks every cached project renderer; falling
              // back to the app webContents covers windows still on the
              // bootstrap shell (no PVM yet).
              const pvm = wCtx.services.projectViewManager;
              const targets = pvm
                ? pvm.getAllViews().map((v) => v.view.webContents)
                : [getAppWebContents(w)];
              for (const wc of targets) {
                if (!wc || wc.isDestroyed()) continue;
                try {
                  wc.send(CHANNELS.EVENTS_PUSH, {
                    name: "window:sample-blink-memory",
                    payload: { requestId },
                  });
                } catch {
                  /* non-critical */
                }
              }
            }
          },
          sampleRendererElu: () => {
            if (!windowRegistry) return;
            const requestId = `elu-${Date.now().toString(36)}`;
            for (const wCtx of windowRegistry.all()) {
              const w = wCtx.browserWindow;
              if (w.isDestroyed()) continue;
              // Cached/loading views are CPU-throttled (Emulation.setCPUThrottlingRate)
              // or Efficiency-frozen (Page.setWebLifecycleState) which slows
              // JS timers and the LoAF observer, producing burst signal that
              // doesn't reflect user-visible lag. Only sample active views;
              // fall back to the app webContents for windows still on the
              // bootstrap shell (no PVM yet).
              const pvm = wCtx.services.projectViewManager;
              const targets = pvm
                ? pvm
                    .getAllViews()
                    .filter((v) => v.state === "active")
                    .map((v) => v.view.webContents)
                : [getAppWebContents(w)];
              for (const wc of targets) {
                if (!wc || wc.isDestroyed()) continue;
                try {
                  wc.send(CHANNELS.EVENTS_PUSH, {
                    name: "window:sample-renderer-elu",
                    payload: { requestId },
                  });
                } catch {
                  /* non-critical */
                }
              }
            }
          },
        })
      );
    },
  });

  // GitHub token storage, startup validation, and token-health probing are
  // all owned by the daintree.github plugin (storage initializes at plugin
  // module load; probing starts in activate() and stops on deactivation), so
  // a disabled plugin issues no GitHub network and holds no token state.

  // The registry that aggregates GitHub token health and MCP into a single
  // per-service connectivity snapshot for renderers. Registry must register
  // before mcp-server so it wires onStatusChange before MCP's first event —
  // preserved by the group split (mcp-server drains in the heavy group 3).
  registerDeferredTask({
    name: "service-connectivity-registry",
    run: () => {
      getServiceConnectivityRegistry().start();
    },
  });

  // Low-frequency re-invocation of the boot cleanup routines so on-disk state
  // doesn't grow unbounded across a long session (#9537). Gated on system idle
  // internally; disposed in shutdown.ts before the DB closes.
  registerDeferredTask({
    name: "periodic-cleanup",
    run: () => {
      getPeriodicCleanupService().start();
    },
  });

  // ── Group 2: telemetry ──
  // Registered immediately after the cheap group and BEFORE the heavy
  // dynamic-import group: trackEvent silently drops events while
  // captureEventFn is null, so telemetry-last would lose
  // deferred_init_task_failed events from (and delay crash capture for) the
  // heavy tasks below. Sentry's module graph is itself heavy, but one heavy
  // eval ahead of the rest buys observability over all of them.
  registerDeferredTask({
    name: "telemetry",
    run: async () => {
      await initializeTelemetry();
      setOnboardingCompleteTag(store.get("onboarding")?.completed === true);
    },
  });

  // ── Group 3: heavy dynamic-import tasks ──
  // Each task's first import() evals a large module graph (electron-updater,
  // the ~2900-line PluginService + manifest scans) in one un-yieldable
  // main-thread block. Registered last so the cheap wires above complete
  // while the renderer's post-hydration IPC burst (terminal restore spawns,
  // worktree fetches) is hottest, and the solid eval blocks land after it
  // tails off.

  registerDeferredTask({
    name: "agent-notification-service",
    run: async () => {
      const { agentNotificationService } = await import("../services/AgentNotificationService.js");
      setAgentNotificationServiceRef(agentNotificationService);
      agentNotificationService.initialize();
    },
  });

  // Forge matcher relay — pushes the provider hostname-matcher table into
  // workspace hosts on every registry change so worktree monitors can resolve
  // remote URLs to provider ids; the initial push covers providers registered
  // before this task ran.
  registerDeferredTask({
    name: "forge-matcher-relay",
    run: async () => {
      const { initForgeMatcherRelay } = await import("../services/forgeMatcherRelay.js");
      initForgeMatcherRelay();
    },
  });

  // Auto-updater
  //
  // The update-state pull is registered EAGERLY, unlike every other `update:*`
  // handler, which the deferred task below registers along with the service.
  // It has to be: the queue drains on `signalFirstInteractive`, which the
  // renderer itself sends, so `useUpdateListener` has already mounted and
  // hydrated by the time the task runs — a handler registered in there would
  // miss the very call it exists to answer, and reject it. Reading through the
  // service ref (as the menu does) keeps electron-updater's import deferred:
  // before the task runs the ref is null, which is the honest answer anyway —
  // no check has run yet, so nothing is pending.
  ipcMain.handle(
    CHANNELS.UPDATE_GET_LATEST,
    () => getAutoUpdaterServiceRef()?.getLatestUpdate() ?? null
  );

  registerDeferredTask({
    name: "auto-updater",
    run: async () => {
      const { autoUpdaterService } = await import("../services/AutoUpdaterService.js");
      setAutoUpdaterServiceRef(autoUpdaterService);
      // First wiring of the menu's update-state listener — menu builds before
      // this task are no-ops on the unset ref (see wireUpdateMenuState).
      wireUpdateMenuState();
      autoUpdaterService.initialize();
    },
  });

  // Windows Store update notifier — parallel path to electron-updater for
  // builds where the Store owns the install but the user still wants to know
  // a newer version is available.
  registerDeferredTask({
    name: "windows-store-notifier",
    run: async () => {
      const { windowsStoreNotifierService } =
        await import("../services/WindowsStoreNotifierService.js");
      setWindowsStoreNotifierServiceRef(windowsStoreNotifierService);
      windowsStoreNotifierService.initialize();
    },
  });

  // CCR config — discover Claude Code Router models as agent presets.
  // Deferred: the renderer fetches presets via getCcrPresets() which falls
  // through to [] when the cache is empty, and AGENT_PRESETS_UPDATED broadcasts
  // populate the renderer store as soon as loadAndApply() completes.
  registerDeferredTask({
    name: "ccr-config",
    run: async () => {
      const { CcrConfigService } = await import("../services/CcrConfigService.js");
      const ccr = CcrConfigService.getInstance();
      setCcrConfigService(ccr);
      try {
        await ccr.loadAndApply();
      } catch (err) {
        console.warn("[MAIN] CcrConfigService loadAndApply failed (non-fatal):", err);
      }
      // Watcher is independent of initial load success — if the config file
      // is malformed on first boot, polling lets us pick up the fix later.
      // startWatching() is idempotent.
      ccr.startWatching();
      console.log("[MAIN] CcrConfigService initialized");
    },
  });

  // Built-in commands — registration fires the githubCreateIssue/githubWorkIssue
  // chunk imports, so it belongs in the deferred queue, not main-module eval.
  // Commands must register before the renderer's command picker first calls
  // commands.list (post-first-interactive); loadCommands refetches on every
  // picker open, so a near-drain race self-heals. registerCommands() is
  // fire-and-forget internally and returns synchronously, never stalling the
  // drain. Registered once per process (initGlobalServices runs once),
  // matching the previous main.ts semantics.
  registerDeferredTask({
    name: "builtin-commands",
    run: () => {
      registerCommands();
    },
  });

  registerDeferredTask({
    name: "idle-terminal-notification-service",
    run: async () => {
      const { initializeIdleTerminalNotificationService } =
        await import("../services/IdleTerminalNotificationService.js");
      // Multi-window active guard — read every window's ProjectViewManager so a
      // project visible in a non-focused window is never nudged about its
      // "idle" terminals (#11102). Lazy lambda: windows open/close after this
      // wires, so re-read on each check.
      initializeIdleTerminalNotificationService(
        () =>
          windowRegistry
            ?.all()
            .map((wCtx) => wCtx.services.projectViewManager)
            .filter((pvm): pvm is ProjectViewManager => pvm !== undefined) ?? []
      );
    },
  });

  registerDeferredTask({
    name: "idle-background-auto-close-service",
    run: async () => {
      const { getIdleBackgroundAutoCloseService } =
        await import("../services/IdleBackgroundAutoCloseService.js");
      const svc = getIdleBackgroundAutoCloseService();
      svc.setPtyClient(getPtyClient());
      // Multi-window active guard — read every window's ProjectViewManager so a
      // project visible in a non-focused window is never auto-closed (#8607).
      // Lazy lambda: windows open/close after this wires, so re-read each sweep.
      // Wired BEFORE start() so the first (5s) sweep already sees the provider.
      svc.setProjectViewManagersProvider(
        () =>
          windowRegistry
            ?.all()
            .map((wCtx) => wCtx.services.projectViewManager)
            .filter((pvm): pvm is ProjectViewManager => pvm !== undefined) ?? []
      );
      svc.start();
    },
  });

  // Worker governance — providers for every persistent worker subsystem, so
  // diagnostics can report a bounded resource story and the efficiency profile
  // can request safe trims. Registered BEFORE resource-profile-service so the
  // profile service's trim dep resolves a fully-wired registry.
  registerDeferredTask({
    name: "worker-governance-service",
    run: async () => {
      const { getWorkerGovernanceService } = await import("../services/WorkerGovernanceService.js");
      const governance = getWorkerGovernanceService();
      governance.register({
        name: "db-worker",
        collect: async () => {
          const { getDbWorkerGovernanceSnapshot } =
            await import("../services/persistence/dbWorkerClient.js");
          const snapshot = getDbWorkerGovernanceSnapshot();
          return snapshot ? [snapshot] : [];
        },
        // Deliberately no trim: the DB worker's queue carries write ordering
        // and the shutdown drain owns its teardown.
      });
      governance.register({
        name: "plugin-workers",
        collect: async () => {
          const { pluginService } = await import("../services/PluginService.js");
          return pluginService.getWorkerGovernanceSnapshots();
        },
        trim: async () => {
          const { pluginService } = await import("../services/PluginService.js");
          pluginService.disposeIdlePluginWorkers();
        },
      });
      governance.register({
        name: "pty-host",
        collect: async () => {
          const client = getPtyClient();
          // No client yet = subsystem not started, nothing to report. A client
          // whose snapshot resolves null = host down/unresponsive — surface it
          // as a provider error rather than an empty (healthy-looking) report.
          if (!client) return [];
          const snapshot = await client.getWorkerGovernanceSnapshotAsync();
          if (!snapshot) {
            throw new Error("pty-host governance snapshot unavailable (host down or timed out)");
          }
          return [
            ...snapshot.workers,
            {
              kind: "pty-host" as const,
              id: "pty-host",
              pid: null,
              threadId: null,
              alive: true,
              activeSessionCount: snapshot.workers.reduce(
                (sum, w) => sum + w.activeSessionCount,
                0
              ),
              queueDepth: 0,
              lastActivityAt: snapshot.timestamp,
              memory: {
                rssBytes: snapshot.hostMemory.rssBytes,
                heapUsedBytes: snapshot.hostMemory.heapUsedBytes,
                externalBytes: snapshot.hostMemory.externalBytes,
              },
              eligibility: { trim: false, dispose: false, restart: false },
              state: "running",
            },
          ];
        },
        // No trim hook: the pty-host's idle-analysis trim rides the existing
        // set-resource-profile push (efficiency entry) — see resourceConfig.ts.
      });
      governance.register({
        name: "workspace-hosts",
        collect: async () => {
          const client = getWorkspaceClientRef();
          if (!client) return [];
          const { hosts, errors } = await client.getWorkerGovernanceSnapshotsAsync();
          // A host that failed to answer (crashed, mid-restart) must not
          // silently vanish from the report — synthesize an unreachable entry
          // so diagnostics and the why-slow degraded list show it.
          const unreachable: WorkerResourceSnapshot[] = errors.map(({ projectPath, error }) => {
            logWarn("worker-governance-workspace-host-failed", { projectPath, error });
            return {
              kind: "workspace-host" as const,
              id: `workspace-host:${projectPath}`,
              pid: null,
              threadId: null,
              alive: false,
              activeSessionCount: 0,
              queueDepth: 0,
              lastActivityAt: null,
              memory: null,
              eligibility: { trim: false, dispose: false, restart: false },
              state: "unreachable",
              detail: { error },
            };
          });
          return unreachable.concat(
            hosts.flatMap(({ projectPath, snapshot }) => [
              ...snapshot.workers.map((worker) => ({
                ...worker,
                id: `${worker.id}:${projectPath}`,
              })),
              {
                kind: "workspace-host" as const,
                id: `workspace-host:${projectPath}`,
                pid: null,
                threadId: null,
                alive: true,
                activeSessionCount: 0,
                queueDepth: 0,
                lastActivityAt: snapshot.timestamp,
                memory: {
                  rssBytes: snapshot.hostMemory.rssBytes,
                  heapUsedBytes: snapshot.hostMemory.heapUsedBytes,
                  externalBytes: snapshot.hostMemory.externalBytes,
                },
                eligibility: { trim: false, dispose: false, restart: false },
                state: "running",
              },
            ])
          );
        },
      });
    },
  });

  // Must register AFTER event-loop-lag and app-metrics monitors so it can
  // read their data once its own start() fires.
  registerDeferredTask({
    name: "resource-profile-service",
    run: async () => {
      if (getResourceProfileService()) return;
      const { ResourceProfileService } = await import("../services/ResourceProfileService.js");
      const svc = new ResourceProfileService({
        getPtyClient: () => getPtyClient(),
        getWorkspaceClient: () => getWorkspaceClientRef(),
        getHibernationService: () => getHibernationService(),
        getAllProjectViewManagers: () =>
          windowRegistry
            ?.all()
            .map((wCtx) => wCtx.services.projectViewManager)
            .filter((pvm): pvm is ProjectViewManager => pvm !== undefined) ?? [],
        getProjectStatsService: () => getProjectStatsService(),
        getFleetSnapshotService: () => getFleetSnapshotService(),
        getUserCachedViewLimit: () =>
          effectiveCachedProjectViews(store.get("terminalConfig")?.cachedProjectViews),
        hasSustainedRendererSaturation: () => hasSustainedRendererSaturation(),
        requestWorkerTrim: async () => {
          const { getWorkerGovernanceService } =
            await import("../services/WorkerGovernanceService.js");
          getWorkerGovernanceService().requestEfficiencyTrim();
        },
      });
      setResourceProfileService(svc);
      svc.start();
    },
  });

  // Plugin service — IPC handlers are registered eagerly in windowServices.ts
  // and return empty lists from internal Maps until initialize() populates them.
  // Plugin contributions broadcast on registration, so late init is renderer-safe.
  //
  registerDeferredTask({
    name: "plugin-service",
    run: async () => {
      const { pluginService } = await import("../services/PluginService.js");
      // Point the already-registered `plugin://` handler at the live resolver
      // BEFORE `initialize()` runs, not after (#11728). `getPluginDir` is a
      // plain lookup in a map that exists from construction, so it is safe to
      // call at any point — it simply returns `undefined` until a plugin
      // registers. Wiring it after `initialize()` left the placeholder resolver
      // live for the whole scan: `initialize()` sweeps temp dirs, fetches the
      // blocklist over the network, then awaits three sequential `loadFromDir`
      // passes (builtin, user, sideload), while the FIRST plugin's
      // `registerPanelKind` already broadcast an addressable `componentPath`.
      // Every `plugin://` module request in that window 404'd, and a rejected
      // dynamic import is permanent for that specifier — the module map has no
      // eviction, so "Try again" re-imported the same poisoned URL forever.
      setPluginDirResolver((pluginId) => pluginService.getPluginDir(pluginId));
      try {
        await pluginService.initialize();
      } catch (err) {
        console.error("[MAIN] PluginService initialization failed:", err);
      }
      // macOS: drain any `.dntr` paths queued during cold launch (Finder
      // double-click / "Open With") and take over live open-file events now
      // that PluginService can install an approved archive. Each path is queued
      // for the install-confirmation prompt, never installed outright (#11280).
      // Fire-and-forget — previewing runs concurrently with the remaining
      // deferred tasks. #9293
      void activateOpenFileInstaller().catch((err) =>
        console.error("[MAIN] Failed to activate the open-file archive queue:", err)
      );
      // Fire-and-forget — activations fan out in parallel and report errors
      // via the per-plugin `loadError` provenance record. Awaiting here would
      // delay subsequent deferred tasks behind the slowest plugin's activate().
      void pluginService.activateStartupFinishedPlugins();
    },
  });

  // CLI control socket (F32) — lets the `daintree-plugin` CLI install/uninstall
  // into this running instance. Registered after `plugin-service` and gated
  // internally on `pluginService.waitForInit()`, so the socket only accepts a
  // `plugin.install` once activation has settled. Skipped under smoke test (no
  // CLI driving a headless boot) to avoid leaving a socket behind.
  if (!isSmokeTest) {
    registerDeferredTask({
      name: "plugin-cli-server",
      run: async () => {
        // Fire-and-forget: startPluginCliServer() internally awaits
        // pluginService.waitForInit() (which only settles after startup
        // activation), so awaiting it here would stall every later deferred
        // task behind plugin activation. The waitForReady gate guarantees no
        // CLI request is serviced before init settles, so binding async is safe.
        const { startPluginCliServer } = await import("../services/PluginCliServer.js");
        void startPluginCliServer()
          .then(() => console.log("[MAIN] Plugin CLI control socket listening"))
          .catch((err) =>
            console.warn("[MAIN] Plugin CLI control socket failed to start (non-fatal):", err)
          );
      },
    });
  }

  // Plugin-MCP inbound audit log (#9234) — warm the hydrate() store read off
  // the cold-boot path (#10073). hydrate() is idempotent, and append() demand-
  // hydrates anyway, so this is purely pre-warming for when the supervisor
  // (#9233) lands. The consent service is not pre-warmed: its constructor is
  // bare allocation and PluginInstaller already constructs it lazily on demand.
  registerDeferredTask({
    name: "plugin-mcp-audit-warm",
    run: async () => {
      const { getPluginMcpAuditService } = await import("../services/plugin-mcp/instances.js");
      getPluginMcpAuditService().hydrate();
    },
  });

  // Opt-in background plugin update checks (#10893). Registered after
  // `plugin-service` so the checker reads a populated list; `start()` no-ops
  // while the feature is disabled (the default), so this is free when off.
  registerDeferredTask({
    name: "plugin-update-check-service",
    run: async () => {
      const { getPluginUpdateCheckService } =
        await import("../services/PluginUpdateCheckService.js");
      getPluginUpdateCheckService().start();
    },
  });

  if (windowRegistry) {
    const registryRef = windowRegistry;
    // Wire `helpSessionService.mcpRegistry` synchronously by construction (no
    // import, no await). The renderer can call `help:provision-session` as
    // soon as IPC handlers are registered (a few hundred ms before the first
    // deferred task runs); without this wire-up, `ensureMcpServerReady()`
    // would no-op on the null registry and the assistant would launch with a
    // stub `.mcp.json` missing the daintree entry. The setter is just a
    // reference store — no MCP SDK loaded.
    helpSessionService.setMcpRegistry(registryRef);

    // Arm the periodic orphan-bearer sweep (#10698): a defense-in-depth bound
    // that revokes provisional session tokens minted by a launch that hung and
    // was abandoned without the renderer revoking. The renderer watchdog is the
    // primary fix; this catches the residual case (renderer crash / view torn
    // down mid-launch). The timer is unref'd, so it never holds the process up.
    helpSessionService.startOrphanSweep();

    // Load the pending-hibernation file and wire it into HelpSessionService.
    // Floated, not awaited: the deadline is the user's first project switch
    // (project-view eviction fires inside `pvm.switchTo()`, possibly before
    // `APP_FIRST_INTERACTIVE` releases the deferred queue) — a missed wire-up
    // means the capture-on-eviction path silently no-ops and that switch
    // loses its hibernation entry. The chain is a single small JSON read that
    // finishes in single-digit ms, long before loadURL even resolves, so
    // floating keeps the disk I/O off the renderer-load dispatch path while
    // comfortably beating the deadline.
    void (async () => {
      const { getPendingHelpHibernationStore } =
        await import("../services/PendingHelpHibernationStore.js");
      const pendingStore = getPendingHelpHibernationStore();
      await pendingStore.load();
      helpSessionService.setPendingHibernationStore(pendingStore);
    })().catch((err) => {
      console.warn("[MAIN] Failed to wire pending-hibernation store:", err);
    });

    registerDeferredTask({
      name: "mcp-server",
      run: async () => {
        try {
          // The server defaults to disabled, and `httpLifecycle.start()` would
          // just no-op after we paid the ~637KB module load to find that out.
          // Mirror its enabled check with a synchronous store read and skip
          // the import entirely. Safe to skip: every mid-session enable path
          // (settings IPC, help-session provision, agent-spawn `ensureReady`)
          // dynamically imports the service itself, and
          // `HelpSessionService.ensureMcpServerReady()` re-wires the help-token
          // validators this task would have wired.
          if (!store.get("mcpServer").enabled) return;
          const { mcpServerService } = await import("../services/McpServerService.js");
          const { helpSessionService } = await import("../services/HelpSessionService.js");
          // Register the help-token validator before start() so the very first
          // request can authenticate against a help session if the renderer
          // races ahead of us. (Also wired in HelpSessionService.ensureMcpServerReady
          // — this deferred wiring covers the no-assistant warm-start path.)
          mcpServerService.setHelpTokenValidator((token) =>
            helpSessionService.validateToken(token)
          );
          mcpServerService.setHelpSessionWebContentsResolver((token) =>
            helpSessionService.getWebContentsIdForToken(token)
          );
          mcpServerService.setHelpSessionIdResolver((token) =>
            helpSessionService.getSessionIdForToken(token)
          );
          await mcpServerService.start(registryRef);
        } catch (err) {
          console.error("[MAIN] MCP server failed to start:", err);
        }
      },
    });

    registerDeferredTask({
      name: "help-session-gc",
      run: async () => {
        try {
          const { helpSessionService } = await import("../services/HelpSessionService.js");
          await helpSessionService.gcStaleSessions();
        } catch (err) {
          console.warn("[MAIN] Help session GC failed:", err);
        }
      },
    });

    // Wire HelpSessionService -> PtyClient so the single-backend invariant
    // (#7509) can fire-and-forget kill a displaced or revoked help PTY. Done
    // as a deferred task so we run after `perWindowInit` has set the global
    // ptyClient ref. If the ref is somehow still null when we drain (early
    // shutdown, fork crash), the displacement still revokes the bearer in
    // memory — the orphan's MCP calls 401 even without the kill landing.
    registerDeferredTask({
      name: "help-session-pty",
      run: async () => {
        try {
          const ptyClient = getPtyClient();
          if (!ptyClient) {
            console.warn(
              "[MAIN] PtyClient not available when wiring HelpSessionService — displacement will only revoke bearers"
            );
            return;
          }
          const { helpSessionService } = await import("../services/HelpSessionService.js");
          helpSessionService.setPtyClient(ptyClient);
        } catch (err) {
          console.warn("[MAIN] Failed to wire HelpSessionService PtyClient:", err);
        }
      },
    });
  }

  registerDeferredTask({
    name: "session-eviction",
    run: () => evictStaleSessionFiles(),
  });

  registerDeferredTask({
    name: "prune-old-logs",
    run: async () => {
      // Deferred (post first-interactive) and async (pruneOldLogsAsync yields to
      // the event loop between files) so the fs scan doesn't block the main
      // process. Note: `userData/debug/*.log` files have their mtimes refreshed
      // by `clearDebugLogs` during `initializeLogger` (pre-deferral), so debug
      // stubs effectively survive each prune cycle. They're empty (0 bytes) so
      // the accumulation is harmless; `userData/logs/` is still pruned correctly
      // because its files are appended-to, not truncated.
      const retentionDays = store.get("privacy")?.logRetentionDays ?? 30;
      await pruneOldLogsAsync(app.getPath("userData"), retentionDays);
      // Heap snapshots land in app.getPath("logs") (a separate dir from
      // userData/logs) and are bounded by count, not age — see pruneHeapSnapshots.
      await pruneHeapSnapshotsAsync(app.getPath("logs"), MAX_HEAP_SNAPSHOTS);
    },
  });

  // Fire-and-forget background cleanup services migrated out of main.ts
  // pre-window block (#8817). Each uses a lazy import() so the service module
  // isn't pulled into the static main.ts boot graph. No ordering constraints
  // among themselves or against the tasks above.
  //
  // GpuCrashMonitor is intentionally NOT deferred — it must install its
  // `child-process-gone` listener BEFORE the GPU process spawns (first
  // window creation), or startup-window GPU crashes are silently dropped.
  // It stays as an eager pre-window call in main.ts.
  registerDeferredTask({
    name: "agent-compile-cache-cleanup",
    // Fire-and-forget: the first sweep on an affected install may delete
    // gigabytes, which must not serialize the rest of the deferred queue.
    run: () => initializeAgentCompileCacheCleanup(),
  });

  registerDeferredTask({
    name: "trashed-pid-cleanup",
    run: async () => {
      const { initializeTrashedPidCleanup } = await import("../services/TrashedPidTracker.js");
      initializeTrashedPidCleanup();
    },
  });

  registerDeferredTask({
    name: "scratch-cleanup",
    run: async () => {
      const { initializeScratchCleanup } = await import("../services/ScratchCleanupService.js");
      initializeScratchCleanup();
    },
  });

  registerDeferredTask({
    name: "assistant-scratch-cleanup",
    run: async () => {
      const { startAssistantScratchCleanup } =
        await import("../services/AssistantScratchService.js");
      await startAssistantScratchCleanup();
    },
  });

  return "ok";
}

/**
 * Exported only for unit tests so they can verify session eviction logic
 * without driving the full deferred queue. Not part of the public surface.
 */
export const __test__ = { evictStaleSessionFiles };
