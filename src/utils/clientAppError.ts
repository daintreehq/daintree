import type { AppErrorCode, AppErrorDetails } from "../../shared/types/appError";

/**
 * Renderer-side mirror of the main-process `AppError`. Reconstructed by the
 * preload's `_unwrappingInvoke` when an IPC handler throws an `AppError`, so
 * callers can do `if (isClientAppError(e) && e.code === "BINARY_FILE")` to
 * pattern-match on the discriminated `code` instead of substring-matching
 * `e.message`.
 *
 * `instanceof ClientAppError` is unreliable across the contextBridge realm
 * boundary — use the `isClientAppError` guard, which decodes the encoded
 * `[AppError|<code>] message` prefix that the preload sets on `e.message`.
 * Electron's contextBridge strips ALL custom properties on Error instances
 * (including own `name`) when an error crosses the preload→renderer realm,
 * so the prefix is the only reliable carrier for the discriminant.
 */
export class ClientAppError extends Error {
  readonly code: AppErrorCode;
  readonly userMessage?: string;
  readonly details?: AppErrorDetails;

  constructor(
    code: AppErrorCode,
    message: string,
    userMessage?: string,
    details?: AppErrorDetails
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.userMessage = userMessage;
    if (details !== undefined) this.details = details;
    Object.setPrototypeOf(this, ClientAppError.prototype);
  }
}

// Matches the prefix injected by the preload's `_reconstructAppError`. Group 1
// is the AppError code (uppercase identifier). Group 2 is the optional
// urlencoded userMessage (without leading `|`). Group 3 is the optional
// urlencoded JSON `details`, marked by a leading `#` (which a urlencoded
// userMessage can never start with). Group 4 is the original human-readable
// message that follows the closing `]`.
const ENCODED_APP_ERROR_PATTERN =
  /^\[AppError\|([A-Z_]+)(?:\|(?!#)([^\]]*?))?(?:\|#([^\]|]*))?\] (.*)$/s;

function isAppErrorDetails(value: unknown): value is AppErrorDetails {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "code" in value &&
    typeof value.code === "string"
  );
}

function decodeDetails(encoded: string): AppErrorDetails | undefined {
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(encoded));
    return isAppErrorDetails(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Realm-safe guard. Decodes the `[AppError|<code>] message` prefix that the
 * preload sets when an IPC handler throws an `AppError`, and as a side effect
 * attaches `name`, `code`, `userMessage`, `details`, and the cleaned `message`
 * back onto the error so callers can read them directly.
 *
 * Falls back to duck-typing on `name === "AppError" && typeof code === "string"`
 * for errors that originate inside the renderer realm (where contextBridge is
 * not in the path and own properties survive).
 */
export function isClientAppError(
  e: unknown
): e is Error & { code: AppErrorCode; userMessage?: string; details?: AppErrorDetails } {
  if (!(e instanceof Error)) return false;

  // Preferred path: decode the prefix the preload injected.
  const match = ENCODED_APP_ERROR_PATTERN.exec(e.message);
  if (match) {
    const [, code, encodedUserMsg, encodedDetails, originalMessage] = match;
    const target = e as Error & { code?: string; userMessage?: string; details?: AppErrorDetails };
    target.name = "AppError";
    target.code = code;
    if (encodedUserMsg !== undefined) {
      try {
        target.userMessage = decodeURIComponent(encodedUserMsg);
      } catch {
        target.userMessage = encodedUserMsg;
      }
    }
    if (encodedDetails !== undefined) {
      const details = decodeDetails(encodedDetails);
      if (details !== undefined) target.details = details;
    }
    e.message = originalMessage ?? e.message;
    return true;
  }

  // Same-realm fallback (no contextBridge crossing).
  return e.name === "AppError" && typeof (e as { code?: unknown }).code === "string";
}
