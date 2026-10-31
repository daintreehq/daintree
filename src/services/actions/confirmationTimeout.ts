/**
 * Thrown by an action that gave up on a confirm of its own because the agent
 * dispatch behind it was about to run out of time (#15648): a recipe's
 * panel-limit confirm nobody answered.
 *
 * The class is the authentication, as for {@link ConfirmationStagedError}:
 * only code in this repo can construct it, and `ActionService.dispatch` maps
 * it to the existing `CONFIRMATION_TIMEOUT`, the code the host's own confirm
 * reports when nobody answers it. A plain throw would read as an
 * `EXECUTION_ERROR`, as if starting the work had failed, when nothing started.
 */
export class ConfirmationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfirmationTimeoutError";
  }
}
