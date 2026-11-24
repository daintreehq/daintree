import { createHash } from "node:crypto";
import { safeSerializeToolResult } from "./safeSerializeToolResult.js";

/**
 * SHA-256 of a UTF-8 string, hex-encoded. Used by the plugin-MCP TOFU pin
 * store and audit log to fingerprint tool descriptions, input schemas, and
 * call arguments without persisting the underlying bytes.
 *
 * Hash inputs MUST be the raw bytes the host received from the plugin's MCP
 * server — pre any cosmetic stripping. Hashing post-strip would let an
 * attacker land a rug-pull payload (invisible Unicode, zero-width spaces,
 * HTML-like sentinel tags) that mutates the raw description without changing
 * the displayed text or the hash. See OWASP MCP03 and the design notes in
 * the consent-store TOFU lookup path.
 */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Deterministic SHA-256 of an MCP-tool-call argument blob. Serialises via
 * `safeSerializeToolResult` so BigInt / Symbol / cycles never throw, then
 * normalises object keys lexicographically at every depth so two structurally
 * identical args produced in different orders hash the same.
 *
 * The hash is forensic linkage only — it ties an audit record to the args the
 * model passed without persisting them. It is intentionally not used for
 * cross-process comparison of "did the user approve these exact args" — that
 * would require pinning the args on the consent record, which the design
 * deliberately avoids (no raw args at rest).
 */
export function stableArgsSha256(args: unknown): string {
  return sha256Hex(safeSerializeToolResult(normalizeKeys(args, new WeakSet<object>(), null, 0)));
}

/**
 * {@link stableArgsSha256}, or `null` when canonicalizing `args` would cost
 * more than `budget`. The budget is metered in roughly the characters of the
 * indented JSON that gets hashed (each value's indent, each key, each string),
 * and charged before anything is sorted or serialized, so a payload that is
 * small to clone but large to canonicalize — deep nesting, many typed-array
 * views over one buffer — is refused after about `budget` units of work.
 * Accepted input hashes exactly as {@link stableArgsSha256} would.
 */
export function boundedStableArgsSha256(args: unknown, budget: number): string | null {
  const meter: Meter = { remaining: budget };
  let normalized: unknown;
  try {
    normalized = normalizeKeys(args, new WeakSet<object>(), meter, 0);
  } catch (error) {
    if (error === OVER_BUDGET) return null;
    throw error;
  }
  return sha256Hex(safeSerializeToolResult(normalized));
}

interface Meter {
  remaining: number;
}

const OVER_BUDGET = new Error("canonical args over budget");

/** `%TypedArray%.prototype.length`, which an own `length` property can't shadow. */
const typedArrayLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  "length"
)!.get!;

function charge(meter: Meter, units: number): void {
  meter.remaining -= units;
  // Negated so a NaN charge stops the walk rather than disabling the meter.
  if (!(meter.remaining >= 0)) throw OVER_BUDGET;
}

/**
 * Sort keys at every depth. With a meter, charge the walk as it goes; without
 * one, read nothing the unmetered digest never read, since those are persisted.
 */
function normalizeKeys(
  value: unknown,
  seen: WeakSet<object>,
  meter: Meter | null,
  depth: number,
  linePrepaid = false
): unknown {
  if (meter !== null) {
    const line = linePrepaid ? 0 : 2 * depth + 1;
    charge(meter, line + (typeof value === "string" ? value.length : 0));
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    // Every slot prints a line at the next indent, holes included, and `map`
    // never visits a hole to charge it, so the lines are paid for up front.
    if (meter !== null) charge(meter, value.length * (2 * depth + 3));
    return value.map((v) => normalizeKeys(v, seen, meter, depth + 1, true));
  }
  // A typed array's indices are its keys: their lines are paid for before
  // they are listed.
  const isTypedArray = ArrayBuffer.isView(value) && !(value instanceof DataView);
  if (meter !== null && isTypedArray) {
    charge(meter, (typedArrayLength.call(value) as number) * (2 * depth + 3));
  }
  const entries = Object.entries(value as Record<string, unknown>);
  // Keys are charged before the sort, which would otherwise be the cost.
  if (meter !== null) for (const [key] of entries) charge(meter, key.length + 1);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out: Record<string, unknown> = {};
  for (const [key, v] of entries) {
    out[key] = normalizeKeys(v, seen, meter, depth + 1, isTypedArray);
  }
  return out;
}
