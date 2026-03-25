import { app, dialog } from "electron";
import type { PtyClient } from "../services/PtyClient.js";
import type { WorkspaceClient } from "../services/WorkspaceClient.js";
import { projectStore } from "../services/ProjectStore.js";
import { getActiveAgentCount, showQuitWarning } from "../utils/quitWarning.js";
import {
  disposeAgentAvailabilityStore,
  getAgentAvailabilityStore,
} from "../services/AgentAvailabilityStore.js";
import { disposeAgentRouter } from "../services/AgentRouter.js";
import { disposeWorkflowEngine } from "../services/WorkflowEngine.js";
import { disposeTaskOrchestrator } from "../services/TaskOrchestrator.js";
import { disposePtyClient } from "../services/PtyClient.js";
import { disposeWorkspaceClient } from "../services/WorkspaceClient.js";
import { mcpServerService } from "../services/McpServerService.js";
import { getCrashRecoveryService } from "../services/CrashRecoveryService.js";
import { isSmokeTest } from "../setup/environment.js";
import { isSignalShutdown } from "./signalShutdownState.js";

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
  getMainWindow: () => Electron.BrowserWindow | null;
  windowRegistry?: import("../window/WindowRegistry.js").WindowRegistry;
}

let isQuitting = false;
let isConfirmingQuit = false;

export function registerShutdownHandler(deps: ShutdownDeps): void {
  app.on("before-quit", async (event) => {
    if (isQuitting || isSmokeTest) {
      return;
    }

    const canShowDialog = !isSignalShutdown() && deps.getMainWindow() != null;

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
          confirmed = await showQuitWarning(activeCount, dialog.showMessageBox);
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

    console.log("[MAIN] Starting graceful shutdown...");
    const { drainRateLimitQueues } = await import("../ipc/utils.js");
    drainRateLimitQueues();
    getCrashRecoveryService().cleanupOnExit();

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

    gracefulShutdownPromise
      .then(() =>
        Promise.all([
          workspaceClient ? workspaceClient.dispose() : Promise.resolve(),
          mcpServerService.stop(),
          new Promise<void>((resolve) => {
            disposeTaskOrchestrator();
            disposeAgentRouter();
            disposeAgentAvailabilityStore();
            disposeWorkflowEngine();

            if (ptyClient) {
              ptyClient.dispose();
              deps.setPtyClient(null);
            }
            disposePtyClient();
            disposeWorkspaceClient();
            resolve();
          }),
        ])
      )
      .then(() => {
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
        console.log("[MAIN] Graceful shutdown complete");
        app.exit(0);
      })
      .catch((error) => {
        console.error("[MAIN] Error during cleanup:", error);
        app.exit(1);
      });
  });
}
