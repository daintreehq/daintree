/**
 * The view's window is attached to another machine and the link to it is
 * down, so the call never reached the plugin's host code. Safe to retry once
 * the link is back; `useHostChannel` reports `disconnected` meanwhile.
 */
export class HostDisconnectedError extends Error {
  readonly code = "HOST_DISCONNECTED" as const;

  constructor(message = "The host this view runs on is not connected", options?: ErrorOptions) {
    super(message, options);
    this.name = "HostDisconnectedError";
  }
}

/**
 * The link dropped after the call was sent: the plugin's host code may or may
 * not have run it. Don't blindly repeat a call that changes something — check
 * its effect first, or make it idempotent.
 */
export class OutcomeUnknownError extends Error {
  readonly code = "OUTCOME_UNKNOWN" as const;

  constructor(
    message = "The link to the host dropped before the call finished; it may or may not have run",
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "OutcomeUnknownError";
  }
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
}

/**
 * Re-type a rejected host call: a lost link becomes {@link HostDisconnectedError}
 * or {@link OutcomeUnknownError} (keeping the original as `cause`); anything
 * else comes back as an `Error` unchanged.
 */
export function toHostCallError(error: unknown): Error {
  if (error instanceof HostDisconnectedError || error instanceof OutcomeUnknownError) return error;
  const code = errorCode(error);
  let message: string | undefined;
  if (error instanceof Error) message = error.message;
  if (code === "HOST_DISCONNECTED") return new HostDisconnectedError(message, { cause: error });
  if (code === "OUTCOME_UNKNOWN") return new OutcomeUnknownError(message, { cause: error });
  return error instanceof Error ? error : new Error(String(error));
}

/** Whether an error means the link to the host was lost. */
export function isHostLinkError(error: unknown): boolean {
  return error instanceof HostDisconnectedError || error instanceof OutcomeUnknownError;
}
