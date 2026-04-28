/**
 * Error thrown by `opValidated` / `typedHandleValidated` when an inbound IPC
 * payload fails Zod parsing. The message is intentionally sanitized to
 * `"IPC validation failed: <channel>"` — Zod issues are logged in-process via
 * `console.error` and never serialized over the wire.
 *
 * Lives in its own module to avoid a circular import between `define.ts` and
 * `utils.ts` (both modules need to reference this class). `errorHandlers.ts`
 * checks `instanceof ValidationError` to classify these as `type: "validation"`
 * for the renderer error surface.
 */
export class ValidationError extends Error {
  readonly channel: string;

  constructor(channel: string) {
    super(`IPC validation failed: ${channel}`);
    this.name = "ValidationError";
    this.channel = channel;
  }
}
