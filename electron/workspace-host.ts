// Silence EPIPE on stdout/stderr — the main process may close the pipe
// at any time during shutdown or host restart.
for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream.on === "function") {
    stream.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") return;
      throw err;
    });
  }
}

import { MessagePort } from "node:worker_threads";
import { initializeLogger } from "./utils/logger.js";
import { copyTreeService } from "./services/CopyTreeService.js";
import { fileTreeService } from "./services/FileTreeService.js";
import { projectPulseService } from "./services/ProjectPulseService.js";
import type { CopyTreeProgress } from "../shared/types/ipc.js";
import type { WorkspaceHostRequest, WorkspaceHostEvent } from "../shared/types/workspace-host.js";
import { WorkspaceService } from "./workspace-host/WorkspaceService.js";
import { ensureSerializable } from "../shared/utils/serialization.js";

// Validate we're running in UtilityProcess context
if (!process.parentPort) {
  throw new Error("[WorkspaceHost] Must run in UtilityProcess context");
}

if (process.env.CANOPY_USER_DATA) {
  initializeLogger(process.env.CANOPY_USER_DATA);
}

const port = process.parentPort as unknown as MessagePort;

// Direct MessagePort connections to renderer views (bypasses main-process relay)
const rendererPorts: MessagePort[] = [];

// New worktree-specific ports with request/response correlation (Phase 1)
const worktreePorts: MessagePort[] = [];

// Event types delivered directly to renderers via MessagePort
const DIRECT_RENDERER_EVENTS = new Set([
  "worktree-update",
  "worktree-removed",
  "pr-detected",
  "pr-cleared",
  "issue-detected",
  "issue-not-found",
]);

function sendToRendererPorts(event: WorkspaceHostEvent): void {
  for (let i = rendererPorts.length - 1; i >= 0; i--) {
    try {
      rendererPorts[i].postMessage(event);
    } catch {
      // Port closed (view evicted or destroyed)
      rendererPorts.splice(i, 1);
    }
  }
}

function sendToWorktreePorts(event: WorkspaceHostEvent): void {
  for (let i = worktreePorts.length - 1; i >= 0; i--) {
    try {
      worktreePorts[i].postMessage({ type: "event", event });
    } catch {
      worktreePorts.splice(i, 1);
    }
  }
}

async function handleWorktreePortRequest(
  rPort: MessagePort,
  id: string,
  action: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    let result: unknown;

    switch (action) {
      case "get-all-states": {
        const states = workspaceService.getSnapshotsSync();
        result = { states };
        break;
      }

      case "set-active": {
        const requestId = `port-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        workspaceService.setActiveWorktree(requestId, payload.worktreeId as string);
        result = { ok: true };
        break;
      }

      case "refresh": {
        const requestId = `port-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await workspaceService.refresh(requestId, payload.worktreeId as string | undefined);
        result = { ok: true };
        break;
      }

      case "create-worktree": {
        const requestId = `port-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await workspaceService.createWorktree(
          requestId,
          payload.rootPath as string,
          payload.options as any
        );
        result = { ok: true };
        break;
      }

      case "delete-worktree": {
        const requestId = `port-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await workspaceService.deleteWorktree(
          requestId,
          payload.worktreeId as string,
          payload.force as boolean | undefined,
          payload.deleteBranch as boolean | undefined
        );
        result = { ok: true };
        break;
      }

      case "list-branches": {
        const requestId = `port-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await workspaceService.listBranches(requestId, payload.rootPath as string);
        result = { ok: true };
        break;
      }

      case "get-recent-branches": {
        const requestId = `port-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await workspaceService.getRecentBranches(requestId, payload.rootPath as string);
        result = { ok: true };
        break;
      }

      case "refresh-prs": {
        const { pullRequestService } = await import("./services/PullRequestService.js");
        await pullRequestService.refresh();
        result = { ok: true };
        break;
      }

      default:
        throw new Error(`Unknown worktree port action: ${action}`);
    }

    rPort.postMessage({ id, result });
  } catch (error) {
    rPort.postMessage({ id, error: (error as Error).message });
  }
}

function attachWorktreePort(newPort: MessagePort): void {
  newPort.start();
  worktreePorts.push(newPort);

  newPort.on("message", (rawMsg: any) => {
    const msg = rawMsg?.data ? rawMsg.data : rawMsg;
    if (!msg?.id || !msg?.action) return;

    handleWorktreePortRequest(newPort, msg.id, msg.action, msg.payload || {}).catch((err) => {
      try {
        newPort.postMessage({ id: msg.id, error: (err as Error).message });
      } catch {
        // Port closed
      }
    });
  });

  newPort.on("close", () => {
    const idx = worktreePorts.indexOf(newPort);
    if (idx >= 0) worktreePorts.splice(idx, 1);
  });

  console.log(`[WorkspaceHost] Worktree port attached (${worktreePorts.length} active)`);
}

// Global error handlers to prevent silent crashes
process.on("uncaughtException", (err) => {
  console.error("[WorkspaceHost] Uncaught Exception:", err);
  sendEvent({ type: "error", error: err.message });
});

