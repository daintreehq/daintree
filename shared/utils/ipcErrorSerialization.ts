import type { SerializedError, IpcSuccessEnvelope, IpcErrorEnvelope } from "../types/ipc/errors.js";

const KNOWN_ERROR_KEYS = new Set([
  "name",
  "message",
  "stack",
  "code",
  "userMessage",
  "gitReason",
  "reason",
  "leaseSha",
  "branchName",
  "errno",
  "syscall",
  "path",
  "context",
  "cause",
  "errors",
]);

// `Error.isError` recognizes an Error across realm boundaries, where
// `instanceof` fails because each realm has its own `Error.prototype`. Values
// reaching a logger or an IPC boundary have often already crossed one (a
// utility process, the preload's isolated world), so `instanceof` alone
// under-detects. Captured once and feature-checked — the project targets
// runtimes where it exists, but a stale one must not break serialization.
const nativeIsError = (Error as unknown as { isError?: (value: unknown) => boolean }).isError;

/**
 * True when `value` is an Error, including one constructed in another realm.
 *
 * Never throws. `instanceof` runs a Proxy's `getPrototypeOf` trap, so a hostile
 * or merely unusual context value could otherwise turn a log call into the
 * exception it was reporting. The native check is tried first because it reads
 * an internal slot without invoking traps; `instanceof` still runs after it as
 * the fallback, since it is the only one that sees a Proxy wrapping an Error.
 */
export function isErrorLike(value: unknown): value is Error {
  if (typeof nativeIsError === "function" && nativeIsError(value)) return true;
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function sanitizeCloneValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null) return null;

  const valueType = typeof value;
  if (
    valueType === "string" ||
    valueType === "number" ||
    valueType === "boolean" ||
    valueType === "bigint"
  ) {
    return value;
  }

  if (valueType === "undefined" || valueType === "function" || valueType === "symbol") {
    return undefined;
  }

  if (isErrorLike(value)) {
    return serializeError(value, seen);
  }

  if (typeof value !== "object") {
    return String(value);
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => {
      const sanitized = sanitizeCloneValue(item, seen);
      return sanitized === undefined ? null : sanitized;
    });
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return String(value);
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const sanitized = sanitizeCloneValue(child, seen);
    if (sanitized !== undefined) {
      result[key] = sanitized;
    }
  }
  return result;
}

