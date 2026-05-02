import { app, BrowserWindow, dialog, session, webContents } from "electron";
import os from "os";
import type { HandlerDependencies } from "../ipc/types.js";
import { registerIpcHandlers, sendToRenderer } from "../ipc/handlers.js";
import { getAppWebContents } from "./webContentsRegistry.js";
import { distributePortsToView } from "./portDistribution.js";
import { registerErrorHandlers, flushPendingErrors } from "../ipc/errorHandlers.js";
import { PtyClient, disposePtyClient } from "../services/PtyClient.js";
import {
  MainProcessWatchdogClient,
  getMainProcessWatchdogClient,
  disposeMainProcessWatchdog,
} from "../services/MainProcessWatchdogClient.js";
import {
  getWorkspaceClient,
  disposeWorkspaceClient,
  WorkspaceClient,
} from "../services/WorkspaceClient.js";
import { CliAvailabilityService } from "../services/CliAvailabilityService.js";
import { AgentVersionService } from "../services/AgentVersionService.js";
import { AgentUpdateHandler } from "../services/AgentUpdateHandler.js";
import { PortalManager } from "../services/PortalManager.js";
import { EventBuffer } from "../services/EventBuffer.js";
import { CHANNELS } from "../ipc/channels.js";
import { createApplicationMenu, handleDirectoryOpen } from "../menu.js";
import { ProjectSwitchService } from "../services/ProjectSwitchService.js";
import { projectStore } from "../services/ProjectStore.js";
import { taskQueueService } from "../services/TaskQueueService.js";
import { store } from "../store.js";
import {
  LATEST_SCHEMA_VERSION,
  MigrationRunner,
  isStoreMigrationError,
} from "../services/StoreMigrations.js";
import { initializeTelemetry, setOnboardingCompleteTag } from "../services/TelemetryService.js";
import { GitHubAuth } from "../services/github/GitHubAuth.js";
import { gitHubTokenHealthService } from "../services/github/GitHubTokenHealthService.js";
import {
  agentConnectivityService,
  getServiceConnectivityRegistry,
} from "../services/connectivity/index.js";
import { secureStorage } from "../services/SecureStorage.js";
import { notificationService } from "../services/NotificationService.js";
import type { agentNotificationService as AgentNotificationServiceType } from "../services/AgentNotificationService.js";
import { preAgentSnapshotService } from "../services/PreAgentSnapshotService.js";
import { getActionBreadcrumbService } from "../services/ActionBreadcrumbService.js";
import {
  initializeAgentAvailabilityStore,
  disposeAgentAvailabilityStore,
} from "../services/AgentAvailabilityStore.js";
import {
  initializePowerSaveBlockerService,
  disposePowerSaveBlockerService,
} from "../services/PowerSaveBlockerService.js";
import { initializeAgentRouter, disposeAgentRouter } from "../services/AgentRouter.js";

import {
  initializeTaskOrchestrator,
  disposeTaskOrchestrator,
} from "../services/TaskOrchestrator.js";
import type { autoUpdaterService as AutoUpdaterServiceType } from "../services/AutoUpdaterService.js";
import { runSmokeFunctionalChecks } from "../services/smokeTest.js";
import {
  initializeHibernationService,
  getHibernationService,
} from "../services/HibernationService.js";
import {
  evictSessionFiles,
  SESSION_EVICTION_TTL_MS,
  SESSION_EVICTION_MAX_BYTES,
} from "../services/pty/terminalSessionPersistence.js";
import {
  initializeSystemSleepService,
  getSystemSleepService,
} from "../services/SystemSleepService.js";
import { getCrashRecoveryService } from "../services/CrashRecoveryService.js";
import { getIdleTerminalNotificationService } from "../services/IdleTerminalNotificationService.js";
import {
  markPerformance,
  startEventLoopLagMonitor,
  startProcessMemoryMonitor,
} from "../utils/performance.js";
import { startAppMetricsMonitor } from "../services/ProcessMemoryMonitor.js";
import { ResourceProfileService } from "../services/ResourceProfileService.js";
import { startDiskSpaceMonitor, getCurrentDiskSpaceStatus } from "../services/DiskSpaceMonitor.js";
import { SCROLLBACK_BACKGROUND } from "../../shared/config/scrollback.js";
import { logInfo } from "../utils/logger.js";
import { PERF_MARKS } from "../../shared/perf/marks.js";
import { isSmokeTest, isDemoMode, smokeTestStart, exposeGc } from "../setup/environment.js";
import { shouldEnableEarlyRenderer } from "./earlyRenderer.js";
import { extractCliPath, getPendingCliPath, setPendingCliPath } from "../lifecycle/appLifecycle.js";
import type { WindowContext, WindowRegistry } from "./WindowRegistry.js";
import { getProjectViewManager } from "./windowRef.js";
import { getProjectStatsService } from "../ipc/handlers/projectCrud/index.js";
import {
  registerDeferredTask,
  finalizeDeferredRegistration,
  resetDeferredQueue,
} from "./deferredInitQueue.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { toDisposable } from "../utils/lifecycle.js";

const DEFAULT_TERMINAL_ID = "default";

// Guard: process.argv CLI path should only be consumed by the first window
let processArgvCliHandled = false;

// ── Global service refs (shared across all windows) ──
let ptyClient: PtyClient | null = null;
let mainProcessWatchdogClient: MainProcessWatchdogClient | null = null;
let workspaceClient: WorkspaceClient | null = null;
let cliAvailabilityService: CliAvailabilityService | null = null;
let agentVersionService: AgentVersionService | null = null;
let agentUpdateHandler: AgentUpdateHandler | null = null;
let cleanupIpcHandlers: (() => void) | null = null;
let cleanupErrorHandlers: (() => void) | null = null;
let stopEventLoopLagMonitor: (() => void) | null = null;
let stopProcessMemoryMonitor: (() => void) | null = null;
let stopAppMetricsMonitor: (() => void) | null = null;
let stopDiskSpaceMonitor: (() => void) | null = null;
let resourceProfileService: ResourceProfileService | null = null;
let worktreePortBroker: import("../services/WorktreePortBroker.js").WorktreePortBroker | null =
  null;
