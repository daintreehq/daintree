// Dead-fd errnos that must not propagate on GUI launch (AppImage/Wayland, no
// terminal). EPIPE is a closed pipe; EIO is a disconnected pty (the primary
// errno for AppImage desktop launches where fd 2 points to an orphaned pty
// slave); EBADF is a closed fd; ECONNRESET is a socket-backed stdio reset.
// ENOSPC is intentionally NOT swallowed — it's a real error condition.
const STDIO_DEAD_CODES = new Set(["EPIPE", "EIO", "EBADF", "ECONNRESET"]);
for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream.on === "function") {
    stream.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code && STDIO_DEAD_CODES.has(err.code)) return;
      throw err;
    });
  }
}

import { MessagePort } from "node:worker_threads";
import { initializeLogger, setLogLevelOverrides } from "./utils/logger.js";
import { copyTreeService } from "./services/CopyTreeService.js";
import { fileTreeService } from "./services/FileTreeService.js";
import { projectPulseService } from "./services/ProjectPulseService.js";
import type { CopyTreeProgress } from "../shared/types/ipc.js";
import type { WorkspaceHostRequest, WorkspaceHostEvent } from "../shared/types/workspace-host.js";
import type { WorktreePortRequest } from "../shared/types/worktree-port.js";
import { WorkspaceService } from "./workspace-host/WorkspaceService.js";
import { gitHubRateLimitService } from "./services/github/index.js";
import { ensureSerializable } from "../shared/utils/serialization.js";
import { formatErrorMessage } from "../shared/utils/errorMessage.js";

// Validate we're running in UtilityProcess context
if (!process.parentPort) {
  throw new Error("[WorkspaceHost] Must run in UtilityProcess context");
}

if (process.env.DAINTREE_USER_DATA) {
  initializeLogger(process.env.DAINTREE_USER_DATA);
}

const port = process.parentPort as unknown as MessagePort;

