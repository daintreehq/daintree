import { isAbsolute, resolve } from "node:path";
import { CHANNELS } from "../../ipc/channels.js";
import type { ActionDispatchResult } from "../../../shared/types/actions.js";
import type { AgentSessionRecord } from "../../../shared/types/ipc/agentSessionHistory.js";
import type { ProjectPulse } from "../../../shared/types/pulse.js";
import type { Project } from "../../../shared/types/project.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { pageAgentFacingSessions } from "../../../shared/utils/agentSessionProjection.js";
import { projectPulseForAction } from "../../../shared/utils/pulseProjection.js";
import type { ViewlessActionRequest, ViewlessDeps } from "./ViewlessActionExecutor.js";
import {
  AgentSessionHistoryListArgsSchema,
  GitGetProjectPulseArgsSchema,
} from "./viewlessArgsSchemas.js";
import {
  viewlessFailure as failure,
  viewlessSuccess as success,
  viewlessValidationFailure as validationFailure,
} from "./viewlessResult.js";
import { readProjectWorktrees } from "./viewlessWorktrees.js";

/** The context's worktree, only when it describes this project. */
function contextWorktreeId(request: ViewlessActionRequest, project: Project): string | undefined {
  const context = request.context;
  if (!context) return undefined;
  if (context.projectId !== undefined && context.projectId !== project.id) return undefined;
  return context.activeWorktreeId;
}

/**
 * Closed agent sessions from the journal main holds, for a project with no
 * frontend attached (#14549): the records the view's action pages and projects,
 * read through the same host handler. Explicit ids are honoured as in a view,
 * except that the project is always the one the call is bound to, so a call
 * can't read another project's history on this machine; with none named, the
 * scope is this project and the worktree the call's context is on.
 */
export async function runSessionHistoryList(
  request: ViewlessActionRequest,
  project: Project,
  deps: ViewlessDeps
): Promise<ActionDispatchResult> {
  const parsed = AgentSessionHistoryListArgsSchema.safeParse(request.args ?? {});
  if (!parsed.success) return validationFailure(request.actionId, parsed.error);
  const { worktreeId, projectId, limit, offset } = parsed.data ?? { limit: 20, offset: 0 };

  if (projectId !== undefined && projectId !== project.id) {
    return failure(
      "VALIDATION_ERROR",
      `\`projectId\` ${projectId} is not the project this call is bound to, so ${request.actionId} will not read its history.`
    );
  }
  const scopeWorktreeId =
    worktreeId ?? (projectId === undefined ? contextWorktreeId(request, project) : undefined);

  try {
    const sessions = await deps.invoke<AgentSessionRecord[]>(
      project.id,
      CHANNELS.AGENT_SESSION_LIST,
      [
        {
          ...(scopeWorktreeId !== undefined ? { worktreeId: scopeWorktreeId } : {}),
          projectId: project.id,
        },
      ]
    );
    return success(pageAgentFacingSessions(sessions, offset, limit));
  } catch (err) {
    return failure("EXECUTION_ERROR", formatErrorMessage(err, "Failed to list sessions"));
  }
}

/**
 * A worktree's commit pulse for a project with no frontend attached (#14549),
 * from the host handler a view's call reaches. The worktree is one this project
 * owns, named by id or path, else the call's own or the last a view selected.
 */
export async function runProjectPulse(
  request: ViewlessActionRequest,
  project: Project,
  deps: ViewlessDeps
): Promise<ActionDispatchResult> {
  const parsed = GitGetProjectPulseArgsSchema.safeParse(request.args ?? {});
  if (!parsed.success) return validationFailure(request.actionId, parsed.error);
  const args = parsed.data ?? { rangeDays: 60 as const };

  const worktrees = await readProjectWorktrees(project, deps).catch(() => null);
  if (worktrees === null) {
    return failure("EXECUTION_ERROR", "This project's workspace is not available.");
  }
  const ownedPath = (path: string) =>
    isAbsolute(path)
      ? worktrees.find((worktree) => resolve(worktree.path) === resolve(path))
      : undefined;

  let worktreeId: string | undefined;
  if (args.worktreeId !== undefined) {
    worktreeId = worktrees.find((worktree) => worktree.id === args.worktreeId)?.id;
    if (worktreeId === undefined) {
      return failure(
        "EXECUTION_ERROR",
        "Unknown worktree — no worktree with that id is open in this project."
      );
    }
  } else if (args.worktreePath !== undefined) {
    worktreeId = ownedPath(args.worktreePath)?.id;
    if (worktreeId === undefined) {
      return failure(
        "VALIDATION_ERROR",
        `'${args.worktreePath}' is not one of this project's worktrees, so ${request.actionId} will not read it.`
      );
    }
  } else {
    const saved = (await deps.getProjectState(project.id).catch(() => null))?.activeWorktreeId;
    worktreeId = [contextWorktreeId(request, project), saved]
      .map((candidate) => worktrees.find((worktree) => worktree.id === candidate)?.id)
      .find((id) => id !== undefined);
    if (worktreeId === undefined) {
      return failure(
        "VALIDATION_ERROR",
        "No worktree to read: pass worktreeId or worktreePath, or dispatch from an active worktree."
      );
    }
  }

  try {
    const pulse = await deps.invoke<ProjectPulse>(project.id, CHANNELS.GIT_GET_PROJECT_PULSE, [
      {
        worktreeId,
        rangeDays: args.rangeDays,
        ...(args.includeDelta !== undefined ? { includeDelta: args.includeDelta } : {}),
        ...(args.includeRecentCommits !== undefined
          ? { includeRecentCommits: args.includeRecentCommits }
          : {}),
        ...(args.forceRefresh !== undefined ? { forceRefresh: args.forceRefresh } : {}),
      },
    ]);
    return success(projectPulseForAction(pulse, args.rangeDays));
  } catch (err) {
    return failure("EXECUTION_ERROR", formatErrorMessage(err, "Failed to read the project pulse"));
  }
}
