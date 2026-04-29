import type { AppErrorCode } from "../../shared/types/appError";

/**
 * Renderer-side mirror of the main-process `AppError`. Reconstructed by the
 * preload's `_unwrappingInvoke` when an IPC handler throws an `AppError`, so
 * callers can do `if (isClientAppError(e) && e.code === "BINARY_FILE")` to
 * pattern-match on the discriminated `code` instead of substring-matching
 * `e.message`.
 *
 * `instanceof ClientAppError` is unreliable across the contextBridge realm
 * boundary — use the `isClientAppError` guard, which duck-types on
 * `e.name === "AppError" && typeof e.code === "string"`.
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

/**
 * Realm-safe guard. Returns `true` for any Error whose `name === "AppError"`
 * and which carries a string `code`, regardless of which realm constructed it.
 */
export function isClientAppError(
  e: unknown
): e is Error & { code: AppErrorCode; userMessage?: string } {
  return (
    e instanceof Error &&
    e.name === "AppError" &&
    typeof (e as { code?: unknown }).code === "string"
  );
}
