import { BrowserWindow, session } from "electron";
import type { HandlerDependencies } from "../ipc/types.js";
import { sendToRenderer } from "../ipc/handlers.js";
import {
  clearPortHolderWebContentsIfCurrent,
  getAppWebContents,
  setFallbackEligibleProjectsListener,
} from "./webContentsRegistry.js";
import { distributePortsToView, releaseAllTerminalWorkerPorts } from "./portDistribution.js";
import { resolveInitialColorSchemeId } from "./skeletonCss.js";
import { resolveAppTheme } from "../../shared/theme/index.js";
import { PtyClient } from "../services/PtyClient.js";
import type { MainProcessWatchdogClient } from "../services/MainProcessWatchdogClient.js";
import { CliAvailabilityService } from "../services/CliAvailabilityService.js";
import { AgentVersionService } from "../services/AgentVersionService.js";
import { AgentModelCatalogService } from "../services/AgentModelCatalogService.js";
import { AgentUpdateHandler } from "../services/AgentUpdateHandler.js";
import { PortalManager } from "../services/PortalManager.js";
import { EventBuffer } from "../services/EventBuffer.js";
import { CHANNELS } from "../ipc/channels.js";
import { getEndpointRegistry } from "../ipc/endpointRegistry.js";
import { createApplicationMenu } from "../menu.js";
import { onPluginToursChanged } from "../services/plugin/PluginTourRegistry.js";
import { ProjectSwitchService } from "../services/ProjectSwitchService.js";
import { notificationService } from "../services/NotificationService.js";
import { projectStore } from "../services/ProjectStore.js";
import { logInfo } from "../utils/logger.js";
import { SCROLLBACK_BACKGROUND } from "../../shared/config/scrollback.js";
import type { HostMemoryPauseSnapshot } from "../../shared/types/pty-host.js";
import { isDemoMode } from "../setup/environment.js";
import type { WindowContext, WindowRegistry } from "./WindowRegistry.js";
import { registerDeferredTask, finalizeDeferredRegistration } from "./deferredInitQueue.js";
import { toDisposable } from "../utils/lifecycle.js";
import {
  getCliAvailabilityServiceRef,
  setCliAvailabilityServiceRef,
  getPtyClient,
  setPtyClientRef,
  getAgentVersionService,
  setAgentVersionService,
  getAgentModelCatalogService,
  setAgentModelCatalogService,
  getAgentUpdateHandler,
  setAgentUpdateHandler,
  getWorkspaceClientRef,
} from "./serviceRefs.js";

/**
 * Deliver a host event on the `events:push` bus to every view attached over a
 * link. This machine's windows are reached by the callers' own loops, which
 * stay as they are; a remote view has no window here to loop over.
 */
function pushHostEventToRemoteViews(name: string, payload: unknown): void {
  const registry = getEndpointRegistry();
  if (!registry.hasRemote()) return;
  for (const endpoint of registry.getRemote()) {
    try {
      endpoint.send({ type: "event", channel: CHANNELS.EVENTS_PUSH, args: [{ name, payload }] });
    } catch {
      // A closing link must not break delivery to the remaining endpoints.
    }
  }
}

/**
 * Run the per-window initialization steps that happen on every
 * `setupWindowServices` call: the per-window CLI deferred task,
 * deferred-queue arming, NotificationService wire-up, first-window-only
 * critical-services boot (PtyClient), and per-window service
 * objects (EventBuffer, PortalManager, ProjectSwitchService, ctx.cleanup).
 *
 * Returns a partially-populated `HandlerDependencies` for the caller to extend
 * with `worktreeService`, `worktreePortBroker`, and `projectViewManager` once
 * the workspace client and ProjectViewManager are wired in the orchestrator.
 */
