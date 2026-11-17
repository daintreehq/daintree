import { MCP_RESPONSE_TEXT_MAX_BYTES } from "../../../shared/config/mcpLimits.js";
import {
  safeSerializeToolResult,
  safeSerializeToolResultCompact,
} from "../../utils/safeSerializeToolResult.js";

/** A top-level array an over-budget resource may shorten, and which end survives. */
export interface JsonArrayTrim {
  key: string;
  keep: "head" | "tail";
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Serialize a JSON resource body that stays parseable at any size (#17490).
 *
 * A body that fits is returned exactly as before; one that only fits without
 * indentation goes out compact and whole. Past that, the named arrays lose rows
 * from their far end, in order, until the body fits with a `truncated` field
 * beside them recording the cap, the whole body's compact size and how many
 * rows each array lost. A body that cannot be shortened that way is replaced by
 * that metadata alone, so the reply is always JSON a client can parse.
 */
export function fitJsonResource(
  value: unknown,
  trims: readonly JsonArrayTrim[],
  maxBytes: number = MCP_RESPONSE_TEXT_MAX_BYTES
): string {
  const limit = Math.max(0, Math.floor(maxBytes));
  if (value === undefined || value === null) return "null";
  const pretty = typeof value === "string" ? value : safeSerializeToolResult(value);
  if (byteLength(pretty) <= limit) return pretty;

  const compact = typeof value === "string" ? value : safeSerializeToolResultCompact(value);
  if (byteLength(compact) <= limit) return compact;
  const originalBytes = byteLength(compact);

  let json: unknown;
  try {
    json = JSON.parse(compact);
  } catch {
    json = undefined;
  }

  if (json !== null && typeof json === "object" && !Array.isArray(json)) {
    const source = json as Record<string, unknown>;
    const working: Record<string, unknown> = { ...source };
    const omitted: Record<string, number> = {};
    const render = () =>
      JSON.stringify({ ...working, truncated: { maxBytes: limit, originalBytes, omitted } });

    for (const trim of trims) {
      const rows = source[trim.key];
      if (!Array.isArray(rows) || rows.length === 0) continue;
      const keepRows = (kept: number): string => {
        working[trim.key] = trim.keep === "head" ? rows.slice(0, kept) : rows.slice(rows.length - kept);
        omitted[trim.key] = rows.length - kept;
        return render();
      };
      // Emptying this array is not enough: leave it empty and shorten the next.
      if (byteLength(keepRows(0)) > limit) continue;
      let lo = 0;
      let hi = rows.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (byteLength(keepRows(mid)) <= limit) lo = mid;
        else hi = mid - 1;
      }
      return keepRows(lo);
    }
  }

  const envelope = JSON.stringify({ truncated: { maxBytes: limit, originalBytes } });
  if (byteLength(envelope) <= limit) return envelope;
  return limit >= 4 ? "null" : "";
}
