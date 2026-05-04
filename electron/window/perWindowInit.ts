import { session, type BrowserWindow } from "electron";
import type { HandlerDependencies } from "../ipc/types.js";
import { sendToRenderer } from "../ipc/handlers.js";
import { getAppWebContents } from "./webContentsRegistry.js";
import { distributePortsToView } from "./portDistribution.js";
import { PtyClient } from "../services/PtyClient.js";
import { getMainProcessWatchdogClient } from "../services/MainProcessWatchdogClient.js";
import { CliAvailabilityService } from "../services/CliAvailabilityService.js";
import { AgentVersionService } from "../services/AgentVersionService.js";
import { AgentUpdateHandler } from "../services/AgentUpdateHandler.js";
import { PortalManager } from "../services/PortalManager.js";
import { EventBuffer } from "../services/EventBuffer.js";
import { CHANNELS } from "../ipc/channels.js";
import { createApplicationMenu } from "../menu.js";
import { ProjectSwitchService } from "../services/ProjectSwitchService.js";
import { notificationService } from "../services/NotificationService.js";
import { logInfo } from "../utils/logger.js";
import { SCROLLBACK_BACKGROUND } from "../../shared/config/scrollback.js";
import { isDemoMode } from "../setup/environment.js";
import type { WindowContext, WindowRegistry } from "./WindowRegistry.js";
import { registerDeferredTask, finalizeDeferredRegistration } from "./deferredInitQueue.js";
import { toDisposable } from "../utils/lifecycle.js";
import {
  getCliAvailabilityServiceRef,
  setCliAvailabilityServiceRef,
  getPtyClient,
  setPtyClientRef,
  getMainProcessWatchdogClientRef,
  setMainProcessWatchdogClientRef,
  getAgentVersionService,
  setAgentVersionService,
  getAgentUpdateHandler,
  setAgentUpdateHandler,
  getWorkspaceClientRef,
} from "./serviceRefs.js";

/**
 * Run the per-window initialization steps that happen on every
 * `setupWindowServices` call: menu creation, the per-window CLI deferred task,
 * deferred-queue arming, NotificationService wire-up, first-window-only
 * critical-services boot (PtyClient + watchdog), and per-window service
 * objects (EventBuffer, PortalManager, ProjectSwitchService, ctx.cleanup).
 *
 * Returns a partially-populated `HandlerDependencies` for the caller to extend
 * with `worktreeService`, `worktreePortBroker`, and `projectViewManager` once
 * the workspace client and ProjectViewManager are wired in the orchestrator.
 */
export function initPerWindowServices(
  win: BrowserWindow,
  ctx: WindowContext,
  windowRegistry: WindowRegistry | undefined
): HandlerDependencies {
  // Menu & Notifications (per-window: menu references this window)
  console.log("[MAIN] Creating application menu (initial, no agent availability yet)...");
  let cliAvailabilityService = getCliAvailabilityServiceRef();
  if (!cliAvailabilityService) {
    cliAvailabilityService = new CliAvailabilityService();
    setCliAvailabilityServiceRef(cliAvailabilityService);
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
  let ptyClient = getPtyClient();
  if (!ptyClient) {
    console.log("[MAIN] Starting critical services...");

    // Start the external main-process watchdog before PtyClient so a deadlock
    // during PTY host fork (worst case: a synchronous spawn that hangs) is
    // still recoverable. The watchdog is fail-open: if its own fork throws,
    // PtyClient still starts normally.
    if (!getMainProcessWatchdogClientRef()) {
      try {
        // Use the singleton accessor so `disposeMainProcessWatchdog()` in
        // shutdown.ts reaches the running instance instead of a no-op.
        setMainProcessWatchdogClientRef(getMainProcessWatchdogClient());
      } catch (err) {
        console.error("[MAIN] Failed to start main-process watchdog:", err);
        setMainProcessWatchdogClientRef(null);
      }
    }

    ptyClient = new PtyClient({
      maxRestartAttempts: 3,
      healthCheckIntervalMs: 30000,
      showCrashDialog: false,
    });
    setPtyClientRef(ptyClient);

    const versionSvc = new AgentVersionService(cliAvailabilityService);
    setAgentVersionService(versionSvc);
    setAgentUpdateHandler(new AgentUpdateHandler(ptyClient, versionSvc, cliAvailabilityService));

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
    agentVersionService: getAgentVersionService() ?? undefined,
    agentUpdateHandler: getAgentUpdateHandler() ?? undefined,
    isDemoMode,
    windowRegistry,
  } as HandlerDependencies);

  // Per-window cleanup: ports, portalManager, eventBuffer
  ctx.cleanup.add(
    toDisposable(() => {
      // Notify PTY host to disconnect this window's port before closing it
      const pty = getPtyClient();
      if (pty) {
        pty.disconnectMessagePort(ctx.windowId);
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
      const ws = getWorkspaceClientRef();
      if (ws) {
        ws.unregisterWindow(win.id);
      }
    })
  );

  const handlerDeps: HandlerDependencies = {
    mainWindow: win,
    ptyClient: ptyClient ?? undefined,
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
