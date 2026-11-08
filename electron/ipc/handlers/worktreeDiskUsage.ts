import { projectStore } from "../../services/ProjectStore.js";
import {
  disposeWorktreeDiskUsageService,
  getWorktreeDiskUsageService,
} from "../../services/WorktreeDiskUsageService.js";
import { onWebContentsDestroyed } from "../../window/webContentsDestroyed.js";
import { defineIpcNamespace, op } from "../define.js";
import type { HandlerDependencies, IpcContext } from "../types.js";
import type {
  WorktreeDiskUsageCancelRequest,
  WorktreeDiskUsageMeasureRequest,
  WorktreeDiskUsageResult,
} from "../../../shared/types/ipc/worktreeDiskUsage.js";
import { WORKTREE_DISK_USAGE_METHOD_CHANNELS } from "./worktreeDiskUsage.preload.js";

const UNKNOWN: WorktreeDiskUsageResult = { status: "unknown" };

function assertId(value: unknown, what: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error(`Invalid ${what}`);
  }
}

function readRequest(request: unknown): Record<string, unknown> {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Invalid payload");
  }
  return request as Record<string, unknown>;
}

/** Views whose measurements are stopped when they go away, by owner key. */
const watchedOwners = new Map<string, () => void>();

/**
 * A view that navigates, crashes, closes or (remotely) drops its endpoint never
 * runs the overview's cleanup, so its queued and running scans are stopped
 * here instead.
 */
function watchOwner(ctx: IpcContext, owner: string): void {
  if (watchedOwners.has(owner)) return;
  const stop = () => getWorktreeDiskUsageService().cancel(owner);
  const sender = ctx.event?.sender;
  if (!sender) {
    const closed = ctx.endpoint.onClose(() => {
      watchedOwners.delete(owner);
      stop();
    });
    watchedOwners.set(owner, () => closed.dispose());
    return;
  }
  const onNavigate = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
    if (details.isMainFrame && !details.isSameDocument) stop();
  };
  sender.on("did-start-navigation", onNavigate);
  sender.on("render-process-gone", stop);
  const unwatchDestroyed = onWebContentsDestroyed(sender, () => {
    watchedOwners.delete(owner);
    sender.removeListener("did-start-navigation", onNavigate);
    sender.removeListener("render-process-gone", stop);
    stop();
  });
  watchedOwners.set(owner, () => {
    sender.removeListener("did-start-navigation", onNavigate);
    sender.removeListener("render-process-gone", stop);
    unwatchDestroyed();
  });
}

/**
 * The worktree's root and every other worktree's root, from the requesting
 * view's own project as its workspace host lists it — never a path the
 * renderer supplied. Every other root is passed as an exclusion; only those
 * nested inside this one take effect, so a worktree inside another is counted
 * once, in itself.
 */
async function resolveTarget(
  ctx: IpcContext,
  worktreeId: string,
  deps: HandlerDependencies
): Promise<{ root: string; exclude: string[] } | null> {
  const projectId = ctx.projectId;
  if (projectId === null || !deps.worktreeService) return null;
  const project = projectStore.getProjectById(projectId);
  if (!project) return null;
  try {
    const states = await deps.worktreeService.getAllStatesForProjectAsync(project.path, projectId);
    const target = states.find((state) => state.id === worktreeId);
    if (!target?.path) return null;
    return {
      root: target.path,
      exclude: states.filter((state) => state.id !== worktreeId).map((state) => state.path),
    };
  } catch (error) {
    console.warn("[worktreeDiskUsage] Failed to list worktrees:", error);
    return null;
  }
}

export function buildWorktreeDiskUsageNamespace(deps: HandlerDependencies) {
  return defineIpcNamespace({
    name: "worktreeDiskUsage",
    ops: {
      /**
       * One worktree's size, answered when its scan finishes (queued behind
       * other views' scans). `sessionId` ties it to an overview opening: a new
       * session from the same view, or `cancel`, answers it unknown at once.
       */
      measure: op(
        WORKTREE_DISK_USAGE_METHOD_CHANNELS.measure,
        async (
          ctx: IpcContext,
          request: WorktreeDiskUsageMeasureRequest
        ): Promise<WorktreeDiskUsageResult> => {
          const { sessionId, worktreeId } = readRequest(request);
          assertId(sessionId, "sessionId");
          assertId(worktreeId, "worktreeId");
          const owner = String(ctx.webContentsId);
          const service = getWorktreeDiskUsageService();
          watchOwner(ctx, owner);
          // Before the first await, so a cancel sent right behind this request
          // finds the session it belongs to.
          const signal = service.begin(owner, sessionId);
          const target = await resolveTarget(ctx, worktreeId, deps);
          if (!target || signal.aborted) return UNKNOWN;
          return service.measure(signal, target.root, target.exclude);
        },
        { withContext: true }
      ),
      cancel: op(
        WORKTREE_DISK_USAGE_METHOD_CHANNELS.cancel,
        async (ctx: IpcContext, request: WorktreeDiskUsageCancelRequest): Promise<void> => {
          const { sessionId } = readRequest(request);
          assertId(sessionId, "sessionId");
          getWorktreeDiskUsageService().cancel(String(ctx.webContentsId), sessionId);
        },
        { withContext: true }
      ),
    },
  });
}

export function registerWorktreeDiskUsageHandlers(deps: HandlerDependencies): () => void {
  const unregister = buildWorktreeDiskUsageNamespace(deps).register();
  return () => {
    unregister();
    for (const unwatch of watchedOwners.values()) unwatch();
    watchedOwners.clear();
    disposeWorktreeDiskUsageService();
  };
}
