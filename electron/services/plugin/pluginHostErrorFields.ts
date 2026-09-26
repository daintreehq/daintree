/**
 * The error fields a plugin is promised on a failed host call. An allowlist
 * rather than "every primitive": a host error with a redacted message could
 * still carry a path or token as an own property, and the contract only ever
 * needed the machine-readable code and the conflict revision.
 */
const FORWARDED_FIELDS = ["code", "currentRevision"] as const;
const MAX_STRING_LENGTH = 1024;

type ErrorFields = Record<string, string | number | boolean>;

/**
 * The forwardable fields of a host error, in a shape that survives structured
 * clone. Never throws: this runs while the bridge is already reporting a
 * failure, and a throwing getter must not turn that report into a torn-down
 * worker. Undefined when there is nothing worth sending.
 */
export function serializableErrorFields(error: unknown): ErrorFields | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const fields: ErrorFields = {};
  let count = 0;
  for (const key of FORWARDED_FIELDS) {
    let value: unknown;
    try {
      value = (error as Record<string, unknown>)[key];
    } catch {
      continue;
    }
    if (typeof value === "string") {
      if (value.length > MAX_STRING_LENGTH) continue;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) continue;
    } else if (typeof value !== "boolean") {
      continue;
    }
    fields[key] = value;
    count++;
  }
  return count > 0 ? fields : undefined;
}

/** Rebuild a host error in the worker with the fields the host attached to it. */
export function errorWithFields(message: string, fields: ErrorFields | undefined): Error {
  const error = new Error(message);
  if (!fields || typeof fields !== "object") return error;
  for (const key of FORWARDED_FIELDS) {
    if (!Object.hasOwn(fields, key)) continue;
    const value = fields[key];
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      continue;
    }
    Object.defineProperty(error, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return error;
}
