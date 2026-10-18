import { CHANNELS } from "../../ipc/channels.js";
import type { ActionDispatchResult } from "../../../shared/types/actions.js";
import type { ForgeUser, PR } from "../../../shared/types/forge.js";
import type { WorktreeBranchCollisionPolicy } from "../../../shared/types/git.js";
import type { Project } from "../../../shared/types/project.js";
import type { WorktreeCreateResult } from "../../../shared/types/worktree.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type { ViewlessActionRequest, ViewlessDeps } from "./ViewlessActionExecutor.js";
import { WorktreeCreateWithRecipeArgsSchema } from "./viewlessArgsSchemas.js";
import {
  viewlessFailure as failure,
  viewlessSuccess as success,
  viewlessValidationFailure as validationFailure,
} from "./viewlessResult.js";
import { ensureWorkspaceHost, readProjectWorktrees } from "./viewlessWorktrees.js";

/**
 * A `createWithRecipe` that names a recipe, refused before it is put to
 * anyone or anything is created: a recipe starts its terminals through a
 * window's recipes and panels, so no approval here could make it run.
 */
export function refuseRecipeWithNoView(
  request: Pick<ViewlessActionRequest, "actionId" | "args">
): ActionDispatchResult | null {
  const recipeId =
    request.args !== null && typeof request.args === "object"
      ? (request.args as { recipeId?: unknown }).recipeId
      : undefined;
  if (typeof recipeId !== "string" || recipeId === "") return null;
  return failure(
    "VALIDATION_ERROR",
    `${request.actionId} can't run recipe '${recipeId}' with no Daintree window open on this project: a recipe starts its terminals through a window's recipes and panels. Nothing was created. Call it without recipeId, then start terminals or agents in the new worktree.`
  );
}

/**
 * `worktree.createWithRecipe` on a host with no window open (#13501): the
 * managed creator a view runs, in all three modes — a new branch, an existing
 * one, a pull request's head — with the same collision handling, done by the
 * same host handlers. What only a view has is refused or said rather than
 * guessed: a recipe runs through a view's recipe store and panels, so a call
 * naming one is refused before anything is created; and the "Assign issue to
 * me" default is a view's preference, so with none given the issue is left
 * unassigned and the result says why.
 */
