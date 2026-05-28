import { createHash } from "node:crypto";
import { safeSerializeToolResult } from "../services/mcp-server/shared.js";

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
  const seen = new WeakSet<object>();
  return sha256Hex(safeSerializeToolResult(normalizeKeys(args, seen)));
}

function normalizeKeys(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => normalizeKeys(v, seen));
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  const out: Record<string, unknown> = {};
  for (const [key, v] of entries) out[key] = normalizeKeys(v, seen);
  return out;
}
