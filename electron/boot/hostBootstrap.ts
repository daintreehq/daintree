// The windowless Host runtime: every process-wide service a window's setup
// would bring up, started with no BrowserWindow. Shares each service with the
// windowed boot through the same once-only entry points, so whichever path
// runs first initialises it and the other reuses it — never a second
// pty-host, never two backends on one userData. A window created afterwards
// attaches to the running services as any later window does.
import type { HandlerDependencies } from "../ipc/types.js";
import type { WindowRegistry } from "../window/WindowRegistry.js";
import {
  ensureGlobalServicesInitialized,
  startMcpServerOnce,
  startPluginHostOnce,
} from "../window/globalServicesInit.js";
import { ensureCriticalServices } from "../window/perWindowInit.js";
import {
  ensureErrorHandlersRegistered,
  ensureIpcHandlersRegistered,
} from "../window/windowServices.js";
import {
  finalizeDeferredRegistration,
  signalFirstInteractive,
} from "../window/deferredInitQueue.js";
import {
  getAgentUpdateHandler,
  getAgentVersionService,
  getCliAvailabilityServiceRef,
  getPtyClient,
  getWorktreePortBrokerRef,
} from "../window/serviceRefs.js";
import {
  ensurePtyHostStarted,
  ensureWorkspaceClient,
  markHostRuntimeActive,
} from "./hostServices.js";
import { createHostRuntime, type HostRuntime, type HostRuntimeResult } from "./hostRuntime.js";
import { getServiceConnectivityRegistry } from "../services/connectivity/index.js";
import { initializeAgentAvailabilityStore } from "../services/AgentAvailabilityStore.js";
import { initializePowerSaveBlockerService } from "../services/PowerSaveBlockerService.js";
import { projectStore } from "../services/ProjectStore.js";
import { scratchStore } from "../services/ScratchStore.js";
import { isDemoMode } from "../setup/environment.js";

let runtime: HostRuntime | null = null;

function createDefaultHostRuntime(windowRegistry: WindowRegistry): HostRuntime {
  let handlerDeps: HandlerDependencies | null = null;

  return createHostRuntime({
    initGlobalServices: () => {
      // Claimed before the first await: a window opened and closed during the
      // rest of startup must not reset the deferred queue this runtime drains.
      markHostRuntimeActive();
      return ensureGlobalServicesInitialized(windowRegistry);
    },

    prepareServices: () => {
      const ptyClient = ensureCriticalServices(windowRegistry);
      // No mainWindow: handlers that need one fall back to the registry's
      // primary window, which is empty until a window attaches and fills the
      // window-scoped fields in.
      handlerDeps = ensureIpcHandlersRegistered({
        ptyClient,
        cliAvailabilityService: getCliAvailabilityServiceRef() ?? undefined,
        agentVersionService: getAgentVersionService() ?? undefined,
        agentUpdateHandler: getAgentUpdateHandler() ?? undefined,
        isDemoMode,
        windowRegistry,
      });
    },

    startPtyHost: async () => {
      await ensurePtyHostStarted({ windowRegistry, deferInitialPoolWarm: false });
      try {
        await getPtyClient()?.waitForReady();
      } catch (error) {
        console.error("[HostRuntime] Pty Host failed to start:", error);
      }
    },

    startWorkspaceHostPool: async () => {
      const workspaceClient = await ensureWorkspaceClient({});
      if (handlerDeps) {
        handlerDeps.worktreeService ??= workspaceClient;
        handlerDeps.worktreePortBroker ??= getWorktreePortBrokerRef() ?? undefined;
      }
      ensureErrorHandlersRegistered();
      try {
        await projectStore.initialize();
      } catch (error) {
        console.error("[HostRuntime] Project store failed to initialize:", error);
      }
      scratchStore.initialize().catch((error) => {
        console.warn("[HostRuntime] Scratch store init failed:", error);
      });
    },

    startMcp: async () => {
      // Before MCP so the registry is subscribed to its first status change.
      getServiceConnectivityRegistry().start();
      await startMcpServerOnce(windowRegistry);
    },

    startPluginHost: () => startPluginHostOnce(),

    startPowerPolicy: () => {
      initializeAgentAvailabilityStore();
      initializePowerSaveBlockerService(getPtyClient() ?? undefined);
    },

    releaseDeferredTasks: () => {
      finalizeDeferredRegistration();
      signalFirstInteractive(null);
    },
  });
}

/**
 * Start the Host runtime with no window, in dependency order: PATH refresh and
 * the pty-host fork, the workspace-host pool, MCP, the plugin host, then power
 * policy. Idempotent — later calls resolve with the first run's result.
 */
export function startHostRuntime(opts: {
  windowRegistry: WindowRegistry;
}): Promise<HostRuntimeResult> {
  runtime ??= createDefaultHostRuntime(opts.windowRegistry);
  return runtime.start();
}

export function isHostRuntimeStarted(): boolean {
  return runtime?.isStarted() ?? false;
}