// Worktree-specific ports with request/response correlation (Phase 1)
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
  msg: WorktreePortRequest
): Promise<void> {
  const { id } = msg;
  try {
    let result: unknown;

    switch (msg.action) {
      case "get-all-states": {
        const states = workspaceService.getSnapshotsSync();
        result = { states };
        break;
      }

      case "set-active": {
        const requestId = `port-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        workspaceService.setActiveWorktree(requestId, msg.payload.worktreeId);
        result = { ok: true };
        break;
      }

      case "refresh": {
        const requestId = `port-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await workspaceService.refresh(requestId, msg.payload.worktreeId);
        result = { ok: true };
        break;
      }

      case "create-worktree": {
        const requestId = `port-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await workspaceService.createWorktree(requestId, msg.payload.rootPath, msg.payload.options);
        result = { ok: true };
        break;
      }

      case "delete-worktree": {
        const requestId = `port-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await workspaceService.deleteWorktree(
          requestId,
          msg.payload.worktreeId,
          msg.payload.force,
          msg.payload.deleteBranch
        );
        result = { ok: true };
        break;
      }

      case "list-branches": {
        const requestId = `port-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await workspaceService.listBranches(requestId, msg.payload.rootPath);
        result = { ok: true };
        break;
      }

      case "get-recent-branches": {
        const requestId = `port-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await workspaceService.getRecentBranches(requestId, msg.payload.rootPath);
        result = { ok: true };
        break;
      }

      case "refresh-prs": {
        const { pullRequestService } = await import("./services/PullRequestService.js");
        await pullRequestService.refresh();
        result = { ok: true };
        break;
      }

      case "resource-action": {
        const requestId = `port-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const actionResult = await workspaceService.runResourceAction(
          requestId,
          msg.payload.worktreeId,
          msg.payload.action
        );
        if (!actionResult.success) {
          rPort.postMessage({ id, error: actionResult.error ?? "Resource action failed" });
          return;
        }
        result = { ok: true };
        break;
      }

      case "switch-worktree-environment": {
        const requestId = `port-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await workspaceService.switchWorktreeEnvironment(
          requestId,
          msg.payload.worktreeId,
          msg.payload.envKey
        );
        result = { ok: true };
        break;
      }

      case "has-resource-config": {
        const hasConfig = await workspaceService.hasResourceConfig(msg.payload.rootPath);
        result = { hasConfig };
        break;
      }

      default: {
        const _exhaustive: never = msg;
        throw new Error(
          `Unknown worktree port action: ${(_exhaustive as { action: string }).action}`
        );
      }
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
    const raw = rawMsg?.data ? rawMsg.data : rawMsg;
    if (!raw?.id || !raw?.action) return;

    // Renderer is trusted; runtime validation happens at the input boundary in
    // `WorktreePortClient.request<K>` via the typed protocol map. Cast here so
    // the dispatcher body can stay free of per-field `as` casts.
    const msg = {
      id: raw.id,
      action: raw.action,
      payload: raw.payload ?? {},
    } as WorktreePortRequest;

    handleWorktreePortRequest(newPort, msg).catch((err) => {
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
    error: formatErrorMessage(reason, "Unhandled rejection in workspace host"),
  });
});

// Helper to send events to Main process (and directly to renderers for spontaneous events)
function sendEvent(event: WorkspaceHostEvent): void {
  try {
    port.postMessage(event);
  } catch (error) {
    console.error(
      `[WorkspaceHost] Failed to send event type "${(event as any).type}":`,
      formatErrorMessage(error, "Failed to send workspace event")
    );

    try {
      const sanitized = ensureSerializable(event);
      console.warn(`[WorkspaceHost] Sending sanitized event (non-serializable fields removed)`);
      port.postMessage(sanitized);
    } catch (sanitizeError) {
      console.error(
        `[WorkspaceHost] Failed to sanitize event, sending error event instead:`,
        formatErrorMessage(sanitizeError, "Failed to sanitize workspace event")
      );
      port.postMessage({
        type: "error",
        error: `Serialization failed for event type "${(event as any).type}"`,
      });
    }
  }

  // Direct delivery to renderer(s) via MessagePort (bypasses main-process relay)
  if (DIRECT_RENDERER_EVENTS.has((event as { type: string }).type)) {
    if (worktreePorts.length > 0) {
      sendToWorktreePorts(event);
    }
  }
}

// Process-level shutdown controller — aborted on dispose/SIGTERM to kill in-flight git operations
const shutdownController = new AbortController();

// Create singleton instance
const workspaceService = new WorkspaceService(sendEvent);

// Forward GitHub rate-limit state changes observed by utility-process HTTP
// calls (e.g. PullRequestService polling) up to the main process so they
// reach the toolbar countdown and block main-process GitHub calls too.
// `broadcastToRenderer` is BrowserWindow-backed and therefore main-only;
// this relay is how utility-side limits ever become visible elsewhere.
// Register synchronously before `ready` is sent — otherwise the first
// event emitted during startup racing polling would be silently dropped.
gitHubRateLimitService.onStateChange((state) => {
  sendEvent({ type: "github-rate-limit-changed", state });
});

// Handle requests from Main
port.on("message", async (rawMsg: any) => {
  const msg = rawMsg?.data ? rawMsg.data : rawMsg;

  // Handle MessagePort transfers (worktree-specific port with request/response correlation)
  const transferredPorts = rawMsg?.ports || [];
  // Legacy renderer ports are no longer used — worktreePorts replaced them.
  // Accept and close the port silently to avoid "Unknown message type" warnings.
  if (msg?.type === "attach-renderer-port" && transferredPorts.length > 0) {
    transferredPorts[0].close();
    return;
  }

  if (msg?.type === "attach-worktree-port" && transferredPorts.length > 0) {
    attachWorktreePort(transferredPorts[0] as MessagePort);
    return;
  }

  try {
    const request = msg as WorkspaceHostRequest;

    switch (request.type) {
      case "load-project":
        await workspaceService.loadProject(
          request.requestId,
          request.rootPath,
          request.globalEnvVars,
          request.wslGitByWorktree
        );
        break;

      case "set-wsl-opt-in":
        workspaceService.setWslOptIn(request.worktreeId, request.enabled, request.dismissed);
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

      case "refresh-on-wake":
        await workspaceService.refreshOnWake(request.requestId);
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

      case "set-log-level-overrides": {
        const overrides = (request.overrides ?? {}) as Record<string, unknown>;
        const sanitized: Record<string, string> = {};
        for (const [key, value] of Object.entries(overrides)) {
          if (typeof key === "string" && typeof value === "string") {
            sanitized[key] = value;
          }
        }
        setLogLevelOverrides(sanitized);
        break;
      }

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
