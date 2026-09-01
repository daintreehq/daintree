/**
 * Thrown by an action whose `run()` staged a confirmation instead of acting.
 *
 * The class is the authentication, exactly as {@link PartialSuccessError} is:
 * only code in this repo can construct it, and `ActionService.dispatch` maps it
 * to the existing `CONFIRMATION_REQUIRED` code. Reusing that code rather than
 * widening `ActionErrorCode` follows `panelLimitError`'s rule — the union is the
 * plugin-facing error contract — and it already means what this outcome is.
 *
 * It exists because staging must not resolve `ok`. A destructive action that
 * parked a dialog and returned normally reported success on a terminal that is
 * still alive, and an agent reading `ok` moved on (#12120, same shape as #8814).
 *
 * Lives in its own leaf module so `ActionService` can recognise it without
 * importing the action-definitions graph.
 */
export class ConfirmationStagedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfirmationStagedError";
  }
}

/**
 * The message an MCP caller reads when its dispatch staged rather than acted.
 *
 * Says what did NOT happen first: the failure mode this guards against is a
 * model treating a staged destructive call as done.
 */
export function confirmationStagedMessage(what: string): string {
  return `${what} was not performed — it needs confirmation, and one is now waiting for the user. Nothing changed.`;
}
