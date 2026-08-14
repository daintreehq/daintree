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
export function serializeErrorForLog(error: unknown): Record<string, unknown> {
  try {
    return serializeError(error) as unknown as Record<string, unknown>;
  } catch {
    return degradedErrorRecord(error);
  }
}

/** Read one field of a hostile object without letting its accessor escape. */
function readString(source: unknown, key: string): string | undefined {
  try {
    const value = (source as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Last resort when full serialization threw. Each remaining field is read under
 * its own guard, so one hostile accessor costs only its own value rather than
 * the whole record — a single unreadable frame in an `AggregateError` should not
 * erase the message that says what failed.
 */
function degradedErrorRecord(error: unknown): Record<string, unknown> {
  return {
    name: readString(error, "name") ?? "Error",
    message: readString(error, "message") ?? "[unserializable error]",
  };
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

/**
 * Depth-bounded scan for an Error anywhere in the context.
 *
 * `scanned` records the shallowest depth each node was reached at, rather than
 * merely that it was reached. How much of a subtree fits inside the budget
 * depends on the path taken, so a node first reached deeply — and cut off
 * before its Error came into view — has to be scanned again when an aliased,
 * shallower path reaches it with budget to spare. A plain visited-set would
 * report "no Error" for a context that plainly has one.
 */
function containsError(value: unknown, depth: number, scanned: Map<object, number>): boolean {
  if (value === null || typeof value !== "object") return false;
  if (isErrorLike(value)) return true;
  if (depth >= MAX_ERROR_SCAN_DEPTH) return false;

  const scannedAt = scanned.get(value);
  if (scannedAt !== undefined && scannedAt <= depth) return false;
  scanned.set(value, depth);

  if (Array.isArray(value)) {
    return value.some((item) => containsError(item, depth + 1, scanned));
  }
  if (!isPlainRecord(value)) return false;

  for (const child of Object.values(value as Record<string, unknown>)) {
    if (containsError(child, depth + 1, scanned)) return true;
  }
  return false;
}

interface CloneEntry {
  /** Shallowest depth this node has been cloned at. */
  depth: number;
  /** `CIRCULAR` while the subtree is still being built, then the finished clone. */
  result: unknown;
}

/**
 * Clone the bounded graph, replacing every Error with its flattened record.
 *
 * `memo` is the cycle guard as well as the alias table: a node maps to
 * `CIRCULAR` while its own subtree is still being built, then to its finished
 * clone. A back-edge into an in-progress node therefore yields the sentinel
 * (keeping the result acyclic, so it survives `JSON.stringify` and the
 * contextBridge), while a sibling reference to an already finished node reuses
 * the same clone instead of being mistaken for a cycle.
 *
 * Entries are keyed by depth for the same reason `containsError` is: a clone
 * built under a deeper path's budget is truncated, so it must not be handed
 * back to a shallower path that could have reached further. Depth strictly
 * increases along any single path, so a genuine back-edge always compares as
 * deeper and still resolves to the sentinel — the recursion terminates.
 */
function cloneWithErrors(value: unknown, depth: number, memo: Map<object, CloneEntry>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (isErrorLike(value)) return serializeErrorForLog(value);
  if (depth >= MAX_ERROR_SCAN_DEPTH) return value;

  const existing = memo.get(value);
  if (existing !== undefined && existing.depth <= depth) return existing.result;

  if (Array.isArray(value)) {
    memo.set(value, { depth, result: CIRCULAR });
    const cloned = value.map((item) => cloneWithErrors(item, depth + 1, memo));
    memo.set(value, { depth, result: cloned });
    return cloned;
  }

  if (!isPlainRecord(value)) return value;

  memo.set(value, { depth, result: CIRCULAR });
  const cloned: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    cloned[key] = cloneWithErrors(child, depth + 1, memo);
  }
  memo.set(value, { depth, result: cloned });
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
 * the original reference is returned and nothing is cloned.
 *
 * "Anywhere" means anywhere the loggers themselves look: plain records and
 * arrays. An Error held as a field of a `Date`, `Map`, class instance or other
 * exotic object is left alone, because rewriting those would invent a wire
 * shape the loggers never had and would run caller code to do it.
 */
export function normalizeErrorsInLogContext<T extends Record<string, unknown>>(context: T): T {
  try {
    if (!containsError(context, 0, new Map())) return context;
    return cloneWithErrors(context, 0, new Map()) as T;
  } catch {
    // Walking invokes getters on caller-supplied objects. A throwing one must
    // cost the log its Error details, not the log itself.
    return context;
  }
}
