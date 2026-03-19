import type { SerializedError, IpcSuccessEnvelope, IpcErrorEnvelope } from "../types/ipc/errors.js";

const KNOWN_ERROR_KEYS = new Set([
  "name",
  "message",
  "stack",
  "code",
  "errno",
  "syscall",
  "path",
  "context",
  "cause",
]);

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
  if (typeof err.errno === "number") serialized.errno = err.errno;
  if (typeof err.syscall === "string") serialized.syscall = err.syscall;
  if (typeof err.path === "string") serialized.path = err.path;

  if (err.context !== undefined && typeof err.context === "object" && err.context !== null) {
    serialized.context = err.context as Record<string, unknown>;
  }

  if (err.cause !== undefined && err.cause !== null && typeof err.cause === "object") {
    serialized.cause = serializeError(err.cause, seen);
  }

  const properties: Record<string, unknown> = {};
  let hasProperties = false;
  for (const key of Object.keys(err)) {
    if (KNOWN_ERROR_KEYS.has(key)) continue;
    const val = err[key];
    if (typeof val === "function") continue;
    properties[key] = val;
    hasProperties = true;
  }
  if (hasProperties) serialized.properties = properties;

  return serialized;
}

export function deserializeError(serialized: SerializedError): Error {
  const error = new Error(serialized.message);
  error.name = serialized.name;

  if (serialized.stack !== undefined) error.stack = serialized.stack;
  if (serialized.code !== undefined) (error as NodeJS.ErrnoException).code = serialized.code;
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
  return { __canopyIpcEnvelope: true, ok: true, data };
}

export function wrapError(error: unknown): IpcErrorEnvelope {
  return { __canopyIpcEnvelope: true, ok: false, error: serializeError(error) };
}
