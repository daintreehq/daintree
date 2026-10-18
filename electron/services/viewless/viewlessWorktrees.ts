import { z } from "zod";
import { CHANNELS } from "../../ipc/channels.js";
import { DEV_PREVIEW_METHOD_CHANNELS } from "../../ipc/handlers/devPreview.preload.js";
import type { ActionDispatchResult } from "../../../shared/types/actions.js";
import type { Project } from "../../../shared/types/project.js";
import type { WorktreeListResult, WorktreeState } from "../../../shared/types/worktree.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { PartialSuccessError } from "../../../shared/utils/partialSuccess.js";
import {
  MAX_WAIT_UNTIL_READY_TIMEOUT_MS,
  toWorktreeSummary,
  waitForWorktreeSetup,
  WORKTREE_BRANCH_KEPT_MARKER,
} from "../../../shared/utils/worktreeSummary.js";
import type {
  ViewlessActionRequest,
  ViewlessDeps,
  ViewlessWorkspaceHosts,
} from "./ViewlessActionExecutor.js";
import {
  viewlessFailure as failure,
  viewlessSuccess as success,
  viewlessValidationFailure as validationFailure,
} from "./viewlessResult.js";

const WorktreeWaitArgsSchema = z
  .object({
    worktreeId: z.string().min(1).optional(),
    worktreePath: z.string().min(1).optional(),
    timeoutMs: z.number().int().min(0).max(MAX_WAIT_UNTIL_READY_TIMEOUT_MS).optional(),
  })
  .optional();

const WorktreeDeleteArgsSchema = z.object({
  worktreeId: z.string().min(1),
  force: z.boolean().optional(),
  deleteBranch: z.boolean().optional(),
  closeTerminals: z.boolean().optional(),
});

/**
 * The project's workspace host, started when no window has started it. With
 * no project load to piggyback on, the host is prewarmed on its own; the pool
 * reclaims it after its dormant grace period like any other host no window
 * holds.
 */
export async function ensureWorkspaceHost(
  project: Project,
  deps: ViewlessDeps
): Promise<ViewlessWorkspaceHosts | null> {
  const hosts = deps.getWorkspaceHosts();
  if (!hosts) return null;
  if (hosts.getHostForProject(project.path) === undefined) {
    hosts.prewarmProject(project.path);
  }
  await hosts.waitForReady();
  return hosts;
}

/** The project's worktrees as the workspace host reports them, or null with no host. */
export async function readProjectWorktrees(
  project: Project,
  deps: ViewlessDeps
): Promise<WorktreeState[] | null> {
  if (!(await ensureWorkspaceHost(project, deps))) return null;
  const listed = await deps.invoke<WorktreeListResult>(
    project.id,
    CHANNELS.WORKTREE_GET_ALL_WITH_STATUS,
    []
  );
  return listed?.worktrees ?? [];
}

/**
 * The active worktree a view would report: the one the saved layout last
 * selected. With no view attached, that is the last selection a view made.
 */
async function savedActiveWorktreeId(project: Project, deps: ViewlessDeps) {
  return (await deps.getProjectState(project.id).catch(() => null))?.activeWorktreeId;
}

export async function runWorktreeList(
  _request: ViewlessActionRequest,
  project: Project,
  deps: ViewlessDeps
): Promise<ActionDispatchResult> {
  const [worktrees, activeWorktreeId] = await Promise.all([
    readProjectWorktrees(project, deps).catch((err: unknown) => {
      console.warn("[Viewless] Could not list worktrees:", formatErrorMessage(err, "unknown"));
      return null;
    }),
    savedActiveWorktreeId(project, deps),
  ]);
  // Never fails, as the view's listing never does: no host is no worktrees.
  return success({
    worktrees: (worktrees ?? []).map((worktree) => toWorktreeSummary(worktree, activeWorktreeId)),
  });
}

