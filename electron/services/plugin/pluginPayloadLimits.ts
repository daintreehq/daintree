/**
 * Payload size caps for the plugin transport (invoke args/results, renderer
 * pushes).
 *
 * Dependency-free so the worker-side host proxy can check a push before it
 * crosses the parent port, and main can re-check it without trusting the
 * worker.
 */

export const PLUGIN_PAYLOAD_TOO_LARGE = "PLUGIN_PAYLOAD_TOO_LARGE";

/**
 * Error for a payload over its transport cap. The code is also the message
 * prefix, because only `message` survives `ipcMain.handle` on its way to the
 * renderer — the same convention as `SCHEMA_ERROR:` / `PERMISSION_REQUIRED:`.
 */
export class PluginPayloadTooLargeError extends Error {
  readonly code = PLUGIN_PAYLOAD_TOO_LARGE;

  constructor(
    readonly pluginId: string,
    readonly what: string,
    readonly limitBytes: number
  ) {
    super(
      `${PLUGIN_PAYLOAD_TOO_LARGE}: plugin "${pluginId}" ${what} exceeds the ${limitBytes}-byte limit`
    );
    this.name = "PluginPayloadTooLargeError";
  }
}

export function isPluginPayloadTooLargeError(error: unknown): error is PluginPayloadTooLargeError {
  return error instanceof PluginPayloadTooLargeError;
}

// Fixed per-value costs. Only strings, keys and binary data scale with content,
// and those dominate any payload large enough to matter.
const PRIMITIVE_BYTES = 8;
const CONTAINER_BYTES = 8;

function utf8Length(value: string): number {
  // `byteLength` counts without allocating. The fallback is the UTF-16 → UTF-8
  // worst case, for a runtime with no Buffer.
  return typeof Buffer !== "undefined" ? Buffer.byteLength(value, "utf8") : value.length * 3;
}

/**
 * Estimate the serialized size of a structured-clonable value, in bytes.
 *
 * Strings and object keys count as their UTF-8 byte length (the same unit
 * `parseWorkerToolResult` uses for tool results); binary data counts its
 * `byteLength`; every other leaf and each container costs a small fixed
 * amount. The walk stops as soon as the running total passes `limit`, so an
 * oversize payload costs about `limit` bytes of work, never its full size,
 * and nothing is serialized. Cycles and shared references are counted once,
 * as structured clone transfers them once.
 *
 * Returns the estimate, or a value greater than `limit` once over it.
 */
export function estimatePayloadBytes(value: unknown, limit = Number.POSITIVE_INFINITY): number {
  let total = 0;
  const seen = new Set<object>();
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    switch (typeof current) {
      case "string":
        total += utf8Length(current);
        break;
      case "object": {
        if (current === null) {
          total += 1;
          break;
        }
        if (seen.has(current)) break;
        seen.add(current);
        total += CONTAINER_BYTES;
        if (ArrayBuffer.isView(current) || current instanceof ArrayBuffer) {
          total += current.byteLength;
        } else if (Array.isArray(current)) {
          // Every slot costs at least a byte, so a length over the remaining
          // budget is over the cap without walking it — and a huge sparse
          // array cannot make this loop (or the stack) proportional to it.
          if (total + current.length > limit) return total + current.length;
          for (let i = current.length - 1; i >= 0; i--) stack.push(current[i]);
        } else if (current instanceof Map) {
          for (const [k, v] of current) stack.push(k, v);
        } else if (current instanceof Set) {
          for (const v of current) stack.push(v);
        } else if (!(current instanceof Date) && !(current instanceof RegExp)) {
          for (const key of Object.keys(current)) {
            total += utf8Length(key);
            stack.push((current as Record<string, unknown>)[key]);
          }
        }
        break;
      }
      default:
        total += current === undefined ? 1 : PRIMITIVE_BYTES;
    }
    if (total > limit) return total;
  }
  return total;
}

/**
 * Throw {@link PluginPayloadTooLargeError} when `value` is over `limitBytes`;
 * otherwise return its estimated size so callers can reuse it for metering.
 */
export function assertPayloadWithinLimit(
  pluginId: string,
  what: string,
  value: unknown,
  limitBytes: number
): number {
  const bytes = estimatePayloadBytes(value, limitBytes);
  if (bytes > limitBytes) throw new PluginPayloadTooLargeError(pluginId, what, limitBytes);
  return bytes;
}
