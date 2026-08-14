import { isErrorLike, serializeError } from "./ipcErrorSerialization.js";

/**
 * Depth bound for the Error scan over a log context. Mirrors the main-process
 * logger's `MAX_REDACT_DEPTH` — anything deeper is replaced with a
 * `"[MaxDepth]"` sentinel by `redactSensitiveData` before it is retained, so
 * normalizing past this point produces nothing a reader ever sees. The two
 * constants are deliberately independent (each carries its own rationale); if
 * they ever drift, the only effect is an Error at the exact boundary being
 * flattened but then depth-clamped, or vice versa.
 */
const MAX_ERROR_SCAN_DEPTH = 5;

const CIRCULAR = "[Circular]";

/**
 * Flatten an Error for a log context, never throwing.
 *
 * `serializeError` reads `name`/`message`/`stack` and walks own properties; an
 * Error subclass exposing a throwing getter (or a Proxy) would propagate out of
 * whatever the caller was logging about. A log call must never become the
 * failure it was reporting, so a serialization failure degrades to a fixed
 * record. The fallback message is a constant on purpose — every way of
 * describing the offending value (`String(error)`, `error.name`,
 * `error.constructor`) re-enters the same hostile accessor.
 */
function serializeErrorForLog(error: unknown): Record<string, unknown> {
  try {
    return serializeError(error) as unknown as Record<string, unknown>;
  } catch {
    return { name: "Error", message: "[unserializable error]" };
  }
}

/**
 * True for objects that are safe to walk as log-context records: plain objects,
 * null-prototype objects, and plain objects built in another realm (whose
 * `Object.prototype` is not this realm's, so an identity check would reject
 * them). Everything with a longer prototype chain — `Date`, `Map`, `Set`,
 * class instances — is left alone, since rewriting it would invent a wire shape
 * the loggers never had.
 */
function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

/** Depth-bounded scan for an Error anywhere in the context. */
function containsError(value: unknown, depth: number, seen: WeakSet<object>): boolean {
  if (value === null || typeof value !== "object") return false;
  if (isErrorLike(value)) return true;
  if (depth >= MAX_ERROR_SCAN_DEPTH) return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((item) => containsError(item, depth + 1, seen));
  }
  if (!isPlainRecord(value)) return false;

  for (const child of Object.values(value as Record<string, unknown>)) {
    if (containsError(child, depth + 1, seen)) return true;
  }
  return false;
}

/**
 * Clone the bounded graph, replacing every Error with its flattened record.
 *
 * `memo` doubles as the cycle guard: a node maps to `CIRCULAR` while its own
 * subtree is still being built, then to its finished clone. A back-edge into an
 * in-progress node therefore yields the sentinel (keeping the result acyclic
 * and structured-clone-safe), while a second, sibling reference to an already
 * finished node reuses the same clone instead of being mistaken for a cycle.
 */
function cloneWithErrors(value: unknown, depth: number, memo: Map<object, unknown>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (isErrorLike(value)) return serializeErrorForLog(value);
  if (depth >= MAX_ERROR_SCAN_DEPTH) return value;

  const existing = memo.get(value);
  if (existing !== undefined) return existing;

  if (Array.isArray(value)) {
    memo.set(value, CIRCULAR);
    const cloned = value.map((item) => cloneWithErrors(item, depth + 1, memo));
    memo.set(value, cloned);
    return cloned;
  }

  if (!isPlainRecord(value)) return value;

  memo.set(value, CIRCULAR);
  const cloned: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    cloned[key] = cloneWithErrors(child, depth + 1, memo);
  }
  memo.set(value, cloned);
  return cloned;
}

/**
 * Replace every `Error` found inside a log context with a plain, serializable
 * record of its `name`/`message`/`stack` (plus whatever else `serializeError`
 * promotes).
 *
 * An `Error`'s `name`, `message` and `stack` are non-enumerable, so anything
 * that walks own-enumerable properties — `JSON.stringify`, the main logger's
 * `redactSensitiveData`, and Electron's `contextBridge` cloner — reduces it to
 * `{}`. That silently erased the only record of a failure for every caller that
 * passed an Error inside a context object rather than through `logError`'s
 * dedicated argument (#11777).
 *
 * The caller's object is never mutated. When the context holds no Error — the
 * overwhelmingly common case on a path that runs hundreds of times a second —
 * the original reference is returned and nothing is copied.
 */
export function normalizeErrorsInLogContext<T extends Record<string, unknown>>(context: T): T {
  try {
    if (!containsError(context, 0, new WeakSet())) return context;
    return cloneWithErrors(context, 0, new Map()) as T;
  } catch {
    // Walking invokes getters on caller-supplied objects. A throwing one must
    // cost the log its Error details, not the log itself.
    return context;
  }
}
