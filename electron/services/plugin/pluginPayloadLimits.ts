/**
 * Payload size caps for the plugin transport (invoke args/results, renderer
 * pushes).
 *
 * Free of Electron and service dependencies so the worker-side host proxy can check a push before it
 * crosses the parent port, and main can re-check it without trusting the
 * worker.
 */

import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";

export const PLUGIN_PAYLOAD_TOO_LARGE = "PLUGIN_PAYLOAD_TOO_LARGE";

/**
 * Error for a payload over its transport cap. The code is also the message
 * prefix, because only `message` survives `ipcMain.handle` on its way to the
 * renderer — the same convention as `SCHEMA_ERROR:` / `PERMISSION_REQUIRED:`.
 */
export class PluginPayloadTooLargeError extends Error {
  readonly code = PLUGIN_PAYLOAD_TOO_LARGE;

  /**
   * @param observedBytes What the estimator had counted when it stopped. The
   *   walk exits as soon as it passes the limit, so this is a lower bound on
   *   the payload's size, not its full size.
   */
  constructor(
    readonly pluginId: string,
    readonly what: string,
    readonly limitBytes: number,
    readonly observedBytes?: number
  ) {
    super(
      `${PLUGIN_PAYLOAD_TOO_LARGE}: plugin "${pluginId}" ${what} exceeds the ${limitBytes}-byte limit` +
        (observedBytes !== undefined ? ` (at least ${observedBytes} bytes)` : "")
    );
    this.name = "PluginPayloadTooLargeError";
  }
}

export function isPluginPayloadTooLargeError(error: unknown): error is PluginPayloadTooLargeError {
  return error instanceof PluginPayloadTooLargeError;
}

export const PLUGIN_PAYLOAD_UNCLONEABLE = "PLUGIN_PAYLOAD_UNCLONEABLE";

/**
 * Error for a payload structured clone refuses (a function, a symbol, a class
 * with internal slots IPC cannot carry). Prefixed like
 * {@link PluginPayloadTooLargeError}, for the same reason.
 */
export class PluginPayloadUncloneableError extends Error {
  readonly code = PLUGIN_PAYLOAD_UNCLONEABLE;

  constructor(
    readonly pluginId: string,
    readonly what: string,
    reason: string
  ) {
    super(
      `${PLUGIN_PAYLOAD_UNCLONEABLE}: plugin "${pluginId}" ${what} cannot be cloned: ${reason}`
    );
    this.name = "PluginPayloadUncloneableError";
  }
}

/**
 * A structured-clone snapshot of `value`, taken now so later mutation by the
 * caller cannot change what is delivered, or {@link PluginPayloadUncloneableError}
 * when structured clone refuses it. Callers size-check first, so the clone is
 * bounded by the same cap.
 */
export function snapshotPayload<T>(pluginId: string, what: string, value: T): T {
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol") {
      throw new PluginPayloadUncloneableError(pluginId, what, `a ${typeof value} is not clonable`);
    }
    return value;
  }
  try {
    return structuredClone(value);
  } catch (err) {
    const reason = formatErrorMessage(err, "structured clone failed");
    throw new PluginPayloadUncloneableError(pluginId, what, reason.slice(0, 200));
  }
}

// Fixed per-value costs. Only strings, keys, binary data and big BigInts scale
// with content, and those dominate any payload large enough to matter.
const PRIMITIVE_BYTES = 8;
const CONTAINER_BYTES = 8;

/**
 * UTF-8 size of `value`, or its UTF-16 length when that alone is over
 * `remaining`. UTF-8 is never shorter than the UTF-16 length (a surrogate pair
 * is two units and four bytes), so a string longer than the budget is over it
 * without scanning. Otherwise the exact count scans at most `remaining` code
 * units, and every scanned unit is charged at least a byte, so the scans of a
 * whole walk add up to O(limit).
 */
function stringBytes(value: string, remaining: number): number {
  const units = value.length;
  if (units > remaining) return units;
  // `byteLength` counts without allocating. The fallback is the UTF-16 → UTF-8
  // worst case, for a runtime with no Buffer.
  return typeof Buffer !== "undefined" ? Buffer.byteLength(value, "utf8") : units * 3;
}

/**
 * Serialized size of a BigInt's magnitude. `BigInt.asIntN` answers "does it fit
 * in N bits" while allocating at most N bits, so a BigInt far over the budget
 * is refused without materialising its digits; one within it is measured.
 */
function bigintBytes(value: bigint, remaining: number): number {
  if (Number.isFinite(remaining)) {
    const bits = Math.max(64, Math.floor(remaining) * 8 + 8);
    if (BigInt.asIntN(bits, value) !== value) return remaining + 1;
  }
  const hexDigits = (value < 0n ? -value : value).toString(16).length;
  return PRIMITIVE_BYTES + Math.ceil(hexDigits / 2);
}

function* arrayItems(array: readonly unknown[]): Generator<unknown> {
  for (let i = 0; i < array.length; i++) yield array[i];
}

function* mapItems(map: ReadonlyMap<unknown, unknown>): Generator<unknown> {
  for (const [key, value] of map) {
    yield key;
    yield value;
  }
}

/**
 * Own enumerable keys and their values, one at a time. `for…in` rather than
 * `Object.keys` so an object with a million keys is not first copied into a
 * million-entry array the walk abandons a few thousand keys in.
 */