export async function initPerWindowServices(
  win: BrowserWindow,
  ctx: WindowContext,
  windowRegistry: WindowRegistry | undefined
): Promise<HandlerDependencies> {
  const cliAvailabilityService = ensureCliAvailabilityService();

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

  // Native View/Help menus include plugin-contributed menu items via
  // `getPluginMenuItems()` at build time, but the initial `createApplicationMenu`
  // (now in setupWindowServices, after the renderer-load kick-off) runs before
  // any plugin's `activate()` has finished — so the first menu would
  // show none of them. Lazy-import `pluginService` to avoid the cyclic edge
  // (`PluginService` depends on services that may eventually reach window
  // code), then await init and rebuild once. Dynamic plugin load/unload does
  // not refresh the native menu — accepted limitation: the native app menu is
  // rebuilt once after init, not on every subsequent contribution change.
  registerDeferredTask({
    name: `plugin-menu-rebuild:${win.id}`,
    run: async () => {
      try {
        const { pluginService } = await import("../services/PluginService.js");
        await pluginService.waitForInit();
        if (!win.isDestroyed()) {
          createApplicationMenu(win, cliService);
        }
      } catch (err) {
        console.error("[MAIN] Plugin menu rebuild failed:", err);
      }
    },
  });

  // Plugin tours are listed in Help, and unlike other plugin menu items they
  // must leave it when their plugin is disabled or uninstalled (#12773), so the
  // menu is rebuilt when the tour set changes. Debounced: one plugin load or
  // unload can change it several times in a tick.
  let tourMenuRebuild: ReturnType<typeof setTimeout> | null = null;
  const unsubscribeTours = onPluginToursChanged(() => {
    if (tourMenuRebuild) return;
    tourMenuRebuild = setTimeout(() => {
      tourMenuRebuild = null;
      if (win.isDestroyed()) return;
      // The menu is app-wide but built against one window's state; let the
      // focused window build it when there is one.
      const focused = BrowserWindow.getFocusedWindow();
      if (focused && focused !== win) return;
      try {
        createApplicationMenu(win, cliService);
      } catch (err) {
        console.error("[MAIN] Plugin tour menu rebuild failed:", err);
      }
    }, 50);
  });
  win.once("closed", () => {
    unsubscribeTours();
    if (tourMenuRebuild) clearTimeout(tourMenuRebuild);
  });

  // Arm the drain trigger immediately. All tasks for this window are now
  // registered; any subsequent `await` in setupWindowServices could hang
  // (PTY host, workspace loadProject, plugin init) and must not block the
  // deferred queue from becoming drainable. The renderer's first-interactive
  // IPC fires on the happy path; the 10s fallback drains on hang.
  finalizeDeferredRegistration();

  if (windowRegistry) {
    notificationService.initialize(windowRegistry, (projectId) =>
      projectStore.getProjectById(projectId)
    );
    ctx.cleanup.add(toDisposable(() => notificationService.detachWindowListeners(win.id)));
  }
  console.log("[MAIN] NotificationService initialized");

  const ptyClient = ensureCriticalServices(windowRegistry);

  // Per-window services
  ctx.services.eventBuffer = new EventBuffer(1000);
  // EventBuffer.start() must run eagerly — it subscribes to the internal event
  // bus so early-boot events (migrations, PTY init, hydration) reach the
  // inspector. Deferring would drop those events.
  ctx.services.eventBuffer.start();
  // Match the main app view's background color so portal WebContentsView's
  // first paint blends with the window chrome instead of flashing white when a
  // tab is created or returned to after an overlay (#9207). Custom-scheme
  // precision isn't load-bearing here — the goal is "not white", so we resolve
  // the base scheme without threading customSchemes through this code path.
  const portalBackgroundColor = resolveAppTheme(resolveInitialColorSchemeId(), []).tokens[
    "surface-canvas"
  ];
  ctx.services.portalManager = new PortalManager(win, portalBackgroundColor);
  ctx.services.projectSwitchService = new ProjectSwitchService({
    mainWindow: win,
    ptyClient,
    eventBuffer: ctx.services.eventBuffer,
    portalManager: ctx.services.portalManager,
    cliAvailabilityService,
    agentVersionService: getAgentVersionService() ?? undefined,
    agentUpdateHandler: getAgentUpdateHandler() ?? undefined,
    isDemoMode,
    windowRegistry,
  } as HandlerDependencies);

  // Per-window cleanup: ports, portalManager, eventBuffer
  ctx.cleanup.add(
    toDisposable(() => {
      // Paint-fabric surface views: release their pty-host connections first
      // (the broker disconnects each synthetic connection id), then tear down
      // the sibling WebContentsViews.
      if (ctx.services.surfacePortBroker) {
        try {
          ctx.services.surfacePortBroker.dispose();
        } catch (error) {
          console.error("[perWindowInit] SurfacePortBroker dispose failed:", error);
        }
        ctx.services.surfacePortBroker = undefined;
      }
      if (ctx.services.surfaceViewManager) {
        ctx.services.surfaceViewManager.dispose().catch((error) => {
          console.error("[perWindowInit] SurfaceViewManager dispose failed:", error);
        });
        ctx.services.surfaceViewManager = undefined;
      }
      // Notify PTY host to disconnect this window's port before closing it
      const pty = getPtyClient();
      if (pty) {
        pty.disconnectMessagePort(ctx.windowId);
      }
      releaseAllTerminalWorkerPorts(ctx, pty);
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
      const ws = getWorkspaceClientRef();
      if (ws) {
        ws.unregisterWindow(win.id);
      }
    })
  );

  const handlerDeps: HandlerDependencies = {
    mainWindow: win,
    ptyClient,
    eventBuffer: ctx.services.eventBuffer,
    portalManager: ctx.services.portalManager,
    cliAvailabilityService,
    agentVersionService: getAgentVersionService() ?? undefined,
    agentUpdateHandler: getAgentUpdateHandler() ?? undefined,
    isDemoMode,
    windowRegistry,
  };

  handlerDeps.projectSwitchService = ctx.services.projectSwitchService;

  return handlerDeps;
}