let ccrConfigService: import("../services/CcrConfigService.js").CcrConfigService | null = null;

// Singletons resolved by deferred tasks. Held here so dispose paths can clean
// them up safely if the task ran. If the window closes before the task runs
// (early shutdown), these stay null and the dispose path no-ops.
let autoUpdaterServiceRef: typeof AutoUpdaterServiceType | null = null;
let agentNotificationServiceRef: typeof AgentNotificationServiceType | null = null;

// Guard: IPC handlers are globally scoped (ipcMain.handle throws on re-registration)
let ipcHandlersRegistered = false;

// Guard: one-time global initialization (migrations, GitHubAuth, etc.)
let globalServicesInitialized = false;

// Expose getters for shutdown handler
export function getPtyClient(): PtyClient | null {
  return ptyClient;
}
export function setPtyClientRef(v: PtyClient | null): void {
  ptyClient = v;
}
export function getMainProcessWatchdogClientRef(): MainProcessWatchdogClient | null {
  return mainProcessWatchdogClient;
}
export function getWorkspaceClientRef(): WorkspaceClient | null {
  return workspaceClient;
}
export function getWorktreePortBrokerRef():
  | import("../services/WorktreePortBroker.js").WorktreePortBroker
  | null {
  return worktreePortBroker;
}
export function getCliAvailabilityServiceRef(): CliAvailabilityService | null {
  return cliAvailabilityService;
}
export function getCleanupIpcHandlers(): (() => void) | null {
  return cleanupIpcHandlers;
}
export function setCleanupIpcHandlers(v: (() => void) | null): void {
  cleanupIpcHandlers = v;
}
export function getCleanupErrorHandlers(): (() => void) | null {
  return cleanupErrorHandlers;
}
export function setCleanupErrorHandlers(v: (() => void) | null): void {
  cleanupErrorHandlers = v;
}
export function getStopEventLoopLagMonitor(): (() => void) | null {
  return stopEventLoopLagMonitor;
}
export function setStopEventLoopLagMonitor(v: (() => void) | null): void {
  stopEventLoopLagMonitor = v;
}
export function getStopProcessMemoryMonitor(): (() => void) | null {
  return stopProcessMemoryMonitor;
}
export function setStopProcessMemoryMonitor(v: (() => void) | null): void {
  stopProcessMemoryMonitor = v;
}
export function getStopAppMetricsMonitor(): (() => void) | null {
  return stopAppMetricsMonitor;
}
export function setStopAppMetricsMonitor(v: (() => void) | null): void {
  stopAppMetricsMonitor = v;
}
export function getStopDiskSpaceMonitor(): (() => void) | null {
  return stopDiskSpaceMonitor;
}
export function setStopDiskSpaceMonitor(v: (() => void) | null): void {
  stopDiskSpaceMonitor = v;
}

function createAndDistributePorts(win: BrowserWindow, ctx: WindowContext): void {
  const wc = getAppWebContents(win);
  distributePortsToView(win, ctx, wc, ptyClient);
}

