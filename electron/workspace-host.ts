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

// Helper to send events to Main process
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
}

// Create singleton instance
const workspaceService = new WorkspaceService(sendEvent);

// Handle requests from Main
port.on("message", async (rawMsg: any) => {
  const msg = rawMsg?.data ? rawMsg.data : rawMsg;

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

      case "health-check":
        sendEvent({ type: "pong" });
        break;

      case "dispose":
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

// Handle process exit
process.on("exit", () => {
  workspaceService.dispose();
  console.log("[WorkspaceHost] Disposed");
});

// Signal ready
console.log("[WorkspaceHost] Initialized and ready");
sendEvent({ type: "ready" });