process.on("unhandledRejection", (reason) => {
  console.error("[WorkspaceHost] Unhandled Rejection:", reason);
  sendEvent({
    type: "error",
    error: String(reason instanceof Error ? reason.message : reason),
  });
});

// Helper to send events to Main process (and directly to renderers for spontaneous events)
function sendEvent(event: WorkspaceHostEvent): void {
  try {
    port.postMessage(event);
  } catch (error) {
    console.error(
      `[WorkspaceHost] Failed to send event type "${(event as any).type}":`,
      error instanceof Error ? error.message : String(error)
    );

    try {
      const sanitized = ensureSerializable(event);
      console.warn(`[WorkspaceHost] Sending sanitized event (non-serializable fields removed)`);
      port.postMessage(sanitized);
    } catch (sanitizeError) {
      console.error(
        `[WorkspaceHost] Failed to sanitize event, sending error event instead:`,
        sanitizeError instanceof Error ? sanitizeError.message : String(sanitizeError)
      );
      port.postMessage({
        type: "error",
        error: `Serialization failed for event type "${(event as any).type}"`,
      });
    }
  }

  // Direct delivery to renderer(s) via MessagePort (bypasses main-process relay)
  if (DIRECT_RENDERER_EVENTS.has((event as { type: string }).type)) {
    if (rendererPorts.length > 0) {
      sendToRendererPorts(event);
    }
    if (worktreePorts.length > 0) {
      sendToWorktreePorts(event);
    }
  }
}

// Process-level shutdown controller — aborted on dispose/SIGTERM to kill in-flight git operations
const shutdownController = new AbortController();

// Create singleton instance
const workspaceService = new WorkspaceService(sendEvent);

