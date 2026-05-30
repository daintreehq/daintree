// eager-import-allow: reads boot config via store.get synchronously while wiring global services
import { app, dialog, session } from "electron";
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
import { preAgentSnapshotService } from "../services/PreAgentSnapshotService.js";
import { getActionBreadcrumbService } from "../services/ActionBreadcrumbService.js";
import { getPluginActionAuditService } from "../services/PluginActionAuditService.js";
import {
  getPluginMcpAuditService,
  getPluginMcpConsentService,
} from "../services/plugin-mcp/instances.js";
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
import {
  markPerformance,
  startEventLoopLagMonitor,
  startProcessMemoryMonitor,
} from "../utils/performance.js";
import { startAppMetricsMonitor } from "../services/ProcessMemoryMonitor.js";

import { startDiskSpaceMonitor } from "../services/DiskSpaceMonitor.js";
import { pruneOldLogs } from "../utils/logger.js";
import { SCROLLBACK_BACKGROUND } from "../../shared/config/scrollback.js";
import { PERF_MARKS } from "../../shared/perf/marks.js";
import { CHANNELS } from "../ipc/channels.js";
import { sendToRenderer } from "../ipc/handlers.js";
import { getAppWebContents } from "./webContentsRegistry.js";
import type { WindowRegistry } from "./WindowRegistry.js";
import type { ProjectViewManager } from "./ProjectViewManager.js";
import { getProjectStatsService } from "../ipc/handlers/projectCrud/index.js";
import { registerDeferredTask } from "./deferredInitQueue.js";
import { isSmokeTest } from "../setup/environment.js";
import { projectStore } from "../services/ProjectStore.js";
import { store } from "../store.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import {
  setCcrConfigService,
  getResourceProfileService,
  setResourceProfileService,
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
  setAgentNotificationServiceRef,
  setWindowsStoreNotifierServiceRef,
  setGlobalServicesInitialized,
} from "./serviceRefs.js";

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