export async function runWorktreeWaitUntilReady(
  request: ViewlessActionRequest,
  project: Project,
  deps: ViewlessDeps
): Promise<ActionDispatchResult> {
  const parsed = WorktreeWaitArgsSchema.safeParse(request.args);
  if (!parsed.success) return validationFailure(request.actionId, parsed.error);
  const { worktreeId: requestedId, worktreePath, timeoutMs } = parsed.data ?? {};

  const fallbackId =
    request.context?.projectId === undefined || request.context.projectId === project.id
      ? request.context?.activeWorktreeId
      : undefined;
  const target =
    requestedId ?? worktreePath ?? fallbackId ?? (await savedActiveWorktreeId(project, deps));
  if (target === undefined) {
    return failure(
      "EXECUTION_ERROR",
      "No active worktree — supply `worktreeId` or `worktreePath`."
    );
  }

  try {
    const result = await waitForWorktreeSetup(
      target,
      timeoutMs,
      async (id) => {
        const worktrees = await readProjectWorktrees(project, deps);
        // A path names the worktree rooted there, as an id does.
        const match = worktrees?.find((worktree) => worktree.id === id || worktree.path === id);
        return match ? match.setupStatus : null;
      },
      { now: () => Date.now(), sleep: (ms) => deps.sleep(ms) }
    );
    return success(result);
  } catch (err) {
    return failure("EXECUTION_ERROR", formatErrorMessage(err, "Failed to read worktree setup"));
  }
}

/**
 * Delete one of this project's worktrees, the way a view's delete does: stop
 * any dev preview running in it first — Windows holds a directory lock while
 * the server runs, so removal would fail outright (#9084) — then remove it.
 * Only a worktree the host confirms belongs to this project is touched: the
 * delete handler routes by id alone.
 */
export async function runWorktreeDelete(
  request: ViewlessActionRequest,
  project: Project,
  deps: ViewlessDeps
): Promise<ActionDispatchResult> {
  const parsed = WorktreeDeleteArgsSchema.safeParse(request.args);
  if (!parsed.success) return validationFailure(request.actionId, parsed.error);
  const { worktreeId, force, deleteBranch, closeTerminals } = parsed.data;
  // A force delete can discard tracked work, which a view guards with a typed
  // name on top of the ordinary approval. Only the assistant's skip preference
  // stands in for that, as it does there; with no frontend to type the name
  // into, anything else is refused before the worktree is touched.
  if (force === true && request.authorization !== "skip-preference") {
    return failure(
      "CONFIRMATION_REQUIRED",
      `${request.actionId} with force can discard uncommitted work, which needs a typed confirmation, but no Daintree frontend is attached to this project to take it. The worktree was not deleted.`,
      { confirmationChannel: "unavailable" }
    );
  }
  // A view closes the worktree's panels from its own store, and restores them
  // if the delete fails. With no view there is no store to restore them into.
  if (closeTerminals === true) {
    return failure(
      "VALIDATION_ERROR",
      `${request.actionId} cannot close a worktree's terminals when no frontend is attached to this project. Close them first, then delete without closeTerminals.`
    );
  }

  try {
    const hosts = await ensureWorkspaceHost(project, deps);
    if (!hosts) return failure("EXECUTION_ERROR", "Workspace service is not available");
    const owned = await hosts.isWorktreeOwnedByProject(worktreeId, project.path, project.id);
    if (owned !== true) {
      return failure(
        "VALIDATION_ERROR",
        `'${worktreeId}' could not be confirmed as a worktree of this project, so ${request.actionId} will not delete it.`
      );
    }
    await deps.invoke<void>(project.id, DEV_PREVIEW_METHOD_CHANNELS.stopByWorktree, [
      { worktreeId },
    ]);
    await deps.invoke<void>(project.id, CHANNELS.WORKTREE_DELETE, [
      { worktreeId, force, deleteBranch },
    ]);
  } catch (err) {
    const message = formatErrorMessage(err, "Worktree delete failed");
    // The branch step runs after `git worktree remove` succeeded, so a kept
    // branch is a finished delete, reported the way a view reports it. The
    // payload names no worktree, so it can never be read as minting one.
    if (message.includes(WORKTREE_BRANCH_KEPT_MARKER)) {
      const partial = new PartialSuccessError(message, {
        worktreeDeleted: true,
        branchDeleted: false,
      });
      return failure("PARTIAL_SUCCESS", partial.message, partial);
    }
    return failure("EXECUTION_ERROR", message);
  }
  return success(undefined);
}
