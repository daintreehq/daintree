/**
 * The structured "the composite got partway there" contract.
 *
 * `worktree.createWithRecipe` and `workflow.startWorkOnIssue` can create a
 * worktree and then fail on the recipe or agent launch that follows. The
 * worktree is real by then, so the failure has to carry what already exists
 * rather than reporting a clean rejection.
 *
 * Lives in `shared/` rather than beside the action definitions because both
 * ends need it: the renderer formats it, and the MCP server's ownership ledger
 * reads it to attribute a half-created worktree to the session that asked for
 * it (#11909).
 *
 * **The marker in the message is a human-readable label, never the proof.**
 * Provenance rides on {@link PartialSuccessError} and the
 * `PARTIAL_SUCCESS` error code `ActionService` stamps when it recognizes that
 * class. Anything that authorizes a mutation must key on the code: a composite
 * calls out to forge providers and git before the worktree exists, and those
 * failures rethrow the provider's raw message unchanged — so a provider that
 * returned a string merely *shaped* like this payload could otherwise mint an
 * ownership record for a worktree nothing created.
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
 * Thrown by a composite that created something real before failing.
 *
 * The class is the authentication: only code in this repo can construct it,
 * and `ActionService.dispatch` maps it to the `PARTIAL_SUCCESS` error code that
 * downstream consumers gate on. The message keeps the legacy prefixed format so
 * existing readers and tests are unaffected.
 */
export class PartialSuccessError extends Error {
  readonly partialResult: Record<string, unknown>;

  constructor(message: string, partial: Record<string, unknown>) {
    super(formatPartialSuccessMessage(message, partial));
    this.name = "PartialSuccessError";
    this.partialResult = partial;
  }
}

/**
 * Recover the structured payload from a formatted message, or `null` when the
 * message is not one of ours.
 *
 * Deliberately strict — the prefix must start the string, the remainder must
 * parse as JSON, and `partialResult` must be a plain object — but strictness is
 * not provenance. Callers that authorize on the result must first establish
 * that the failure really came from a {@link PartialSuccessError}.
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
