import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { CHANNELS } from "../../ipc/channels.js";
import type { ActionDispatchResult } from "../../../shared/types/actions.js";
import type { Issue, ListOptions, Page, PR } from "../../../shared/types/forge.js";
import type { ForgeCIStatusSummary } from "../../../shared/types/ipc/forge.js";
import {
  ForgeCIStatusActionResultSchema,
  ForgeIssueResultSchema,
  ForgePRActionResultSchema,
} from "../../../shared/types/forgeActionResults.js";
import type { Project } from "../../../shared/types/project.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  ForgeIssuePageResultSchema,
  ForgePRPageResultSchema,
  projectForgePage,
  projectIssueSummary,
  projectPRSummary,
} from "../../../shared/utils/forgeListProjection.js";
import type { ViewlessActionRequest, ViewlessDeps } from "./ViewlessActionExecutor.js";
import { VIEWLESS_FORGE_ARGS_SCHEMAS } from "./viewlessArgsSchemas.js";
import {
  viewlessFailure as failure,
  viewlessSuccess as success,
  viewlessValidationFailure as validationFailure,
} from "./viewlessResult.js";
import { readProjectWorktrees } from "./viewlessWorktrees.js";

/**
 * The forge reads the orchestration runbooks call, run on a host with no
 * window open (#13501). Each takes the same arguments as its renderer action,
 * asks the same host IPC handler a view's call reaches, and hands back the
 * result through the same result schema a view's dispatch parses it with, so
 * the provider's raw payload is dropped exactly as it is there.
 *
 * The arguments each takes are in `viewlessArgsSchemas.ts`.
 */

type LocationArgs = { worktreeId?: string; worktreePath?: string; cwd?: string };

/**
 * The repository a forge read asks about: a worktree of this project, named
 * or active, or the project's own root. A view resolves the same selectors
 * against its open worktrees; here the active one is the last a view
 * selected, and a path must be one this project owns, so a call bound to the
 * project can't read another repository on this machine.
 */
