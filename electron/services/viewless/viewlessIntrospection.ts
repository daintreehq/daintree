import type { ActionDispatchResult, ActionManifestEntry } from "../../../shared/types/actions.js";
import type { Project } from "../../../shared/types/project.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  ActionsGetSchemaArgsSchema,
  ActionsListArgsSchema,
  ActionsSearchArgsSchema,
  listActionManifest,
  searchActionManifest,
} from "../../../shared/utils/actionIntrospection.js";
import { getViewlessHelpBaseManifest } from "../mcp-server/baseManifest.js";
import type { ViewlessActionRequest, ViewlessDeps } from "./ViewlessActionExecutor.js";
import { countProjectPanels } from "./viewlessTerminals.js";
import { readProjectWorktrees } from "./viewlessWorktrees.js";
import {
  viewlessFailure as failure,
  viewlessSuccess as success,
  viewlessValidationFailure as validationFailure,
} from "./viewlessResult.js";

/**
 * Discovery with no view (#13493): a headless host's tools, found the way a
 * view finds them, over the catalog its tool listing already serves with no
 * view (#13511). Main narrows each answer to the caller's own surface, as it
 * narrows a view's, so this only pages, ranks and looks up.
 */

function withoutSchemas(entries: ActionManifestEntry[]): ActionManifestEntry[] {
  return entries.map(({ inputSchema: _input, outputSchema: _output, ...entry }) => entry);
}

export function runActionsList(request: ViewlessActionRequest): ActionDispatchResult {
  const parsed = ActionsListArgsSchema.safeParse(request.args);
  if (!parsed.success) return validationFailure(request.actionId, parsed.error);
  return success(listActionManifest(withoutSchemas(getViewlessHelpBaseManifest()), parsed.data));
}

export function runActionsSearch(request: ViewlessActionRequest): ActionDispatchResult {
  const parsed = ActionsSearchArgsSchema.safeParse(request.args);
  if (!parsed.success) return validationFailure(request.actionId, parsed.error);
  return success(
    searchActionManifest(
      withoutSchemas(getViewlessHelpBaseManifest()),
      parsed.data.query,
      parsed.data.limit
    )
  );
}

export function runActionsGetSchema(request: ViewlessActionRequest): ActionDispatchResult {
  const parsed = ActionsGetSchemaArgsSchema.safeParse(request.args);
  if (!parsed.success) return validationFailure(request.actionId, parsed.error);
  const { actionId } = parsed.data;
  const entry = getViewlessHelpBaseManifest().find((candidate) => candidate.id === actionId);
  if (!entry || entry.mcpVisibility === "hidden" || entry.danger === "restricted") {
    return success({
      ok: false,
      entry: null,
      policy: null,
      error: {
        code: "NOT_FOUND",
        message: `No action found with id "${actionId}". Use actions.search to find available actions.`,
      },
    });
  }
  // `policy` is main's to fill, as it is for a view's answer.
  return success({ ok: true, entry, policy: null, error: null });
}

/**
 * What a view would report as open, with none attached (#14139): the project,
 * the worktree its saved layout last selected, and the panels a view would
 * hydrate. Nothing is focused and no portal is open, because nothing draws
 * them, so those fields are left out rather than guessed.
 */
export async function runActionsGetContext(
  request: ViewlessActionRequest,
  project: Project,
  deps: ViewlessDeps
): Promise<ActionDispatchResult> {
  const contextWorktreeId =
    request.context?.projectId === undefined || request.context.projectId === project.id
      ? request.context?.activeWorktreeId
      : undefined;
  try {
    const [state, worktrees, terminalCount] = await Promise.all([
      deps.getProjectState(project.id).catch(() => null),
      readProjectWorktrees(project, deps),
      countProjectPanels(project, deps),
    ]);
    const activeWorktreeId = contextWorktreeId ?? state?.activeWorktreeId;
    const activeWorktree =
      activeWorktreeId !== undefined
        ? worktrees?.find((worktree) => worktree.id === activeWorktreeId)
        : undefined;
    return success({
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      activeWorktreeId,
      activeWorktreeName: activeWorktree?.name,
      activeWorktreePath: activeWorktree?.path,
      activeWorktreeBranch: activeWorktree?.branch,
      activeWorktreeIsMain: activeWorktree?.isMainWorktree,
      portalOpen: false,
      portalActiveTabId: null,
      terminalCount,
      worktreeCount: worktrees?.length ?? 0,
    });
  } catch (err) {
    return failure("EXECUTION_ERROR", formatErrorMessage(err, "Failed to read the action context"));
  }
}
