/**
 * The structured "the composite got partway there" contract.
 *
 * `worktree.createWithRecipe` and `workflow.startWorkOnIssue` can create a
 * worktree and then fail on the recipe or agent launch that follows. The
 * worktree is real by then, so the failure has to carry what already exists
 * rather than reporting a clean rejection. It rides in the thrown `Error`'s
 * message because `ActionService.dispatch` flattens every renderer throw to
 * `{ ok: false, error: { code, message } }` — the message is the only field
 * that survives the trip to the MCP main process (#11909).
 *
 * Lives in `shared/` rather than beside the action definitions because both
 * ends need it: the renderer formats it, and the MCP server's ownership ledger
 * parses it to attribute a half-created worktree to the session that asked for
 * it. A second copy of the prefix in main would be exactly the drift this
 * module exists to prevent.
 */
export const PARTIAL_SUCCESS_PREFIX = "PARTIAL_SUCCESS:";

export interface PartialSuccessPayload {
  message: string;
  partialResult: Record<string, unknown>;
}

export function formatPartialSuccessMessage(
  message: string,
  partial: Record<string, unknown>
): string {
  return `${PARTIAL_SUCCESS_PREFIX} ${JSON.stringify({ message, partialResult: partial })}`;
}

/**
 * Recover the structured payload from a formatted message, or `null` when the
 * message is not one of ours.
 *
 * Deliberately strict: the prefix must start the string, the remainder must
 * parse as JSON, and `partialResult` must be a plain object. A caller-supplied
 * error message that merely *contains* the prefix must not be mistaken for a
 * trusted creation record — this parser feeds an authorization ledger, so
 * anything short of the exact shape returns `null` rather than a best guess.
 */
export function parsePartialSuccessMessage(message: unknown): PartialSuccessPayload | null {
  if (typeof message !== "string") return null;
  const trimmed = message.trimStart();
  if (!trimmed.startsWith(PARTIAL_SUCCESS_PREFIX)) return null;
  const json = trimmed.slice(PARTIAL_SUCCESS_PREFIX.length).trim();
  if (json.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { message: payloadMessage, partialResult } = parsed as {
    message?: unknown;
    partialResult?: unknown;
  };
  if (typeof partialResult !== "object" || partialResult === null || Array.isArray(partialResult)) {
    return null;
  }
  return {
    message: typeof payloadMessage === "string" ? payloadMessage : "",
    partialResult: partialResult as Record<string, unknown>,
  };
}
