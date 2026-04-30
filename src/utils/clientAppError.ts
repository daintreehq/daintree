import type { AppErrorCode } from "../../shared/types/appError";

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

  constructor(code: AppErrorCode, message: string, userMessage?: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.userMessage = userMessage;
    Object.setPrototypeOf(this, ClientAppError.prototype);
  }
}

// Matches the prefix injected by the preload's `_reconstructAppError`. Group 1
// is the AppError code (uppercase identifier). Group 2 is the optional
// urlencoded userMessage (without leading `|`). Group 3 is the original
// human-readable message that follows the closing `]`.
const ENCODED_APP_ERROR_PATTERN = /^\[AppError\|([A-Z_]+)(?:\|([^\]]*))?\] (.*)$/s;

/**
 * Realm-safe guard. Decodes the `[AppError|<code>] message` prefix that the
 * preload sets when an IPC handler throws an `AppError`, and as a side effect
 * attaches `name`, `code`, `userMessage`, and the cleaned `message` back onto
 * the error so callers can read them directly.
 *
 * Falls back to duck-typing on `name === "AppError" && typeof code === "string"`
 * for errors that originate inside the renderer realm (where contextBridge is
 * not in the path and own properties survive).
 */
export function isClientAppError(
  e: unknown
): e is Error & { code: AppErrorCode; userMessage?: string } {
  if (!(e instanceof Error)) return false;

  // Preferred path: decode the prefix the preload injected.
  const match = ENCODED_APP_ERROR_PATTERN.exec(e.message);
  if (match) {
    const [, code, encodedUserMsg, originalMessage] = match;
    const target = e as Error & { code?: string; userMessage?: string };
    target.name = "AppError";
    target.code = code;
    if (encodedUserMsg !== undefined) {
      try {
        target.userMessage = decodeURIComponent(encodedUserMsg);
      } catch {
        target.userMessage = encodedUserMsg;
      }
    }
    e.message = originalMessage ?? e.message;
    return true;
  }

  // Same-realm fallback (no contextBridge crossing).
  return e.name === "AppError" && typeof (e as { code?: unknown }).code === "string";
}
