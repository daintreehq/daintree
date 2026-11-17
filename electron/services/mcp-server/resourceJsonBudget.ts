import { MCP_RESPONSE_TEXT_MAX_BYTES } from "../../../shared/config/mcpLimits.js";
import { trySafeSerializeToolResult } from "../../utils/safeSerializeToolResult.js";

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
  originalBytes?: number;
  omitted?: Record<string, number>;
  note?: string;
  payloadOmitted?: true;
}

const TRUNCATION_KEY = "truncated";

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * How many rows, counted from the end `keep` names, fit in `limit` bytes as an
 * array on their own: an upper bound for the search below, so a row too large
 * for any body is serialized here once rather than once per probe.
 */
function rowsWithin(rows: readonly unknown[], keep: JsonArrayTrim["keep"], limit: number): number {
  let total = 2;
  for (let i = 0; i < rows.length; i++) {
    const row = keep === "head" ? rows[i] : rows[rows.length - 1 - i];
    total += byteLength(JSON.stringify(row) ?? "null") + (i > 0 ? 1 : 0);
    if (total > limit) return i;
  }
  return rows.length;
}

/**
 * Serialize a JSON resource body that stays parseable and inside the resource
 * byte cap at any size (#17490).
 *
 * An object body that fits is returned exactly as before; one that only fits
 * without indentation goes out compact and whole. Past that, the `trims` arrays
 * lose rows, the first-listed array the most: each array, last-listed first,
 * keeps as many rows as fit beside the ones already placed. A `truncated` field
 * leads the body with the cap, the whole body's compact size and how many rows
 * each array lost. A body that cannot be shortened that way is replaced by that
 * metadata alone, marked `payloadOmitted`.
 */
export function fitJsonResource(value: unknown, trims: readonly JsonArrayTrim[]): string {
  const limit = MCP_RESPONSE_TEXT_MAX_BYTES;
  if (value === undefined || value === null) return "null";

  const pretty = trySafeSerializeToolResult(value);
  if (pretty === undefined) return omittedEnvelope();
  if (byteLength(pretty) <= limit) return pretty;

  const json: unknown = JSON.parse(pretty);
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
  const kept = new Map<string, number>();

  const render = (): string => {
    const body: Record<string, unknown> = { ...source };
    const omitted: Record<string, number> = {};
    const notes: string[] = [];
    for (const trim of active) {
      const rows = source[trim.key] as unknown[];
      const count = kept.get(trim.key) ?? 0;
      body[trim.key] =
        trim.keep === "head" ? rows.slice(0, count) : rows.slice(rows.length - count);
      if (count < rows.length) {
        omitted[trim.key] = rows.length - count;
        if (trim.note) notes.push(trim.note);
      }
    }
    const truncation: Truncation = {
      maxBytes: limit,
      originalBytes,
      omitted,
      ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
    };
    return JSON.stringify({ [TRUNCATION_KEY]: truncation, ...body });
  };
  const fits = (): boolean => byteLength(render()) <= limit;

  if (active.length === 0) return omittedEnvelope(originalBytes);
  for (const trim of [...active].reverse()) {
    const rows = source[trim.key] as unknown[];
    const reach = rowsWithin(rows, trim.keep, limit);
    // Keeping every row also drops this array's `omitted` entry and note, so
    // the whole array can fit where one row fewer, or none, does not. Below
    // it, every probe carries the same metadata keys, and one more row always
    // costs at least the byte its omitted count's digits can save, so the
    // search's "fits" is monotone in the kept count.
    if (reach === rows.length) {
      kept.set(trim.key, rows.length);
      if (fits()) continue;
    }
    let lo = 0;
    let hi = Math.min(reach, rows.length - 1);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      kept.set(trim.key, mid);
      if (fits()) lo = mid;
      else hi = mid - 1;
    }
    kept.set(trim.key, lo);
  }
  // Every emptied array still carries an `omitted` entry, so even the leanest
  // body can be over; only a measured fit ships.
  const body = render();
  return byteLength(body) <= limit ? body : omittedEnvelope(originalBytes);
}

function omittedEnvelope(originalBytes?: number): string {
  const truncation: Truncation = {
    maxBytes: MCP_RESPONSE_TEXT_MAX_BYTES,
    ...(originalBytes !== undefined ? { originalBytes } : {}),
    payloadOmitted: true,
  };
  return JSON.stringify({ [TRUNCATION_KEY]: truncation });
}
