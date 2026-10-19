import type { ActionDispatchResult, ActionManifestEntry } from "../../../shared/types/actions.js";
import {
  ActionsGetSchemaArgsSchema,
  ActionsListArgsSchema,
  ActionsSearchArgsSchema,
  listActionManifest,
  searchActionManifest,
} from "../../../shared/utils/actionIntrospection.js";
import { getViewlessHelpBaseManifest } from "../mcp-server/baseManifest.js";
import type { ViewlessActionRequest } from "./ViewlessActionExecutor.js";
import {
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
