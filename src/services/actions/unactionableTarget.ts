/**
 * Thrown by an action whose named target structurally cannot take the operation
 * — not a failure to perform it, but a refusal to try (#12338).
 *
 * The class is the authentication, exactly as {@link ConfirmationStagedError}
 * is: only code in this repo can construct it, and `ActionService.dispatch`
 * maps it to the existing `VALIDATION_ERROR` rather than widening
 * `ActionErrorCode`, following `panelLimitError`'s rule — the union is the
 * plugin-facing error contract.
 *
 * Which code it lands on is the whole point. A plain throw becomes
 * `EXECUTION_ERROR`, and `EXECUTION_ERROR` is in `RETRIABLE_ERROR_CODES`, so
 * the MCP payload tells the caller a retry with identical arguments might work.
 * For "this agent binds a different cancel key" or "this panel has already
 * exited" that is false, and false in the direction that costs the most: a
 * model reading `retriable: true` on a permanent refusal loops on it.
 */
export class UnactionableTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnactionableTargetError";
  }
}