async function evictStaleSessionFiles(): Promise<void> {
  try {
    const allProjects = projectStore.getAllProjects();
    const knownIds = new Set<string>();

    const states = await Promise.all(allProjects.map((p) => projectStore.getProjectState(p.id)));
    for (const state of states) {
      if (state?.terminals) {
        for (const t of state.terminals) {
          knownIds.add(t.id);
        }
      }
    }

    const appTerminals = store.get("appState")?.terminals;
    if (Array.isArray(appTerminals)) {
      for (const t of appTerminals) {
        knownIds.add(t.id);
      }
    }

    const result = await evictSessionFiles({
      ttlMs: SESSION_EVICTION_TTL_MS,
      maxBytes: SESSION_EVICTION_MAX_BYTES,
      knownIds,
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

export interface SetupWindowServicesOptions {
  loadRenderer: (reason: string, projectId?: string) => void;
  smokeTestTimer: ReturnType<typeof setTimeout> | undefined;
  smokeRendererUnresponsive: () => boolean;
  windowRegistry?: WindowRegistry;
  initialProjectPath?: string;
  /** Last-active projectId read before window creation for session partition assignment */
  initialProjectId?: string;
  projectViewManager?: import("./ProjectViewManager.js").ProjectViewManager;
  initialAppView?: import("electron").WebContentsView;
}

export async function setupWindowServices(
  win: BrowserWindow,
  opts: SetupWindowServicesOptions
): Promise<void> {
  const windowRegistry = opts.windowRegistry;
  const ctx = windowRegistry?.getByWindowId(win.id);
  if (!ctx) {
    console.error("[MAIN] Window not registered before setupWindowServices — skipping");
    return;
  }

  markPerformance(PERF_MARKS.WINDOW_SERVICES_START);

  // ── One-time global initialization (first window only) ──
  if (!globalServicesInitialized) {
    globalServicesInitialized = true;
    markPerformance(PERF_MARKS.SERVICE_INIT_START);

    // Store migrations — lazy-load the migrations barrel only when the store is
    // out of sync with the latest schema version. In the common case (already up
    // to date), this skips parsing ~15KB of migration modules on startup.
    try {
      const migrationRunner = new MigrationRunner(store);
      const currentVersion = migrationRunner.getCurrentVersion();
      if (currentVersion !== LATEST_SCHEMA_VERSION) {
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
      return;
    }

    // Sentry and GitHub token validation are deferred to after the renderer
    // reports first-interactive to avoid contending for the event loop while
    // React hydrates. GitHubAuth.initializeStorage must stay eager because
    // other services read tokens synchronously during startup.
    registerDeferredTask({
      name: "telemetry",
      run: async () => {
        await initializeTelemetry();
        setOnboardingCompleteTag(store.get("onboarding")?.completed === true);
      },
    });

    // Initialize GitHubAuth storage (must stay eager — synchronous reads)
    GitHubAuth.initializeStorage({
      get: () => secureStorage.get("userConfig.githubToken"),
      set: (token) => secureStorage.set("userConfig.githubToken", token),
      delete: () => secureStorage.delete("userConfig.githubToken"),
    });
    console.log("[MAIN] GitHubAuth initialized with storage");

    if (GitHubAuth.hasToken()) {
      const token = GitHubAuth.getToken();
      if (token) {
        const versionAtStart = GitHubAuth.getTokenVersion();
        registerDeferredTask({
          name: "github-auth-validate",
          run: async () => {
            try {
              const validation = await GitHubAuth.validate(token);
              if (validation.valid && validation.username) {
                GitHubAuth.setValidatedUserInfo(
                  validation.username,
                  validation.avatarUrl,
                  validation.scopes,
                  versionAtStart
                );
                console.log("[MAIN] GitHubAuth user info cached for:", validation.username);
              }
            } catch (err) {
              console.warn("[MAIN] Failed to validate stored GitHub token:", err);
            }
          },
        });
      }
    }

    // E2E hook: seed/clear an in-memory GitHub token so fault-mode tests can
    // reach IPC paths gated on `hasToken: true` without hitting the network.
    // Skips token validation by pre-seeding cached user info, mirroring the
    // post-validate state. Mirrors the __daintreeFaultRegistry / __daintreeResetRateLimits
    // pattern — gated on DAINTREE_E2E_FAULT_MODE, never present in production.
    if (process.env.DAINTREE_E2E_FAULT_MODE === "1") {
      (globalThis as Record<string, unknown>).__daintreeSeedGitHubToken = (token: string) => {
        GitHubAuth.setMemoryToken(token);
        const version = GitHubAuth.getTokenVersion();
        GitHubAuth.setValidatedUserInfo("e2e-user", undefined, ["repo"], version);
      };
      (globalThis as Record<string, unknown>).__daintreeClearGitHubToken = () => {
        GitHubAuth.setMemoryToken(null);
      };
    }

    // Start background token-health polling (30-minute interval + focus/wake
    // re-checks). The service guards itself with the GitHubAuth.tokenVersion
    // so a stale probe cannot clobber a freshly-set token.
    gitHubTokenHealthService.start();
    console.log("[MAIN] GitHubTokenHealthService started");

    // Start background agent provider reachability probes (Claude, Gemini,
    // Codex). Then wire up the registry that aggregates GitHub, agents, and
    // MCP into a single per-service connectivity snapshot for renderers.
    agentConnectivityService.start();
    getServiceConnectivityRegistry().start();
    console.log("[MAIN] ServiceConnectivityRegistry started");

    // Notifications (global singletons)
    // AgentNotificationService is deferred — agents can't emit state events
    // before the renderer is interactive, and its boot grace period now starts
    // from the deferred initialize() so the suppression window still covers
    // the actual agent startup interval.
    preAgentSnapshotService.initialize();
    getActionBreadcrumbService().initialize();

    registerDeferredTask({
      name: "agent-notification-service",
      run: async () => {
        const { agentNotificationService } =
          await import("../services/AgentNotificationService.js");
        agentNotificationServiceRef = agentNotificationService;
        agentNotificationService.initialize();
      },
    });

    // Auto-updater
    registerDeferredTask({
      name: "auto-updater",
      run: async () => {
        const { autoUpdaterService } = await import("../services/AutoUpdaterService.js");
        autoUpdaterServiceRef = autoUpdaterService;
        autoUpdaterService.initialize();
      },
    });

    // CCR config — discover Claude Code Router models as agent presets
    try {
      const { CcrConfigService } = await import("../services/CcrConfigService.js");
      ccrConfigService = CcrConfigService.getInstance();
      await ccrConfigService.loadAndApply();
      ccrConfigService.startWatching();
      console.log("[MAIN] CcrConfigService initialized");
    } catch (err) {
      console.warn("[MAIN] CcrConfigService init failed (non-fatal):", err);
    }

    // ── Deferred global service starts ──
    // These were previously run on the same tick as loadRenderer(), contending
    // with the renderer for event-loop time while React hydrated and painted.
    // They now drain sequentially after the renderer signals first-interactive
    // (or after a fallback timeout), with `setImmediate` interleaved between
    // tasks so IPC from the renderer stays responsive during drain.

    registerDeferredTask({
      name: "crash-recovery-backup-timer",
      run: () => {
        getCrashRecoveryService().startBackupTimer();
      },
    });

    registerDeferredTask({
      name: "hibernation-service",
      run: () => {
        initializeHibernationService();
      },
    });

    registerDeferredTask({
      name: "idle-terminal-notification-service",
      run: async () => {
        const { initializeIdleTerminalNotificationService } =
          await import("../services/IdleTerminalNotificationService.js");
        initializeIdleTerminalNotificationService();
      },
    });

    registerDeferredTask({
      name: "system-sleep-service",
      run: () => {
        initializeSystemSleepService();
      },
    });

    registerDeferredTask({
      name: "disk-space-monitor",
      run: () => {
        if (stopDiskSpaceMonitor) return;
        stopDiskSpaceMonitor = startDiskSpaceMonitor({
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
            if (isCritical) {
              getCrashRecoveryService().stopBackupTimer();
              ptyClient?.suppressSessionPersistence(true);
            } else {
              getCrashRecoveryService().startBackupTimer();
              ptyClient?.suppressSessionPersistence(false);
            }
          },
          showNativeNotification: (title, body) => {
            notificationService.showNativeNotification(title, body);
          },
          isWindowFocused: () => notificationService.isWindowFocused(),
        });
      },
    });

    registerDeferredTask({
      name: "event-loop-lag-monitor",
      run: () => {
        if (!stopEventLoopLagMonitor) {
          stopEventLoopLagMonitor = startEventLoopLagMonitor();
        }
        if (process.env.DAINTREE_PERF_CAPTURE === "1" && !stopProcessMemoryMonitor) {
          stopProcessMemoryMonitor = startProcessMemoryMonitor();
        }
      },
    });

    registerDeferredTask({
      name: "app-metrics-monitor",
      run: () => {
        if (stopAppMetricsMonitor) return;
        stopAppMetricsMonitor = startAppMetricsMonitor({
          clearCaches: async () => {
            try {
              await session.defaultSession.clearCache();
            } catch {
              /* non-critical */
            }
            try {
              await session.defaultSession.clearStorageData({
                storages: ["shadercache", "cachestorage"],
              });
            } catch {
              /* non-critical */
            }
            try {
              exposeGc?.();
            } catch {
              /* non-critical */
            }
            if (windowRegistry) {
              for (const wCtx of windowRegistry.all()) {
                if (!wCtx.browserWindow.isDestroyed()) {
                  try {
                    sendToRenderer(wCtx.browserWindow, CHANNELS.EVENTS_PUSH, {
                      name: "window:reclaim-memory",
                      payload: { reason: "memory-pressure" },
                    });
                  } catch {
                    /* non-critical */
                  }
                }
              }
            }
          },
          destroyHiddenWebviews: async (tier) => {
            if (windowRegistry) {
              for (const wCtx of windowRegistry.all()) {
                if (wCtx.browserWindow.isDestroyed()) continue;
                try {
                  if (wCtx.services.portalManager) {
                    const evictedTabIds = await wCtx.services.portalManager.destroyHiddenTabs();
                    if (evictedTabIds.length > 0) {
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
          },
          hibernateIdleProjects: async () => {
            await getHibernationService().hibernateUnderMemoryPressure();
          },
          trimPtyHostState: () => {
            ptyClient?.trimState(SCROLLBACK_BACKGROUND);
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
              // Cached/loading views have setBackgroundThrottling(true) which
              // throttles JS timers and the LoAF observer, producing burst
              // signal that doesn't reflect user-visible lag. Only sample
              // active views; fall back to the app webContents for windows
              // still on the bootstrap shell (no PVM yet).
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
        });
      },
    });

    // Must register AFTER event-loop-lag and app-metrics monitors so it can
    // read their data once its own start() fires.
    registerDeferredTask({
      name: "resource-profile-service",
      run: () => {
        if (resourceProfileService) return;
        resourceProfileService = new ResourceProfileService({
          getPtyClient: () => ptyClient,
          getWorkspaceClient: () => workspaceClient,
          getHibernationService: () => getHibernationService(),
          getProjectViewManager: () => getProjectViewManager(),
          getProjectStatsService: () => getProjectStatsService(),
          getUserCachedViewLimit: () =>
            store.get("terminalConfig")?.cachedProjectViews ??
            (process.env.DAINTREE_E2E_MODE ? 4 : 1),
        });
        resourceProfileService.start();
      },
    });

    if (windowRegistry) {
      const registryRef = windowRegistry;
      registerDeferredTask({
        name: "mcp-server",
        run: async () => {
          try {
            const { mcpServerService } = await import("../services/McpServerService.js");
            await mcpServerService.start(registryRef);
          } catch (err) {
            console.error("[MAIN] MCP server failed to start:", err);
          }
        },
      });
    }

    registerDeferredTask({
      name: "session-eviction",
      run: () => evictStaleSessionFiles(),
    });
  }

  // ── Per-window initialization ──

  // Menu & Notifications (per-window: menu references this window)
  console.log("[MAIN] Creating application menu (initial, no agent availability yet)...");
  if (!cliAvailabilityService) {
    cliAvailabilityService = new CliAvailabilityService();
  }
  createApplicationMenu(win, cliAvailabilityService);

  // Per-window deferred work. Menu is window-specific, so each window queues
  // its own CLI check + menu rebuild. Registered here (before any awaits that
  // could hang) so finalize below is guaranteed to run.
  const cliService = cliAvailabilityService;
  registerDeferredTask({
    name: `cli-availability-check:${win.id}`,
    run: async () => {
      try {
        const availability = await cliService.checkAvailability();
        console.log("[MAIN] CLI availability checked:", availability);
        if (!win.isDestroyed()) {
          createApplicationMenu(win, cliService);
        }
      } catch (err) {
        console.error("[MAIN] CliAvailabilityService initialization failed:", err);
      }
    },
  });

  // Arm the drain trigger immediately. All tasks for this window are now
  // registered; any subsequent `await` in setupWindowServices could hang
  // (PTY host, workspace loadProject, plugin init) and must not block the
  // deferred queue from becoming drainable. The renderer's first-interactive
  // IPC fires on the happy path; the 10s fallback drains on hang.
  finalizeDeferredRegistration();

  if (windowRegistry) {
    notificationService.initialize(windowRegistry);
    ctx.cleanup.add(toDisposable(() => notificationService.detachWindowListeners(win.id)));
  }
  console.log("[MAIN] NotificationService initialized");

  // Critical services (global, first window only)
  if (!ptyClient) {
    console.log("[MAIN] Starting critical services...");

    // Start the external main-process watchdog before PtyClient so a deadlock
    // during PTY host fork (worst case: a synchronous spawn that hangs) is
    // still recoverable. The watchdog is fail-open: if its own fork throws,
    // PtyClient still starts normally.
    if (!mainProcessWatchdogClient) {
      try {
        // Use the singleton accessor so `disposeMainProcessWatchdog()` in
        // shutdown.ts reaches the running instance instead of a no-op.
        mainProcessWatchdogClient = getMainProcessWatchdogClient();
      } catch (err) {
        console.error("[MAIN] Failed to start main-process watchdog:", err);
        mainProcessWatchdogClient = null;
      }
    }

    ptyClient = new PtyClient({
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
      showCrashDialog: false,
    });

    agentVersionService = new AgentVersionService(cliAvailabilityService);
    agentUpdateHandler = new AgentUpdateHandler(
      ptyClient,
      agentVersionService,
      cliAvailabilityService
    );

    ptyClient.on("host-crash-details", (details) => {
      console.error(`[MAIN] Pty Host crashed:`, details);
      // Broadcast to all windows
      if (windowRegistry) {
        for (const wCtx of windowRegistry.all()) {
          const w = wCtx.browserWindow;
          if (!w.isDestroyed()) {
            const wc = getAppWebContents(w);
            if (!wc.isDestroyed()) {
              try {
                wc.send(CHANNELS.EVENTS_PUSH, {
                  name: "terminal:backend-crashed",
                  payload: {
                    crashType: details.crashType,
                    code: details.code,
                    signal: details.signal,
                    timestamp: details.timestamp,
                  },
                });
              } catch {
                // Silently ignore send failures during window disposal.
              }
            }
          }
        }
      }
    });
    ptyClient.on("host-crash", (code) => {
      console.error(`[MAIN] Pty Host crashed with code ${code} (max restarts exceeded)`);
    });
    ptyClient.on("host-throttled", (payload) => {
      if (!payload.isThrottled) {
        logInfo("pty-host-resumed", { duration: payload.duration });
        return;
      }
      logInfo("pty-host-throttled", { reason: payload.reason });
      try {
        session.defaultSession.clearCache().catch(() => {});
      } catch {
        /* non-critical */
      }
      // Broadcast to all windows
      if (windowRegistry) {
        for (const wCtx of windowRegistry.all()) {
          const w = wCtx.browserWindow;
          if (!w.isDestroyed()) {
            try {
              sendToRenderer(w, CHANNELS.EVENTS_PUSH, {
                name: "window:reclaim-memory",
                payload: { reason: "pty-host-pressure" },
              });
            } catch {
              /* non-critical */
            }
          }
        }
      }
      try {
        ptyClient!.trimState(SCROLLBACK_BACKGROUND);
      } catch {
        /* non-critical */
      }
    });
    ptyClient.setPortRefreshCallback(() => {
      console.log("[MAIN] Pty Host restarted, refreshing ports...");
      // Refresh ports for ALL registered windows — target the active view
      if (windowRegistry) {
        for (const wCtx of windowRegistry.all()) {
          if (!wCtx.browserWindow.isDestroyed()) {
            const wc = getAppWebContents(wCtx.browserWindow);
            if (!wc.isDestroyed()) {
              distributePortsToView(wCtx.browserWindow, wCtx, wc, ptyClient);
              try {
                wc.send(CHANNELS.EVENTS_PUSH, {
                  name: "terminal:backend-ready",
                  payload: undefined,
                });
              } catch {
                // Silently ignore send failures during window disposal.
              }
            }
          }
        }
      }
    });
  }

  // Per-window services
  ctx.services.eventBuffer = new EventBuffer(1000);
  // EventBuffer.start() must run eagerly — it subscribes to the internal event
  // bus so early-boot events (migrations, PTY init, hydration) reach the
  // inspector. Deferring would drop those events.
  ctx.services.eventBuffer.start();
  ctx.services.portalManager = new PortalManager(win);
  ctx.services.projectSwitchService = new ProjectSwitchService({
    mainWindow: win,
    ptyClient: ptyClient ?? undefined,
    eventBuffer: ctx.services.eventBuffer,
    portalManager: ctx.services.portalManager,
    cliAvailabilityService,
    agentVersionService,
    agentUpdateHandler,
    isDemoMode,
    windowRegistry,
  } as HandlerDependencies);

  // Per-window cleanup: ports, portalManager, eventBuffer
  ctx.cleanup.add(
    toDisposable(() => {
      // Notify PTY host to disconnect this window's port before closing it
      if (ptyClient) {
        ptyClient.disconnectMessagePort(ctx.windowId);
      }
      if (ctx.services.activeRendererPort) {
        try {
          ctx.services.activeRendererPort.close();
        } catch {
          /* ignore */
        }
        ctx.services.activeRendererPort = undefined;
      }
      if (ctx.services.activePtyHostPort) {
        try {
          ctx.services.activePtyHostPort.close();
        } catch {
          /* ignore */
        }
        ctx.services.activePtyHostPort = undefined;
      }
      if (ctx.services.portalManager) {
        ctx.services.portalManager.destroy();
        ctx.services.portalManager = undefined;
      }
      if (ctx.services.eventBuffer) {
        ctx.services.eventBuffer.stop();
        ctx.services.eventBuffer = undefined;
      }
      ctx.services.projectSwitchService = undefined;
      if (workspaceClient) {
        workspaceClient.unregisterWindow(win.id);
      }
    })
  );

  console.log("[MAIN] Registering IPC handlers...");
  const handlerDeps: HandlerDependencies = {
    mainWindow: win,
    ptyClient: ptyClient ?? undefined,
    eventBuffer: ctx.services.eventBuffer,
    portalManager: ctx.services.portalManager,
    cliAvailabilityService,
    agentVersionService: agentVersionService ?? undefined,
    agentUpdateHandler: agentUpdateHandler ?? undefined,
    isDemoMode,
    windowRegistry,
  };

  handlerDeps.projectSwitchService = ctx.services.projectSwitchService;

  // IPC handlers are globally scoped — register only once
  if (!ipcHandlersRegistered) {
    ipcHandlersRegistered = true;
    cleanupIpcHandlers = registerIpcHandlers(handlerDeps);
    markPerformance(PERF_MARKS.SERVICE_INIT_IPC_READY);

    try {
      const { pluginService } = await import("../services/PluginService.js");
      await pluginService.initialize();
    } catch (error) {
      console.error("[MAIN] PluginService initialization failed:", error);
    }
  }

  // Renderer load is gated by DAINTREE_EARLY_RENDERER. With the flag, the
  // did-finish-load handler is registered and loadRenderer() is fired before
  // the workspace/PTY init block — first paint stops waiting on the PTY
  // handshake. Without the flag (default), the original serial order is kept:
  // workspace init → handler → loadRenderer.
  const earlyRendererEnabled = shouldEnableEarlyRenderer({ isSmokeTest, env: process.env });

  let rendererLoadStarted = false;
  const startRendererLoad = (reason: string): void => {
    if (rendererLoadStarted) return;
    rendererLoadStarted = true;

    // Handle reloads (per-window) — listen on the app view's webContents.
    // MUST be attached BEFORE loadRenderer() to avoid missing the first did-finish-load.
    const appWc = getAppWebContents(win);
    appWc.on("did-finish-load", () => {
      const currentUrl = appWc.getURL();
      if (currentUrl.includes("recovery.html")) {
        console.log("[MAIN] Recovery page loaded, skipping normal renderer bootstrap");
        return;
      }
      console.log("[MAIN] Renderer loaded, ensuring MessagePort connection...");
      if (isSmokeTest) console.error("[SMOKE] CHECK: Renderer did-finish-load — OK");
      markPerformance(PERF_MARKS.RENDERER_READY);
      createAndDistributePorts(win, ctx);
      // Refresh workspace direct port on reload (preload context is reset).
      // Under DAINTREE_EARLY_RENDERER, workspaceClient may still be null on the
      // first did-finish-load — the initial direct-port attach is performed by
      // the loadProject() path below once the workspace host is ready.
      if (workspaceClient) {
        workspaceClient.attachDirectPort(win.id, appWc);

        // Re-broker worktree port for initial view reload
        if (worktreePortBroker) {
          const host = workspaceClient.getHostForWindow(win.id);
          if (host) {
            worktreePortBroker.brokerPort(host, appWc);
          }
        }
      }
      flushPendingErrors();
      const diskStatus = getCurrentDiskSpaceStatus();
      if (diskStatus.status !== "normal") {
        sendToRenderer(win, CHANNELS.EVENTS_PUSH, {
          name: "window:disk-space-status",
          payload: diskStatus,
        });
      }
    });

    opts.loadRenderer(reason, opts.initialProjectId);
  };

  if (earlyRendererEnabled) {
    console.log("[MAIN] DAINTREE_EARLY_RENDERER=1 — loading renderer in parallel with PTY init");
    startRendererLoad("early-renderer");
  }

  // Initialize workspace client (first window only) — per-project hosts
  // are started on-demand when loadProject() is called, not at init time.
  if (!workspaceClient) {
    console.log("[MAIN] Waiting for Pty Host to be ready before initializing Workspace Client...");
    try {
      await ptyClient!.waitForReady();
      console.log("[MAIN] Pty Host ready, initializing Workspace Client...");
      markPerformance(PERF_MARKS.SERVICE_INIT_PTY_READY);
    } catch (error) {
      console.error("[MAIN] Pty Host failed to start:", error);
    }

    workspaceClient = getWorkspaceClient({
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 60000,
      showCrashDialog: false,
    });

    // Give PluginService the WorkspaceClient reference now that it's ready —
    // PluginService.initialize() ran earlier before workspaceClient existed.
    try {
      const { pluginService } = await import("../services/PluginService.js");
      pluginService.setWorkspaceClient(workspaceClient);
    } catch (err) {
      console.error("[MAIN] Failed to wire WorkspaceClient into PluginService:", err);
    }

    markPerformance(PERF_MARKS.SERVICE_INIT_WORKSPACE_READY);

    // Create WorktreePortBroker alongside WorkspaceClient
    if (!worktreePortBroker) {
      const { WorktreePortBroker } = await import("../services/WorktreePortBroker.js");
      worktreePortBroker = new WorktreePortBroker();
    }

    handlerDeps.worktreeService = workspaceClient;
    handlerDeps.worktreePortBroker = worktreePortBroker ?? undefined;

    workspaceClient.on("host-crash", (code: number) => {
      console.error(`[MAIN] Workspace Host crashed with code ${code}`);
    });

    // Re-broker worktree ports when a workspace host restarts
    workspaceClient.on(
      "host-restarted",
      ({
        projectPath,
        host,
      }: {
        projectPath: string;
        host: import("../services/WorkspaceHostProcess.js").WorkspaceHostProcess;
      }) => {
        if (!worktreePortBroker) return;
        const wcIds = worktreePortBroker.closePortsForHost(projectPath);
        if (wcIds.length > 0) {
          worktreePortBroker.reBrokerForHost(
            host,
            (wcId: number) => webContents.fromId(wcId) ?? undefined,
            wcIds
          );
          console.log(`[MAIN] Re-brokered ${wcIds.length} worktree port(s) after host restart`);
        }
      }
    );
  }

  const { armRestoreQuota } = await import("../ipc/utils.js");
  armRestoreQuota(50, 120_000);

  // Under DAINTREE_EARLY_RENDERER=1 the RENDERER_READY mark can fire before
  // this point, since the renderer is loading concurrently with workspace init.
  markPerformance(PERF_MARKS.SERVICE_INIT_COMPLETE);
  // Default path: renderer load happens here, after workspace + PTY are ready.
  // With DAINTREE_EARLY_RENDERER=1 this is a no-op (already started above).
  startRendererLoad("after-services-ready");

  // Error handlers also use ipcMain.handle — register once
  if (!cleanupErrorHandlers) {
    cleanupErrorHandlers = registerErrorHandlers(workspaceClient, ptyClient);
  }

  console.log("[MAIN] All critical services ready");

  // Wait for remaining services
  console.log("[MAIN] Waiting for remaining services to initialize...");
  let ptyReady = false;
  // Workspace client is always "ready" — per-project hosts start on-demand via loadProject()
  const workspaceReady = true;

  try {
    const results = await Promise.allSettled([
      ptyClient!.waitForReady(),
      projectStore.initialize(),
    ]);

    ptyReady = results[0].status === "fulfilled";
    const projectStoreReady = results[1].status === "fulfilled";

    if (ptyReady && workspaceReady && projectStoreReady) {
      console.log("[MAIN] All critical services ready");
    } else {
      const failures: string[] = [];
      if (!ptyReady)
        failures.push(
          `PTY service: ${results[0].status === "rejected" ? results[0].reason?.message || "unknown error" : "timeout"}`
        );
      if (!projectStoreReady)
        failures.push(
          `Project store: ${results[1].status === "rejected" ? results[1].reason?.message || "unknown error" : "timeout"}`
        );

      console.error("[MAIN] Service initialization failed:", failures);

      dialog
        .showMessageBox(win, {
          type: "error",
          title: "Service Initialization Failed",
          message: `One or more services failed to start:\n\n${failures.join("\n")}\n\nThe application will continue in degraded mode. Some features may be unavailable.\n\nTry restarting the application if problems persist.`,
          buttons: ["OK"],
        })
        .catch(console.error);
    }
  } catch (error) {
    console.error("[MAIN] Unexpected error during service initialization:", error);
  }

  // Per-window project binding: use opts.initialProjectId/initialProjectPath
  // instead of the global current project (which belongs to another window).
  const restoreProject = opts.initialProjectId
    ? projectStore.getProjectById(opts.initialProjectId)
    : undefined;

  // PTY-related features
  if (ptyReady) {
    createAndDistributePorts(win, ctx);

    if (restoreProject) {
      ptyClient!.setActiveProject(win.id, restoreProject.id, restoreProject.path);
    } else {
      ptyClient!.setActiveProject(win.id, null);
    }

    const availabilityStore = initializeAgentAvailabilityStore();
    const agentRouter = initializeAgentRouter(availabilityStore);
    initializePowerSaveBlockerService();
    console.log("[MAIN] AgentAvailabilityStore, AgentRouter, and PowerSaveBlocker initialized");

    initializeTaskOrchestrator(ptyClient!, agentRouter);
    console.log("[MAIN] TaskOrchestrator initialized");

    const processArgvCli = !processArgvCliHandled ? extractCliPath(process.argv) : null;
    const skipDefaultSpawn =
      opts.initialProjectPath || processArgvCli || getPendingCliPath() || restoreProject;
    if (skipDefaultSpawn) {
      console.log(
        "[MAIN] CLI path, initial project path, or existing project set, skipping default terminal spawn"
      );
    } else {
      const terminalId = `${DEFAULT_TERMINAL_ID}-${win.id}`;
      console.log("[MAIN] Spawning default terminal:", terminalId);
      try {
        ptyClient!.spawn(terminalId, {
          cwd: os.homedir(),
          cols: 80,
          rows: 30,
        });
      } catch (error) {
        console.error("[MAIN] Failed to spawn default terminal:", error);
      }
    }
  } else {
    console.warn("[MAIN] PTY service unavailable - skipping terminal setup");
  }

  // Register the initial view with ProjectViewManager — only when this window
  // has a project binding (startup restore). Unbound windows (Cmd+N) start
  // with the project picker and get their view registered on project open.
  if (opts.projectViewManager && opts.initialAppView && restoreProject) {
    opts.projectViewManager.registerInitialView(
      opts.initialAppView,
      restoreProject.id,
      restoreProject.path
    );
  }

  // Add ProjectViewManager to handler deps for IPC handlers
  if (opts.projectViewManager) {
    handlerDeps.projectViewManager = opts.projectViewManager;
    ctx.services.projectViewManager = opts.projectViewManager;
  }

  // Load worktrees — prefer initialProjectPath, else restoreProject for
  // startup windows. Unbound windows (no project) skip worktree loading.
  const projectPathForWorktrees = opts.initialProjectPath ?? restoreProject?.path;
  if (projectPathForWorktrees && workspaceClient && workspaceReady) {
    console.log("[MAIN] Loading worktrees for project path:", projectPathForWorktrees);
    try {
      await workspaceClient.loadProject(projectPathForWorktrees, win.id);
      console.log("[MAIN] Worktrees loaded");

      // Attach direct MessagePort for workspace events (bypasses main-process relay)
      const directPortTarget = opts.initialAppView?.webContents ?? getAppWebContents(win);
      if (directPortTarget && !directPortTarget.isDestroyed()) {
        workspaceClient.attachDirectPort(win.id, directPortTarget);
        console.log("[MAIN] Workspace direct port attached");

        // Broker new worktree port (Phase 1)
        const host = workspaceClient.getHostForProject(projectPathForWorktrees);
        if (host && worktreePortBroker) {
          worktreePortBroker.brokerPort(host, directPortTarget);
          console.log("[MAIN] Worktree port brokered");
        }
      }
    } catch (error) {
      console.error("[MAIN] Failed to load worktrees:", error);
    }
  } else if (projectPathForWorktrees && !workspaceReady) {
    console.warn("[MAIN] Workspace service unavailable - skipping worktree loading");
  }

  // Task queue & workflow (startup restore only — not for unbound or path windows)
  if (restoreProject && !opts.initialProjectPath) {
    console.log("[MAIN] Initializing task queue for current project:", restoreProject.name);
    try {
      await taskQueueService.initialize(restoreProject.id);
      console.log("[MAIN] Task queue initialized for current project");
    } catch (error) {
      console.error("[MAIN] Failed to initialize task queue:", error);
    }
  }

  // Smoke test
  if (isSmokeTest) {
    if (opts.smokeTestTimer) clearTimeout(opts.smokeTestTimer);
    const bootMs = Date.now() - smokeTestStart;
    console.error("[SMOKE] CHECK: Window created — OK");
    console.error("[SMOKE] CHECK: PTY service — %s", ptyReady ? "OK" : "FAILED");
    console.error("[SMOKE] CHECK: Workspace service — %s", workspaceReady ? "OK" : "FAILED");
    console.error("[SMOKE] CHECK: Auto-updater module — OK");
    console.error("[SMOKE] GPU feature status:", JSON.stringify(app.getGPUFeatureStatus()));
    console.error("[SMOKE] Boot completed in %dms", bootMs);

    if (!ptyReady || !workspaceReady) {
      console.error("[SMOKE] FAILED — one or more services did not start");
      if (win && !win.isDestroyed()) win.destroy();
      workspaceClient!.dispose();
      ptyClient!.dispose();
      app.exit(1);
      return;
    }

    const smokeClient = ptyClient!;
    const allPassed = await runSmokeFunctionalChecks(
      win,
      smokeClient,
      opts.smokeRendererUnresponsive
    );

    if (win && !win.isDestroyed()) win.destroy();
    try {
      workspaceClient!.dispose();
    } catch {
      /* ignore */
    }
    try {
      ptyClient!.dispose();
    } catch {
      /* ignore */
    }
    app.exit(allPassed ? 0 : 1);
    return;
  }

  // CLI path handling — skip if this window was opened with an explicit initialProjectPath
  if (!opts.initialProjectPath) {
    const firstLaunchCliPath = !processArgvCliHandled ? extractCliPath(process.argv) : null;
    if (firstLaunchCliPath) processArgvCliHandled = true;
    const cliPath = firstLaunchCliPath ?? getPendingCliPath();
    if (cliPath) {
      setPendingCliPath(null);
      console.log("[MAIN] Opening CLI path from launch args:", cliPath);
      handleDirectoryOpen(cliPath, win, cliAvailabilityService ?? undefined).catch((err) =>
        console.error("[MAIN] Failed to open CLI path:", err)
      );
    }
  } else {
    console.log("[MAIN] Window opened with initial project path:", opts.initialProjectPath);
    handleDirectoryOpen(opts.initialProjectPath, win, cliAvailabilityService ?? undefined).catch(
      (err) => console.error("[MAIN] Failed to open initial project path:", err)
    );
  }

  // ── Last-window-close: dispose global services ──
  // Per-window cleanup is handled by ctx.cleanup (run by WindowRegistry.unregister).
  // This handler only disposes global singletons when the last window closes.
  win.on("closed", async () => {
    if (windowRegistry && windowRegistry.size > 0) {
      // Other windows still open — do not dispose global services
      return;
    }

    // Last window closed — dispose global services.
    // Stop the CCR config watcher first, before any guard resets or IPC teardown.
    // Awaiting here blocks a new window from racing into the init block (which would
    // restart the singleton watcher) and finding this handler about to null the ref.
    if (ccrConfigService) {
      await ccrConfigService.stopWatching();
      ccrConfigService = null;
    }

    if (stopEventLoopLagMonitor) {
      stopEventLoopLagMonitor();
      stopEventLoopLagMonitor = null;
    }
    if (stopProcessMemoryMonitor) {
      stopProcessMemoryMonitor();
      stopProcessMemoryMonitor = null;
    }
    if (stopAppMetricsMonitor) {
      stopAppMetricsMonitor();
      stopAppMetricsMonitor = null;
    }
    if (stopDiskSpaceMonitor) {
      stopDiskSpaceMonitor();
      stopDiskSpaceMonitor = null;
    }
    if (resourceProfileService) {
      resourceProfileService.stop();
      resourceProfileService = null;
    }

    if (worktreePortBroker) worktreePortBroker.dispose();
    worktreePortBroker = null;
    if (workspaceClient) workspaceClient.dispose();
    workspaceClient = null;
    disposeWorkspaceClient();

    // Drop PluginService's WorkspaceClient reference so plugin event handlers
    // can't fire into the disposed instance during late teardown.
    try {
      const { pluginService } = await import("../services/PluginService.js");
      pluginService.setWorkspaceClient(null);
    } catch {
      // module load errors during teardown are non-fatal
    }

    disposeTaskOrchestrator();
    disposeAgentRouter();
    disposePowerSaveBlockerService();
    disposeAgentAvailabilityStore();

    if (ptyClient) ptyClient.dispose();
    ptyClient = null;
    disposePtyClient();

    if (mainProcessWatchdogClient) mainProcessWatchdogClient.dispose();
    mainProcessWatchdogClient = null;
    disposeMainProcessWatchdog();

    // Clean up IPC handlers and reset guards so next window re-registers fresh
    if (cleanupIpcHandlers) {
      cleanupIpcHandlers();
      cleanupIpcHandlers = null;
    }
    if (cleanupErrorHandlers) {
      cleanupErrorHandlers();
      cleanupErrorHandlers = null;
    }
    ipcHandlersRegistered = false;
    globalServicesInitialized = false;
    resetDeferredQueue();

    getHibernationService().stop();
    getIdleTerminalNotificationService().stop();
    getCrashRecoveryService().stopBackupTimer();
    getSystemSleepService().dispose();
    gitHubTokenHealthService.dispose();
    agentConnectivityService.dispose();
    getServiceConnectivityRegistry().dispose();
    notificationService.dispose();
    if (agentNotificationServiceRef) {
      agentNotificationServiceRef.dispose();
      agentNotificationServiceRef = null;
    }
    preAgentSnapshotService.dispose();
    if (autoUpdaterServiceRef) {
      autoUpdaterServiceRef.dispose();
      autoUpdaterServiceRef = null;
    }
  });
}