function ensureCliAvailabilityService(): CliAvailabilityService {
  let cliAvailabilityService = getCliAvailabilityServiceRef();
  if (!cliAvailabilityService) {
    cliAvailabilityService = new CliAvailabilityService();
    setCliAvailabilityServiceRef(cliAvailabilityService);
  }
  return cliAvailabilityService;
}

/**
 * Construct the process-wide critical services once — the PtyClient (with its
 * host fork deferred) and the agent version/model/update services — for
 * whichever boot path gets here first: the first window's setup or the
 * windowless Host runtime. Later callers get the existing client.
 */
export function ensureCriticalServices(windowRegistry: WindowRegistry | undefined): PtyClient {
  const cliAvailabilityService = ensureCliAvailabilityService();
  const existing = getPtyClient();
  if (existing) return existing;
  console.log("[MAIN] Starting critical services...");

  // PtyClient is constructed with `deferStart` so the PTY host fork does NOT
  // happen here — `ensurePtyHostStarted()` (boot/hostServices.ts) triggers it,
  // after `startRendererLoad` on a windowed boot, awaiting the early PATH
  // refresh immediately before forking. That keeps the #8625 invariant (PATH
  // refresh → PTY fork, so node-pty inherits version-manager shims and
  // user-local bin dirs in packaged builds) while no longer gating the first
  // renderer load on the refresh (#8827). Constructing the client here keeps
  // a live `ptyClient` reference available to IPC handlers at registration
  // time — only the host fork is deferred, not the client object. The
  // main-process watchdog starts alongside the fork: its ordering invariant is
  // watchdog-before-ptyClient.start(), not watchdog-before-renderer-load.

  const ptyClient = new PtyClient({
    healthCheckIntervalMs: 5000,
    showCrashDialog: false,
    // Defer the host fork to ensurePtyHostStarted (#8827) — see the comment
    // above. The client object is live now; the fork waits on the PATH
    // refresh after startRendererLoad.
    deferStart: true,
  });
  setPtyClientRef(ptyClient);

  // Keep the host's fallback-eligible project set current (#12557). The
  // registry spans every window, and `ptyClient` is a process-wide singleton,
  // so this is installed once beside its construction rather than per window.
  // Fires immediately with the current set, which is empty this early — the
  // real value arrives as views register and broker their ports.
  setFallbackEligibleProjectsListener((projectIds) => {
    ptyClient?.setFallbackEligibleProjects(projectIds);
  });

  // A window whose port the host tore down has no reachable view any more,
  // so the record is cleared to re-open the IPC fallback for it. Identity-
  // guarded: a "port-replace" teardown is processed by the host only after
  // Main has already registered the replacement holder, so clearing blindly
  // would wipe the live record and leave the window permanently holderless —
  // every chunk of its project then taking a fallback nobody acks.
  ptyClient.on("port-disconnected", (windowId, _reason, holderWebContentsId) => {
    clearPortHolderWebContentsIfCurrent(windowId, holderWebContentsId);
  });

  const versionSvc = new AgentVersionService(cliAvailabilityService);
  setAgentVersionService(versionSvc);
  setAgentUpdateHandler(new AgentUpdateHandler(ptyClient, versionSvc, cliAvailabilityService));

  if (!getAgentModelCatalogService()) {
    const modelCatalogSvc = new AgentModelCatalogService();
    setAgentModelCatalogService(modelCatalogSvc);
    // Warm the cache in the background so the first renderer request hits
    // populated data. Errors are already silenced inside getCatalog().
    void modelCatalogSvc.getCatalog().catch(() => {
      /* swallow — surfaced via console.warn inside the service */
    });
  }

  let lastCrashDetails: {
    crashType: string;
    code: number | null;
    signal: string | null;
    timestamp: number;
  } | null = null;

  ptyClient.on("host-crash-details", (details) => {
    console.error(`[MAIN] Pty Host crashed:`, details);
    lastCrashDetails = {
      crashType: details.crashType,
      code: details.code,
      signal: details.signal,
      timestamp: details.timestamp,
    };
    pushHostEventToRemoteViews("terminal:backend-recovering", {
      crashType: details.crashType,
      code: details.code,
      signal: details.signal,
      timestamp: details.timestamp,
    });
    if (windowRegistry) {
      for (const wCtx of windowRegistry.all()) {
        const w = wCtx.browserWindow;
        if (!w.isDestroyed()) {
          const wc = getAppWebContents(w);
          if (!wc.isDestroyed()) {
            try {
              wc.send(CHANNELS.EVENTS_PUSH, {
                name: "terminal:backend-recovering",
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
    const payload = lastCrashDetails ?? {
      crashType: "UNKNOWN_CRASH",
      code,
      signal: null,
      timestamp: Date.now(),
    };
    lastCrashDetails = null;
    pushHostEventToRemoteViews("terminal:backend-crashed", payload);
    if (windowRegistry) {
      for (const wCtx of windowRegistry.all()) {
        const w = wCtx.browserWindow;
        if (!w.isDestroyed()) {
          const wc = getAppWebContents(w);
          if (!wc.isDestroyed()) {
            try {
              wc.send(CHANNELS.EVENTS_PUSH, {
                name: "terminal:backend-crashed",
                payload,
              });
            } catch {
              // Silently ignore send failures during window disposal.
            }
          }
        }
      }
    }
  });
  ptyClient.on("host-memory-warning", (payload) => {
    if (payload.isWarning) {
      logInfo("pty-host-memory-warning", {
        utilizationPercent: payload.utilizationPercent,
        heapMb: payload.heapMb,
        externalMb: payload.externalMb,
        workerHeapMb: payload.workerHeapMb,
        workerExternalMb: payload.workerExternalMb,
      });
    } else {
      logInfo("pty-host-memory-warning-cleared", {
        utilizationPercent: payload.utilizationPercent,
        heapMb: payload.heapMb,
        externalMb: payload.externalMb,
        workerHeapMb: payload.workerHeapMb,
        workerExternalMb: payload.workerExternalMb,
      });
    }
    // Broadcast to all windows so renderer can surface the warning
    if (windowRegistry) {
      for (const wCtx of windowRegistry.all()) {
        const w = wCtx.browserWindow;
        if (!w.isDestroyed()) {
          try {
            sendToRenderer(w, CHANNELS.EVENTS_PUSH, {
              name: "window:memory-warning",
              payload: {
                isWarning: payload.isWarning,
                utilizationPercent: payload.utilizationPercent,
                heapMb: payload.heapMb,
                externalMb: payload.externalMb,
              },
            });
          } catch {
            /* non-critical */
          }
        }
      }
    }
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
    // Scope "all": the host only throttles after the governor has paused
    // every PTY, and at critical utilization it skips its own pre-pause trim
    // to pause immediately — so this is the last buffer reclaim available,
    // and sparing the active agents holding the memory would leave nothing
    // to reclaim (#10948). Fire-and-forget: unlike tier 1 this path makes no
    // escalation decision, so the counts have no consumer here. `.catch()`
    // rather than try/catch — trimState is async, so a rejection would
    // escape the block.
    void ptyClient!.trimState(SCROLLBACK_BACKGROUND, "all").catch(() => {
      /* non-critical */
    });
  });
  // The memory pause reaches the UI once, app-wide, never per pane (#12375).
  // Sent on every change, the release included, to each window's active view;
  // a cached view pulls the snapshot when it's revealed.
  ptyClient.on("host-memory-pause-changed", (snapshot: HostMemoryPauseSnapshot) => {
    pushHostEventToRemoteViews("terminal:host-memory-pause", snapshot);
    if (!windowRegistry) return;
    for (const wCtx of windowRegistry.all()) {
      const w = wCtx.browserWindow;
      if (w.isDestroyed()) continue;
      try {
        sendToRenderer(w, CHANNELS.EVENTS_PUSH, {
          name: "terminal:host-memory-pause",
          payload: snapshot,
        });
      } catch {
        /* non-critical */
      }
    }
  });
  ptyClient.setPortRefreshCallback((windowId) => {
    // Called with no windowId on a full host restart (refresh every window)
    // and with one when the PTY fabric restarts or reroutes a single
    // window's shard — refreshing only that window keeps a shard-local
    // recovery from re-handshaking every healthy window's terminal stream.
    console.log(
      windowId === undefined
        ? "[MAIN] Pty Host restarted, refreshing ports..."
        : `[MAIN] Pty Host shard changed for window ${windowId}, refreshing its port...`
    );
    // Refresh ports for the targeted windows — target the active view
    if (windowRegistry) {
      for (const wCtx of windowRegistry.all()) {
        if (windowId !== undefined && wCtx.windowId !== windowId) continue;
        // One window's failure must not abort the refresh for the rest —
        // the caller (respawnPendingForShard) still has respawn replay,
        // data-mirror re-enable, and global config replay to run.
        try {
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
        } catch (error) {
          console.error(`[MAIN] Failed to refresh PTY port for window ${wCtx.windowId}:`, error);
        }
      }
    }
  });
  return ptyClient;
}

/**
 * Register the broadcast listener that turns a watchdog cap-hit into a
 * `watchdog:disabled` push to every renderer. The watchdog client is Electron-
 * agnostic and has no reference to the window registry; this helper is the
 * single seam that bridges them. Called both at first-window startup (the
 * watchdog start block in windowServices.ts, before ptyClient.start())
 * and from the `watchdog:restart` IPC handler after a manual restart, so a
 * second cap-hit cycle reaches the renderer instead of dying silently.
 */
export function wireWatchdogDisabledBroadcast(
  client: MainProcessWatchdogClient,
  windowRegistry: WindowRegistry | undefined
): void {
  client.onDisabled((payload) => {
    pushHostEventToRemoteViews("watchdog:disabled", payload);
    if (!windowRegistry) return;
    for (const wCtx of windowRegistry.all()) {
      const w = wCtx.browserWindow;
      if (w.isDestroyed()) continue;
      const wc = getAppWebContents(w);
      if (wc.isDestroyed()) continue;
      try {
        wc.send(CHANNELS.EVENTS_PUSH, {
          name: "watchdog:disabled",
          payload,
        });
      } catch {
        // Silently ignore send failures during window disposal.
      }
    }
  });
}