// Handle requests from Main
port.on("message", async (rawMsg: any) => {
  const msg = rawMsg?.data ? rawMsg.data : rawMsg;

  // Handle MessagePort transfers (direct renderer connection)
  const transferredPorts = rawMsg?.ports || [];
  if (msg?.type === "attach-renderer-port" && transferredPorts.length > 0) {
    const newPort = transferredPorts[0] as MessagePort;
    newPort.start();
    rendererPorts.push(newPort);
    newPort.on("close", () => {
      const idx = rendererPorts.indexOf(newPort);
      if (idx >= 0) rendererPorts.splice(idx, 1);
    });
    console.log(`[WorkspaceHost] Renderer port attached (${rendererPorts.length} active)`);
    return;
  }

  // New worktree-specific port with request/response correlation (Phase 1)
  if (msg?.type === "attach-worktree-port" && transferredPorts.length > 0) {
    attachWorktreePort(transferredPorts[0] as MessagePort);
    return;
  }

  try {
    const request = msg as WorkspaceHostRequest;

    switch (request.type) {
      case "load-project":
        await workspaceService.loadProject(request.requestId, request.rootPath);
        break;

      case "sync":
        try {
          await workspaceService.syncMonitors(
            request.worktrees,
            request.activeWorktreeId,
            request.mainBranch,
            request.monitorConfig
          );
          sendEvent({ type: "sync-result", requestId: request.requestId, success: true });
        } catch (error) {
          sendEvent({
            type: "sync-result",
            requestId: request.requestId,
            success: false,
            error: (error as Error).message,
          });
        }
        break;

      case "project-switch":
        await workspaceService.onProjectSwitch(request.requestId);
        break;

      case "get-all-states":
        workspaceService.getAllStates(request.requestId);
        break;

      case "get-monitor":
        workspaceService.getMonitor(request.requestId, request.worktreeId);
        break;

      case "set-active":
        workspaceService.setActiveWorktree(request.requestId, request.worktreeId);
        break;

      case "refresh":
        await workspaceService.refresh(request.requestId, request.worktreeId);
        break;

      case "refresh-prs":
        {
          const { pullRequestService } = await import("./services/PullRequestService.js");
          try {
            await pullRequestService.refresh();
            sendEvent({ type: "refresh-prs-result", requestId: request.requestId, success: true });
          } catch (error) {
            sendEvent({
              type: "refresh-prs-result",
              requestId: request.requestId,
              success: false,
              error: (error as Error).message,
            });
          }
        }
        break;

      case "get-pr-status":
        workspaceService.getPRStatus(request.requestId);
        break;

      case "reset-pr-state":
        workspaceService.resetPRState(request.requestId);
        break;

      case "create-worktree":
        await workspaceService.createWorktree(request.requestId, request.rootPath, request.options);
        break;

      case "delete-worktree":
        await workspaceService.deleteWorktree(
          request.requestId,
          request.worktreeId,
          request.force,
          request.deleteBranch
        );
        break;

      case "list-branches":
        await workspaceService.listBranches(request.requestId, request.rootPath);
        break;

      case "get-recent-branches":
        await workspaceService.getRecentBranches(request.requestId, request.rootPath);
        break;

      case "fetch-pr-branch":
        await workspaceService.fetchPRBranch(
          request.requestId,
          request.rootPath,
          request.prNumber,
          request.headRefName
        );
        break;

      case "get-file-diff":
        await workspaceService.getFileDiff(
          request.requestId,
          request.cwd,
          request.filePath,
          request.status
        );
        break;

      case "set-polling-enabled":
        workspaceService.setPollingEnabled(request.enabled);
        break;

      case "background":
        workspaceService.pause();
        break;

      case "foreground":
        workspaceService.resume();
        break;

      case "health-check":
        sendEvent({ type: "pong" });
        break;

      case "dispose":
        shutdownController.abort();
        workspaceService.dispose();
        break;

      case "copytree:generate": {
        const { requestId, operationId, rootPath, options } = request;
        console.log(`[WorkspaceHost] CopyTree generate started: ${operationId}`);

        const onProgress = (progress: CopyTreeProgress) => {
          sendEvent({
            type: "copytree:progress",
            operationId,
            progress,
          });
        };

        try {
          const result = await copyTreeService.generate(
            rootPath,
            options || {},
            onProgress,
            operationId
          );
          sendEvent({
            type: "copytree:complete",
            requestId,
            operationId,
            result,
          });
        } catch (error) {
          sendEvent({
            type: "copytree:error",
            requestId,
            operationId,
            error: (error as Error).message,
          });
        }
        break;
      }

      case "copytree:cancel":
        copyTreeService.cancel(request.operationId);
        break;

      case "copytree:test-config": {
        const { requestId, rootPath, options } = request;
        console.log(`[WorkspaceHost] CopyTree test-config started`);

        try {
          const result = await copyTreeService.testConfig(rootPath, options || {});
          sendEvent({
            type: "copytree:test-config-result",
            requestId,
            result,
          });
        } catch (error) {
          sendEvent({
            type: "copytree:test-config-result",
            requestId,
            result: {
              includedFiles: 0,
              includedSize: 0,
              excluded: { byTruncation: 0, bySize: 0, byPattern: 0 },
              error: (error as Error).message,
            },
          });
        }
        break;
      }

      case "update-monitor-config":
        try {
          workspaceService.updateMonitorConfig(request.config);
          sendEvent({
            type: "update-monitor-config-result",
            requestId: request.requestId,
            success: true,
          });
        } catch (error) {
          sendEvent({
            type: "update-monitor-config-result",
            requestId: request.requestId,
            success: false,
            error: (error as Error).message,
          });
        }
        break;

      case "update-github-token":
        workspaceService.updateGitHubToken(request.token);
        break;

      case "get-file-tree": {
        const { requestId, worktreePath, dirPath } = request;
        try {
          const nodes = await fileTreeService.getFileTree(worktreePath, dirPath);
          sendEvent({
            type: "file-tree-result",
            requestId,
            nodes,
          });
        } catch (error) {
          sendEvent({
            type: "file-tree-result",
            requestId,
            nodes: [],
            error: (error as Error).message,
          });
        }
        break;
      }

      case "git:get-project-pulse": {
        const {
          requestId,
          worktreePath,
          worktreeId,
          mainBranch,
          rangeDays,
          includeDelta,
          includeRecentCommits,
          forceRefresh,
        } = request;
        try {
          if (typeof worktreePath !== "string" || !worktreePath.trim()) {
            throw new Error("Invalid worktreePath");
          }
          if (typeof worktreeId !== "string" || !worktreeId.trim()) {
            throw new Error("Invalid worktreeId");
          }
          if (typeof mainBranch !== "string" || !mainBranch.trim()) {
            throw new Error("Invalid mainBranch");
          }
          if (![60, 120, 180].includes(rangeDays)) {
            throw new Error("Invalid rangeDays");
          }
          if (includeDelta !== undefined && typeof includeDelta !== "boolean") {
            throw new Error("Invalid includeDelta");
          }
          if (includeRecentCommits !== undefined && typeof includeRecentCommits !== "boolean") {
            throw new Error("Invalid includeRecentCommits");
          }
          if (forceRefresh !== undefined && typeof forceRefresh !== "boolean") {
            throw new Error("Invalid forceRefresh");
          }

          const pulse = await projectPulseService.getPulse({
            worktreePath,
            worktreeId,
            mainBranch,
            rangeDays,
            includeDelta,
            includeRecentCommits,
            forceRefresh,
          });
          sendEvent({
            type: "git:project-pulse",
            requestId,
            data: pulse,
          });
        } catch (error) {
          sendEvent({
            type: "git:project-pulse-error",
            requestId,
            error: (error as Error).message,
          });
        }
        break;
      }

      default:
        console.warn("[WorkspaceHost] Unknown message type:", (request as any).type);
    }
  } catch (error) {
    console.error("[WorkspaceHost] Error handling message:", error);
    sendEvent({ type: "error", error: (error as Error).message });
  }
});

// Graceful shutdown on SIGTERM (macOS/Linux; Windows uses TerminateProcess so this won't fire)
process.on("SIGTERM", () => {
  console.log("[WorkspaceHost] SIGTERM received, shutting down");
  shutdownController.abort();
  workspaceService.dispose();
});

// Signal ready
console.log("[WorkspaceHost] Initialized and ready");
sendEvent({ type: "ready" });
