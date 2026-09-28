import type { SerializedError } from "../../shared/types/ipc/errors.js";
import { scrubSecrets } from "../../shared/utils/secretScrubber.js";

function sanitizePaths(msg: string): string {
  return msg
    .replace(/\/(?:Users|home|tmp|private|var)\/[^\s:]+/gi, "<path>")
    .replace(/[A-Z]:[/\\](?:Users|Program Files|Windows|ProgramData)[^\s:]*/gi, "<path>")
    .replace(/\\\\(?:[^\s\\]+)\\(?:[^\s:]+)/g, "<path>");
}

/**
 * Strip filesystem paths and pattern-known secret sigils from an error message
 * before it leaves this process. Path normalization runs first so a token
 * embedded inside a path is still caught after the path is collapsed to
 * `<path>`.
 */
export function sanitizeErrorMessage(msg: string): string {
  return scrubSecrets(sanitizePaths(msg));
}

/**
 * The policy for a serialized error crossing a trust boundary (the packaged
 * renderer envelope, and every error sent over a remote-host link): messages
 * are scrubbed, and everything that can carry the sender's filesystem layout or
 * arbitrary data — stack, path, context, cause, properties — is dropped. `code`
 * and the allowlisted `details` deliberately survive. Mutates and returns
 * `serialized`.
 */
export function toTransportSafeError<T extends SerializedError>(serialized: T): T {
  serialized.message = sanitizeErrorMessage(serialized.message);
  if (typeof serialized.userMessage === "string") {
    serialized.userMessage = sanitizeErrorMessage(serialized.userMessage);
  }
  serialized.stack = undefined;
  serialized.path = undefined;
  serialized.context = undefined;
  serialized.cause = undefined;
  serialized.properties = undefined;
  return serialized;
}