/**
 * Run the once-per-app-lifecycle global initialization on the first window
 * setup. Migrations run inline (synchronous, blocking); everything else is
 * either a synchronous boot (GitHubAuth storage, ActionBreadcrumbService) or
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
    return "exit-requested";
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

  // Notifications (global singletons)
  // AgentNotificationService and PreAgentSnapshotService are deferred — agents
  // can't emit state events before the renderer is interactive, and the boot
  // grace period now starts from the deferred initialize() so the suppression
  // window still covers the actual agent startup interval.
  getActionBreadcrumbService().initialize();

  // Plugin-action audit log: subscribes to action:dispatched and records every
  // plugin-contributed dispatch. Plaintext args are persisted only when the
  // developer has opted in via appState.developerMode.pluginAuditPlaintext.
  getPluginActionAuditService().initialize({
    isPlaintextEnabled: () => store.get("appState")?.developerMode?.pluginAuditPlaintext === true,
  });

  // Plugin-MCP inbound audit + TOFU consent stores (#9234). Hydrate eagerly so
  // the first plugin-MCP tool call from the supervisor (#9233, TODO) does not
  // race the lazy store read. The consent service has no subscribers itself —
  // it's invoked synchronously from the supervisor's tools/call interception
  // path once that lands.
  getPluginMcpAuditService().hydrate();
  getPluginMcpConsentService();

  registerDeferredTask({
    name: "agent-notification-service",
    run: async () => {
      const { agentNotificationService } = await import("../services/AgentNotificationService.js");
      setAgentNotificationServiceRef(agentNotificationService);
      agentNotificationService.initialize();
    },
  });

  // Auto-updater
  registerDeferredTask({
    name: "auto-updater",
    run: async () => {
      const { autoUpdaterService } = await import("../services/AutoUpdaterService.js");
      setAutoUpdaterServiceRef(autoUpdaterService);
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

  // Plugin service — IPC handlers are registered eagerly in windowServices.ts
  // and return empty lists from internal Maps until initialize() populates them.
  // Plugin contributions broadcast on registration, so late init is renderer-safe.
  registerDeferredTask({
    name: "plugin-service",
    run: async () => {
      const { pluginService } = await import("../services/PluginService.js");
      try {
        await pluginService.initialize();
      } catch (err) {
        console.error("[MAIN] PluginService initialization failed:", err);
      }
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

  // Pre-agent snapshot pruning + 1-hour interval timer. Deferred so the
  // initial pruneAllWorktrees() pass and setInterval arming don't contend
  // with renderer hydration. Registered AFTER system-sleep-service so the
  // suspend/wake listeners attach to a live service.
  registerDeferredTask({
    name: "pre-agent-snapshot-service",
    run: () => {
      preAgentSnapshotService.initialize();
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
    name: "app-metrics-monitor",
    run: () => {
      if (getStopAppMetricsMonitor()) return;
      setStopAppMetricsMonitor(
        startAppMetricsMonitor({
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
          accelerateTerminalHibernation: (level: 1 | 2) => {
            // Fan the per-window push event so every renderer compresses
            // its hibernation timer. Mirrors the destroyHiddenWebviews
            // fanout pattern above — broadcastToRenderer is not used
            // because the renderer's TerminalInstanceService is window-
            // scoped (xterm instances live in a single project view), so
            // there's nothing to gain from a global broadcast.
            if (!windowRegistry) return;
            for (const wCtx of windowRegistry.all()) {
              if (wCtx.browserWindow.isDestroyed()) continue;
              try {
                sendToRenderer(wCtx.browserWindow, CHANNELS.EVENTS_PUSH, {
                  name: "window:accelerate-hibernation",
                  payload: { level },
                });
              } catch {
                /* non-critical */
              }
            }
          },
          trimPtyHostState: () => {
            getPtyClient()?.trimState(SCROLLBACK_BACKGROUND);
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
        getUserCachedViewLimit: () =>
          store.get("terminalConfig")?.cachedProjectViews ??
          (process.env.DAINTREE_E2E_MODE ? 4 : 1),
      });
      setResourceProfileService(svc);
      svc.start();
    },
  });

  // Background token-health polling (30-minute interval + focus/wake
  // re-checks). The service guards itself with the GitHubAuth.tokenVersion
  // so a stale probe cannot clobber a freshly-set token.
  registerDeferredTask({
    name: "github-token-health",
    run: () => {
      gitHubTokenHealthService.start();
    },
  });

  // Background agent provider reachability probes (Claude, Gemini, Codex)
  // and the registry that aggregates GitHub, agents, and MCP into a single
  // per-service connectivity snapshot for renderers. Registry must register
  // before mcp-server so it wires onStatusChange before MCP's first event.
  registerDeferredTask({
    name: "agent-connectivity",
    run: () => {
      agentConnectivityService.start();
    },
  });

  registerDeferredTask({
    name: "service-connectivity-registry",
    run: () => {
      getServiceConnectivityRegistry().start();
    },
  });

  if (windowRegistry) {
    const registryRef = windowRegistry;
    // Wire `helpSessionService.mcpRegistry` synchronously, BEFORE the
    // deferred queue drains. The renderer can call `help:provision-session`
    // as soon as IPC handlers are registered (a few hundred ms before the
    // first deferred task runs); without this synchronous wire-up,
    // `ensureMcpServerReady()` would no-op on the null registry and the
    // assistant would launch with a stub `.mcp.json` missing the daintree
    // entry. The setter is just a reference store — no MCP SDK loaded.
    try {
      const { helpSessionService } = await import("../services/HelpSessionService.js");
      helpSessionService.setMcpRegistry(registryRef);
    } catch (err) {
      console.error("[MAIN] Failed to wire HelpSessionService MCP registry:", err);
    }

    // Load the pending-hibernation file and wire it into HelpSessionService
    // synchronously, BEFORE the deferred queue drains. Project-view eviction
    // fires inside `pvm.switchTo()` and can run as soon as the user does the
    // first project switch — which can be before `APP_FIRST_INTERACTIVE`
    // releases the deferred queue. A missed wire-up means the capture-on-
    // eviction path silently no-ops and the user's first cross-project
    // switch loses its hibernation entry. Wiring here mirrors the
    // setMcpRegistry rationale above. Disk I/O is a single small JSON read.
    try {
      const { getPendingHelpHibernationStore } =
        await import("../services/PendingHelpHibernationStore.js");
      const pendingStore = getPendingHelpHibernationStore();
      await pendingStore.load();
      const { helpSessionService } = await import("../services/HelpSessionService.js");
      helpSessionService.setPendingHibernationStore(pendingStore);
    } catch (err) {
      console.warn("[MAIN] Failed to wire pending-hibernation store:", err);
    }

    registerDeferredTask({
      name: "mcp-server",
      run: async () => {
        try {
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
    run: () => {
      // Deferred (post first-interactive) so the synchronous fs scan doesn't
      // block cold start. Note: `userData/debug/*.log` files have their mtimes
      // refreshed by `clearDebugLogs` during `initializeLogger` (pre-deferral),
      // so debug stubs effectively survive each prune cycle. They're empty
      // (0 bytes) so the accumulation is harmless; `userData/logs/` is still
      // pruned correctly because its files are appended-to, not truncated.
      const retentionDays = store.get("privacy")?.logRetentionDays ?? 30;
      if (retentionDays > 0) {
        pruneOldLogs(app.getPath("userData"), retentionDays);
      }
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