async function resolveForgeCwd(
  request: ViewlessActionRequest,
  project: Project,
  deps: ViewlessDeps,
  args: LocationArgs
): Promise<{ ok: true; cwd: string } | { ok: false; result: ActionDispatchResult }> {
  const paths = [args.worktreePath, args.cwd].filter(
    (candidate): candidate is string => candidate !== undefined
  );
  if (new Set(paths).size > 1) {
    return {
      ok: false,
      result: failure(
        "VALIDATION_ERROR",
        `Invalid arguments for ${request.actionId}: \`worktreePath\` and its legacy aliases name the same value — supply only one, or identical values.`
      ),
    };
  }
  const worktrees = await readProjectWorktrees(project, deps).catch(() => null);
  // Inside the project or one of its worktrees, as the forge resolves a
  // repository from any directory in it. Compared as resolved paths, so a
  // trailing slash or a `..` can't step outside.
  const roots = [project.path, ...(worktrees ?? []).map((worktree) => worktree.path)];
  const owned = (path: string) => {
    if (!isAbsolute(path)) return false;
    const target = resolve(path);
    return roots.some((root) => {
      const rel = relative(resolve(root), target);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
  };
  if (args.worktreeId !== undefined) {
    const path =
      worktrees?.find((worktree) => worktree.id === args.worktreeId)?.path ??
      (args.worktreeId === project.path ? project.path : undefined);
    if (path === undefined) {
      return {
        ok: false,
        result: failure(
          "EXECUTION_ERROR",
          "Unknown worktree — no worktree with that id is open in this project."
        ),
      };
    }
    return { ok: true, cwd: path };
  }
  const supplied = paths[0];
  if (supplied !== undefined) {
    if (!owned(supplied)) {
      return {
        ok: false,
        result: failure(
          "VALIDATION_ERROR",
          `'${supplied}' is not inside this project or one of its worktrees, so ${request.actionId} will not read it.`
        ),
      };
    }
    return { ok: true, cwd: supplied };
  }
  const context = request.context;
  const fromContext =
    context?.projectId === undefined || context.projectId === project.id
      ? context?.activeWorktreePath
      : undefined;
  if (fromContext && owned(fromContext)) return { ok: true, cwd: fromContext };
  const saved = (await deps.getProjectState(project.id).catch(() => null))?.activeWorktreeId;
  const savedPath = saved
    ? (worktrees?.find((worktree) => worktree.id === saved)?.path ??
      (isAbsolute(saved) && owned(saved) ? saved : undefined))
    : undefined;
  return { ok: true, cwd: savedPath ?? project.path };
}

/** A result held to the schema a view's dispatch parses it with. */
function parsed(actionId: string, schema: z.ZodType, value: unknown): ActionDispatchResult {
  const checked = schema.safeParse(value);
  if (!checked.success) {
    return failure(
      "RESULT_VALIDATION_ERROR",
      `Action "${actionId}" returned a result that does not match its declared schema`
    );
  }
  return success(checked.data);
}

export async function runForgeRead(
  request: ViewlessActionRequest,
  project: Project,
  deps: ViewlessDeps
): Promise<ActionDispatchResult | null> {
  const actionId = request.actionId;
  if (!Object.hasOwn(VIEWLESS_FORGE_ARGS_SCHEMAS, actionId)) return null;
  const schema = VIEWLESS_FORGE_ARGS_SCHEMAS[actionId as keyof typeof VIEWLESS_FORGE_ARGS_SCHEMAS];
  const args = schema.safeParse(request.args ?? {});
  if (!args.success) return validationFailure(actionId, args.error);
  const resolved = await resolveForgeCwd(request, project, deps, args.data);
  if (!resolved.ok) return resolved.result;
  const { cwd } = resolved;
  const invoke = <T>(channel: string, payload: unknown) =>
    deps.invoke<T>(project.id, channel, [payload]);

  try {
    switch (actionId) {
      case "forge.listIssues":
      case "forge.listPRs": {
        const { search, state, cursor, perPage, sort, direction, bypassCache, view } =
          args.data as z.infer<(typeof VIEWLESS_FORGE_ARGS_SCHEMAS)["forge.listPRs"]>;
        const opts: ListOptions = {
          ...(search !== undefined ? { search } : {}),
          ...(state !== undefined ? { state } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
          ...(perPage !== undefined ? { perPage } : {}),
          ...(sort !== undefined ? { sort } : {}),
          ...(direction !== undefined ? { direction } : {}),
          ...(bypassCache !== undefined ? { bypassCache } : {}),
        };
        if (actionId === "forge.listIssues") {
          const page = await invoke<Page<Issue>>(CHANNELS.FORGE_LIST_ISSUES, { cwd, opts });
          return parsed(
            actionId,
            ForgeIssuePageResultSchema,
            projectForgePage(page, view ?? "summary", projectIssueSummary)
          );
        }
        const page = await invoke<Page<PR>>(CHANNELS.FORGE_LIST_PRS, { cwd, opts });
        return parsed(
          actionId,
          ForgePRPageResultSchema,
          projectForgePage(page, view ?? "summary", projectPRSummary)
        );
      }
      case "forge.getIssue": {
        const { issueNumber } = args.data as { issueNumber: number };
        const issue = await invoke<Issue | null>(CHANNELS.FORGE_GET_ISSUE, { cwd, issueNumber });
        return parsed(actionId, ForgeIssueResultSchema.nullable(), issue);
      }
      case "forge.getPR": {
        const { prNumber } = args.data as { prNumber: number };
        const pr = await invoke<PR | null>(CHANNELS.FORGE_GET_PR, { cwd, prNumber });
        return parsed(actionId, ForgePRActionResultSchema, { pr });
      }
      case "forge.getCIStatus": {
        const { prNumber } = args.data as { prNumber: number };
        const ciStatus = await invoke<ForgeCIStatusSummary | null>(CHANNELS.FORGE_GET_CI_STATUS, {
          cwd,
          prNumber,
        });
        return parsed(actionId, ForgeCIStatusActionResultSchema, { ciStatus });
      }
      default:
        return null;
    }
  } catch (err) {
    return failure("EXECUTION_ERROR", formatErrorMessage(err, `${actionId} failed`));
  }
}
