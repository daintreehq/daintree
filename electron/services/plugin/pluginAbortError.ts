/**
 * Normalize an aborted signal's reason into an `Error` for rejection. A reason
 * that is already an `Error` comes back unchanged — Node's default, a
 * `DOMException` named `AbortError`, and a caller's own (a timeout, an unload)
 * alike. Anything else (`abort("why")`, `abort(42)`) is wrapped in an `Error`
 * named `AbortError`, so a rejection is always an `Error`.
 *
 * Pure and dependency-free so the worker-side proxy can share it without
 * pulling main-process modules into the worker bundle.
 */
export function abortErrorFor(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === "string" ? reason : "The operation was aborted");
  err.name = "AbortError";
  return err;
}
