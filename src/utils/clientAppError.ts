import type { AppErrorCode, AppErrorDetails } from "../../shared/types/appError";
import { decodeAppErrorWire } from "@shared/utils/appErrorWire";
import { formatErrorMessage } from "@shared/utils/errorMessage";

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
  const decoded = decodeAppErrorWire(e.message);
  if (decoded) {
    const target = e as Error & { code?: string; userMessage?: string; details?: AppErrorDetails };
    target.name = "AppError";
    target.code = decoded.code;
    if (decoded.userMessage !== undefined) target.userMessage = decoded.userMessage;
    if (decoded.details !== undefined) target.details = decoded.details;
    e.message = decoded.message;
    return true;
  }

  // Same-realm fallback (no contextBridge crossing).
  return e.name === "AppError" && typeof (e as { code?: unknown }).code === "string";
}

/**
 * What to tell the person about an IPC error: the AppError's own words when it
 * has them, its decoded message otherwise, never the `[AppError|…]` wire prefix.
 */
export function clientErrorText(error: unknown, fallback: string): string {
  if (isClientAppError(error)) return error.userMessage ?? error.message;
  return formatErrorMessage(error, fallback);
}

/** An IPC error's AppError code, decoded from the wire prefix; undefined for any other error. */
export function clientErrorCode(error: unknown): string | undefined {
  return isClientAppError(error) ? error.code : undefined;
}