export function serializeError(error: unknown, seen = new WeakSet<object>()): SerializedError {
  if (error === null || error === undefined) {
    return { name: "Error", message: String(error) };
  }

  if (typeof error !== "object") {
    return { name: "Error", message: String(error) };
  }

  if (seen.has(error)) {
    return { name: "Error", message: "[Circular]" };
  }
  seen.add(error);

  const err = error as Record<string, unknown>;
  const serialized: SerializedError = {
    name: typeof err.name === "string" ? err.name : "Error",
    message: typeof err.message === "string" ? err.message : String(error),
  };

  if (typeof err.stack === "string") serialized.stack = err.stack;
  if (typeof err.code === "string") serialized.code = err.code;
  if (typeof err.userMessage === "string") serialized.userMessage = err.userMessage;
  // GitOperationError exposes `reason`; promote to a top-level `gitReason`
  // field on the wire so it survives the packaged-build strip.
  if (typeof err.gitReason === "string") {
    serialized.gitReason = err.gitReason as SerializedError["gitReason"];
  } else if (typeof err.reason === "string") {
    serialized.gitReason = err.reason as SerializedError["gitReason"];
  }
  if (typeof err.leaseSha === "string") serialized.leaseSha = err.leaseSha;
  if (typeof err.branchName === "string") serialized.branchName = err.branchName;
  if (typeof err.errno === "number") serialized.errno = err.errno;
  if (typeof err.syscall === "string") serialized.syscall = err.syscall;
  if (typeof err.path === "string") serialized.path = err.path;

  if (err.context !== undefined && typeof err.context === "object" && err.context !== null) {
    const context = sanitizeCloneValue(err.context, seen);
    if (context !== undefined && typeof context === "object" && context !== null) {
      serialized.context = context as Record<string, unknown>;
    }
  }

  if (err.cause !== undefined && err.cause !== null && typeof err.cause === "object") {
    serialized.cause = serializeError(err.cause, seen);
  }

  const properties: Record<string, unknown> = {};
  let hasProperties = false;

  // `AggregateError.prototype.errors` is an own but NON-enumerable property, so
  // the `Object.keys` walk below never reaches it and every aggregated failure
  // would be dropped. Handled here (and listed in `KNOWN_ERROR_KEYS` so the
  // walk skips it) because `sanitizeCloneValue` shares the `seen` set — a
  // second visit to the same array would serialize as "[Circular]". Carried in
  // the `properties` bag rather than a new top-level field so `SerializedError`
  // and the packaged-build strip in `electron/setup/security.ts` are unchanged.
  // Read once: a getter could answer differently on a second access, and
  // `sanitizeCloneValue` shares `seen`, so a second visit to the same array
  // would serialize as "[Circular]".
  const aggregateMembers = err.errors;
  if (aggregateMembers !== undefined) {
    const aggregated = sanitizeCloneValue(aggregateMembers, seen);
    if (aggregated !== undefined) {
      properties.errors = aggregated;
      hasProperties = true;
    }
  }

  for (const key of Object.keys(err)) {
    if (KNOWN_ERROR_KEYS.has(key)) continue;
    const val = err[key];
    const sanitized = sanitizeCloneValue(val, seen);
    if (sanitized !== undefined) {
      properties[key] = sanitized;
      hasProperties = true;
    }
  }
  if (hasProperties) serialized.properties = properties;

  return serialized;
}

export function deserializeError(serialized: SerializedError): Error {
  const error = new Error(serialized.message);
  error.name = serialized.name;

  if (serialized.stack !== undefined) error.stack = serialized.stack;
  if (serialized.code !== undefined) (error as NodeJS.ErrnoException).code = serialized.code;
  if (serialized.userMessage !== undefined) {
    (error as unknown as Record<string, unknown>).userMessage = serialized.userMessage;
  }
  if (serialized.gitReason !== undefined) {
    (error as unknown as Record<string, unknown>).gitReason = serialized.gitReason;
  }
  if (serialized.leaseSha !== undefined) {
    (error as unknown as Record<string, unknown>).leaseSha = serialized.leaseSha;
  }
  if (serialized.branchName !== undefined) {
    (error as unknown as Record<string, unknown>).branchName = serialized.branchName;
  }
  if (serialized.correlationId !== undefined) {
    (error as unknown as Record<string, unknown>).correlationId = serialized.correlationId;
  }
  if (serialized.errno !== undefined) (error as NodeJS.ErrnoException).errno = serialized.errno;
  if (serialized.syscall !== undefined)
    (error as NodeJS.ErrnoException).syscall = serialized.syscall;
  if (serialized.path !== undefined) (error as NodeJS.ErrnoException).path = serialized.path;

  if (serialized.context !== undefined) {
    (error as unknown as Record<string, unknown>).context = serialized.context;
  }

  if (serialized.cause !== undefined) {
    error.cause = deserializeError(serialized.cause);
  }

  if (serialized.properties !== undefined) {
    for (const [key, val] of Object.entries(serialized.properties)) {
      (error as unknown as Record<string, unknown>)[key] = val;
    }
  }

  return error;
}

export function wrapSuccess<T>(data: T): IpcSuccessEnvelope<T> {
  return { __daintreeIpcEnvelope: true, ok: true, data };
}

export function wrapError(error: unknown): IpcErrorEnvelope {
  return { __daintreeIpcEnvelope: true, ok: false, error: serializeError(error) };
}
