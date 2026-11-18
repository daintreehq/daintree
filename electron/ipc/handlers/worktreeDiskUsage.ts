import { indexNestedRoots } from "../../services/DirectoryDiskUsage.js";
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
import type { WorktreeSnapshot } from "../../../shared/types/workspace-host.js";
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

interface Target {
  root: string;
  exclude: readonly string[];
}

/**
 * Each inventory's targets by worktree id, keyed by the states array itself.
 * The overview asks once per worktree, and WorkspaceClient hands every
 * overlapping read the same array, so the requests of one opening share one
 * lookup; a later read, or another project's, is a different array and gets
 * its own. Held weakly, so a lookup lives only as long as its inventory.
 */
const targetsByInventory = new WeakMap<readonly WorktreeSnapshot[], ReadonlyMap<string, Target>>();

/**
 * Each worktree's root with only the roots nested directly inside it to
 * exclude, so a worktree inside another is counted once, in itself, and a
 * sibling costs nothing.
 */
function targetsOf(states: readonly WorktreeSnapshot[]): ReadonlyMap<string, Target> {
  const cached = targetsByInventory.get(states);
  if (cached) return cached;
  // The host lists each id once; should one repeat, its first listing is the
  // worktree, as a lookup by id would find it, and the only one indexed.
  const rootById = new Map<string, string>();
  for (const state of states) if (!rootById.has(state.id)) rootById.set(state.id, state.path);
  const measurable = [...rootById].filter(([, root]) => root);
  const nestedIn = indexNestedRoots(measurable.map(([, root]) => root));
  const targets = new Map(
    measurable.map(([id, root]): [string, Target] => [id, { root, exclude: nestedIn(root) }])
  );
  targetsByInventory.set(states, targets);
  return targets;
}

/**
 * The worktree's root and the roots nested in it, from the requesting view's
 * own project as its workspace host lists it — never a path the renderer
 * supplied.
 */
async function resolveTarget(
  ctx: IpcContext,
  worktreeId: string,
  deps: HandlerDependencies,
  signal: AbortSignal
): Promise<Target | null> {
  const projectId = ctx.projectId;
  if (projectId === null || !deps.worktreeService) return null;
  const project = projectStore.getProjectById(projectId);
  if (!project) return null;
  try {
    const states = await deps.worktreeService.getAllStatesForProjectAsync(project.path, projectId);
    if (signal.aborted) return null;
    return targetsOf(states).get(worktreeId) ?? null;
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
          const target = await resolveTarget(ctx, worktreeId, deps, signal);
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
