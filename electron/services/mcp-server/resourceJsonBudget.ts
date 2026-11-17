import { MCP_RESPONSE_TEXT_MAX_BYTES } from "../../../shared/config/mcpLimits.js";
import { safeSerializeToolResult } from "../../utils/safeSerializeToolResult.js";

/**
 * A top-level array an over-budget resource may shorten. `keep` names the end
 * that survives; `note` is added to the metadata when this array loses rows.
 */
export interface JsonArrayTrim {
  key: string;
  keep: "head" | "tail";
  note?: string;
}

interface Truncation {
  maxBytes: number;
  originalBytes: number;
  omitted?: Record<string, number>;
  note?: string;
  payloadOmitted?: true;
}

const TRUNCATION_KEY = "truncated";

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Serialize a JSON resource body that stays parseable and inside the resource
 * byte cap at any size (#17490).
 *
 * A body that fits is returned exactly as before; one that only fits without
 * indentation goes out compact and whole. Past that, the `trims` arrays lose
 * rows, the first-listed array the most: each array, last-listed first, keeps
 * as many rows as fit beside the ones already placed. A `truncated` field leads
 * the body with the cap, the whole body's compact size and how many rows each
 * array lost. A body that cannot be shortened that way is replaced by that
 * metadata alone, marked `payloadOmitted`.
 */
export function fitJsonResource(value: unknown, trims: readonly JsonArrayTrim[]): string {
  const limit = MCP_RESPONSE_TEXT_MAX_BYTES;
  if (value === undefined || value === null) return "null";

  // The safe serializer falls back to `String(value)` when JSON.stringify
  // throws, so its output is only known to be JSON once it parses.
  const pretty = safeSerializeToolResult(value);
  let json: unknown;
  try {
    json = JSON.parse(pretty);
  } catch {
    return omittedEnvelope(byteLength(pretty));
  }
  if (byteLength(pretty) <= limit) return pretty;

  const compact = JSON.stringify(json);
  const originalBytes = byteLength(compact);
  if (originalBytes <= limit) return compact;

  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return omittedEnvelope(originalBytes);
  }
  const source = json as Record<string, unknown>;
  if (Object.hasOwn(source, TRUNCATION_KEY)) return omittedEnvelope(originalBytes);

  const active = trims.filter((trim) => {
    const rows = source[trim.key];
    return Array.isArray(rows) && rows.length > 0;
  });
  const working: Record<string, unknown> = { ...source };
  const omitted: Record<string, number> = {};
  const kept = new Map<string, number>();

  // Every active key stays in `omitted`, and every note stays in, while sizing:
  // with a fixed key set, one more row always costs at least as many bytes as
  // the omitted count's digits can save, so "fits" is monotone in the kept
  // count and a binary search over it is sound.
  const render = (final: boolean): string => {
    for (const trim of active) {
      const rows = source[trim.key] as unknown[];
      const count = kept.get(trim.key) ?? 0;
      working[trim.key] =
        trim.keep === "head" ? rows.slice(0, count) : rows.slice(rows.length - count);
      omitted[trim.key] = rows.length - count;
    }
    const lost = final ? active.filter((trim) => omitted[trim.key]! > 0) : active;
    const notes = lost.flatMap((trim) => (trim.note ? [trim.note] : []));
    const truncation: Truncation = {
      maxBytes: limit,
      originalBytes,
      omitted: Object.fromEntries(lost.map((trim) => [trim.key, omitted[trim.key]!])),
      ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
    };
    return JSON.stringify({ [TRUNCATION_KEY]: truncation, ...working });
  };

  if (active.length === 0 || byteLength(render(false)) > limit) {
    return omittedEnvelope(originalBytes);
  }
  for (const trim of [...active].reverse()) {
    const total = (source[trim.key] as unknown[]).length;
    let lo = 0;
    let hi = total;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      kept.set(trim.key, mid);
      if (byteLength(render(false)) <= limit) lo = mid;
      else hi = mid - 1;
    }
    kept.set(trim.key, lo);
  }
  // Dropping the zero counts and their notes only shrinks what already fit.
  return render(true);
}

function omittedEnvelope(originalBytes: number): string {
  const truncation: Truncation = {
    maxBytes: MCP_RESPONSE_TEXT_MAX_BYTES,
    originalBytes,
    payloadOmitted: true,
  };
  return JSON.stringify({ [TRUNCATION_KEY]: truncation });
}