function* ownEntries(object: object, skip?: ReadonlySet<string>): Generator<unknown> {
  for (const key in object) {
    // Own keys enumerate before inherited ones, and structured clone copies
    // only own keys, so the first inherited key ends the walk — a large
    // enumerable prototype must not make it unbounded.
    if (!Object.prototype.hasOwnProperty.call(object, key)) return;
    if (skip?.has(key)) continue;
    yield key;
    yield (object as Record<string, unknown>)[key];
  }
}

const ERROR_FIELDS: ReadonlySet<string> = new Set(["name", "message", "stack", "cause"]);

/**
 * An Error's clonable content. `message` and `stack` are own but
 * non-enumerable, so a plain key walk would count a 10 MB message as nothing;
 * they, `name` and `cause` are charged explicitly, then any enumerable extras.
 */
function* errorItems(error: Error): Generator<unknown> {
  yield error.name;
  yield error.message;
  yield error.stack;
  if ("cause" in error) yield error.cause;
  yield* ownEntries(error, ERROR_FIELDS);
}

function isErrorValue(value: object): value is Error {
  return value instanceof Error || Object.prototype.toString.call(value) === "[object Error]";
}

/**
 * Estimate the serialized size of a structured-clonable value, in bytes.
 *
 * Strings and object keys count as their UTF-8 byte length (the same unit
 * `parseWorkerToolResult` uses for tool results); binary data counts its
 * `byteLength`; Errors count their name, message, stack and cause; RegExps
 * their source and flags; BigInts their magnitude; every other leaf and each
 * container costs a small fixed amount.
 *
 * The work is O(min(size, limit)): containers are walked lazily, one child at
 * a time, and the budget is checked after every child, so an oversize payload
 * costs about `limit` bytes of work however large it is. A container whose
 * entry count alone is over the remaining budget, or a string whose length
 * is, is refused without being walked. Nothing is serialized. Cycles and shared
 * references are counted once, as structured clone transfers them once.
 *
 * Returns the estimate, or a value greater than `limit` once over it.
 */
export function estimatePayloadBytes(value: unknown, limit = Number.POSITIVE_INFINITY): number {
  let total = 0;
  const seen = new Set<object>();
  const stack: Iterator<unknown>[] = [];

  const visit = (current: unknown): void => {
    switch (typeof current) {
      case "string":
        total += stringBytes(current, limit - total);
        return;
      case "bigint":
        total += bigintBytes(current, limit - total);
        return;
      case "undefined":
        total += 1;
        return;
      case "object":
        break;
      default:
        total += PRIMITIVE_BYTES;
        return;
    }
    if (current === null) {
      total += 1;
      return;
    }
    if (seen.has(current)) return;
    seen.add(current);
    total += CONTAINER_BYTES;
    if (ArrayBuffer.isView(current)) {
      // Structured clone copies a view's whole backing buffer, not just the
      // window it exposes; a buffer shared by several views is copied once.
      const backing = current.buffer;
      if (!seen.has(backing)) {
        seen.add(backing);
        total += backing.byteLength;
      }
    } else if (
      current instanceof ArrayBuffer ||
      (typeof SharedArrayBuffer !== "undefined" && current instanceof SharedArrayBuffer)
    ) {
      total += current.byteLength;
    } else if (Array.isArray(current)) {
      // Every slot costs at least a byte, so a length over the remaining
      // budget is over the cap without walking it — a huge sparse array cannot
      // make this walk proportional to its length.
      if (current.length > limit - total) {
        total += current.length;
        return;
      }
      stack.push(arrayItems(current));
    } else if (current instanceof Map) {
      if (current.size * 2 > limit - total) {
        total += current.size * 2;
        return;
      }
      stack.push(mapItems(current));
    } else if (current instanceof Set) {
      if (current.size > limit - total) {
        total += current.size;
        return;
      }
      stack.push(current.values());
    } else if (current instanceof RegExp) {
      total += stringBytes(current.source, limit - total);
      total += current.flags.length;
    } else if (current instanceof Date) {
      total += PRIMITIVE_BYTES;
    } else if (current instanceof String) {
      total += stringBytes(current.valueOf(), limit - total);
    } else if (current instanceof Number || current instanceof Boolean) {
      total += PRIMITIVE_BYTES;
    } else if (isErrorValue(current)) {
      stack.push(errorItems(current));
    } else {
      stack.push(ownEntries(current));
    }
  };

  visit(value);
  while (stack.length > 0 && total <= limit) {
    const next = stack[stack.length - 1]!.next();
    if (next.done) stack.pop();
    else visit(next.value);
  }
  return total;
}

/**
 * Throw {@link PluginPayloadTooLargeError} when `value` is over `limitBytes`,
 * or {@link PluginPayloadUncloneableError} when reading it throws; otherwise
 * return its estimated size so callers can reuse it for metering.
 */
export function assertPayloadWithinLimit(
  pluginId: string,
  what: string,
  value: unknown,
  limitBytes: number
): number {
  let bytes: number;
  try {
    bytes = estimatePayloadBytes(value, limitBytes);
  } catch (err) {
    // Only a throwing getter or a hostile Proxy gets here, and structured
    // clone would fail on the same read; name it rather than leak it raw.
    throw new PluginPayloadUncloneableError(
      pluginId,
      what,
      formatErrorMessage(err, "reading the payload failed").slice(0, 200)
    );
  }
  if (bytes > limitBytes) throw new PluginPayloadTooLargeError(pluginId, what, limitBytes, bytes);
  return bytes;
}