export async function runWorktreeCreateWithRecipe(
  request: ViewlessActionRequest,
  project: Project,
  deps: ViewlessDeps
): Promise<ActionDispatchResult> {
  const parsed = WorktreeCreateWithRecipeArgsSchema.safeParse(request.args);
  if (!parsed.success) return validationFailure(request.actionId, parsed.error);
  // A recipe was refused before admission: see `refuseRecipeWithNoView`.
  const { source } = parsed.data;

  const rootPath = project.path;
  const invoke = <T>(channel: string, payload: unknown) =>
    deps.invoke<T>(project.id, channel, [payload]);
  const issue = source.kind === "pullRequest" ? undefined : source.issueNumber;
  const assignToSelf = source.kind === "pullRequest" ? undefined : source.assignToSelf;

  let requestedBranch: string;
  let candidateBranch: string;
  let effectiveBase: string;
  let useExistingBranch: boolean;
  let fromRemote: boolean;
  let collisionPolicy: WorktreeBranchCollisionPolicy | undefined;
  let path: string;
  let created: WorktreeCreateResult;
  try {
    if (!(await ensureWorkspaceHost(project, deps))) {
      return failure("EXECUTION_ERROR", "Workspace service is not available");
    }
    if (source.kind === "pullRequest") {
      const pr = await invoke<PR | null>(CHANNELS.FORGE_GET_PR, {
        cwd: rootPath,
        prNumber: source.pullRequestNumber,
      });
      if (!pr) {
        return failure(
          "EXECUTION_ERROR",
          `Pull request #${source.pullRequestNumber} not found in ${rootPath}`
        );
      }
      if (!pr.headRef?.trim()) {
        return failure(
          "EXECUTION_ERROR",
          `Pull request #${source.pullRequestNumber} has no head branch — cannot create worktree`
        );
      }
      try {
        await invoke<void>(CHANNELS.WORKTREE_FETCH_PR_BRANCH, {
          rootPath,
          prNumber: source.pullRequestNumber,
          headRefName: pr.headRef,
        });
      } catch (error) {
        return failure(
          "EXECUTION_ERROR",
          `Couldn't fetch branch "${pr.headRef}" for pull request #${source.pullRequestNumber}. ` +
            `Fetch it yourself, then retry with source.kind="existingBranch" and source.branchName="${pr.headRef}". ` +
            `Details: ${formatErrorMessage(error, "the git fetch failed")}`
        );
      }
      requestedBranch = pr.headRef;
      candidateBranch = pr.headRef;
      effectiveBase = pr.headRef;
      useExistingBranch = true;
      fromRemote = false;
    } else if (source.kind === "existingBranch") {
      requestedBranch = source.branchName;
      candidateBranch = source.branchName;
      effectiveBase = source.branchName;
      useExistingBranch = true;
      fromRemote = false;
    } else {
      let baseRef = source.baseBranch;
      if (!baseRef) {
        const main = (await readProjectWorktrees(project, deps))?.find(
          (worktree) => worktree.isMainWorktree
        );
        if (!main) {
          return failure(
            "EXECUTION_ERROR",
            "No base branch specified and no main worktree found. Please specify source.baseBranch."
          );
        }
        baseRef = main.branch;
      }
      if (!baseRef) {
        return failure("EXECUTION_ERROR", "Base branch is required but was not determined");
      }
      requestedBranch = source.branchName;
      effectiveBase = baseRef;
      useExistingBranch = false;
      fromRemote = source.fromRemote ?? false;
      collisionPolicy = source.collisionPolicy ?? "suffix";
      // A naming hint only, as in a view: the host re-resolves a collision
      // against the `git worktree add` itself.
      candidateBranch =
        collisionPolicy === "suffix"
          ? await invoke<string>(CHANNELS.WORKTREE_GET_AVAILABLE_BRANCH, {
              rootPath,
              branchName: requestedBranch,
            })
          : requestedBranch;
    }

    path = await invoke<string>(CHANNELS.WORKTREE_GET_DEFAULT_PATH, {
      rootPath,
      branchName: candidateBranch,
    });
    created = await invoke<WorktreeCreateResult>(CHANNELS.WORKTREE_CREATE, {
      rootPath,
      options: {
        baseBranch: effectiveBase,
        newBranch: candidateBranch,
        path,
        fromRemote,
        useExistingBranch,
        ...(collisionPolicy ? { collisionPolicy } : {}),
      },
    });
  } catch (err) {
    return failure("EXECUTION_ERROR", formatErrorMessage(err, "Failed to create worktree"));
  }
  if (!created?.worktreeId) {
    return failure(
      "EXECUTION_ERROR",
      "Failed to create worktree: no worktreeId returned from backend"
    );
  }

  let assignedToSelf = false;
  let assignedUsername: string | null = null;
  let assignmentError: string | null = null;
  if (issue !== undefined && assignToSelf === undefined) {
    assignmentError =
      "Not assigned: assignToSelf wasn't given, and its default is a preference a Daintree window keeps. Pass assignToSelf to assign the issue.";
  } else if (issue !== undefined && assignToSelf === true) {
    try {
      const user = await invoke<ForgeUser | null>(CHANNELS.FORGE_GET_CURRENT_USER, {
        cwd: rootPath,
      });
      if (user) {
        try {
          await invoke<unknown>(CHANNELS.FORGE_ASSIGN_ISSUE, {
            cwd: rootPath,
            issueNumber: issue,
            username: user.login,
          });
          assignedToSelf = true;
          assignedUsername = user.login;
        } catch (err) {
          assignmentError = formatErrorMessage(err, "Failed to assign issue");
        }
      } else {
        assignmentError = "No forge viewer available";
      }
    } catch (err) {
      assignmentError = formatErrorMessage(err, "Failed to read forge viewer");
    }
  }

  return success({
    worktreeId: created.worktreeId,
    worktreePath: path,
    branch: created.branch,
    requestedBranch,
    effectiveBranch: created.branch,
    recipeLaunched: false,
    spawnedTerminalCount: 0,
    spawnedTerminalIds: [],
    failedTerminalCount: 0,
    setupState: created.setupState,
    assignedToSelf,
    assignedUsername,
    assignmentError,
  });
}
