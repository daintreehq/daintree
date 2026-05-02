/**
 * Inline-strings longer than this collapse to `<string: N chars>` to keep
 * the audit/modal summary compact and to avoid leaking pasted file contents
 * or terminal output.
 */
export const MCP_ARGS_INLINE_STRING_LIMIT = 50;

/** Hard cap on the serialized summary length; longer values are truncated. */
export const MCP_ARGS_SUMMARY_LIMIT = 300;

/**
 * Build a redacted, single-level JSON summary of an MCP tool-call argument
 * blob. Long strings collapse to `<string: N chars>` and nested
 * objects/arrays collapse to `<object>`. The same logic powers the audit
 * record and the renderer-side confirmation modal so both surfaces show
 * identical, never-leaking values.
 */
export function summarizeMcpArgs(args: unknown): string {
  const summarize = (value: unknown): unknown => {
    if (value === null) return null;
    if (typeof value === "string") {
      return value.length > MCP_ARGS_INLINE_STRING_LIMIT
        ? `<string: ${value.length} chars>`
        : value;
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      return typeof value === "bigint" ? `${value.toString()}n` : value;
    }
    if (typeof value === "undefined") return undefined;
    return "<object>";
  };

  let summary: unknown;
  if (args === undefined || args === null) {
    summary = args ?? null;
  } else if (typeof args !== "object" || Array.isArray(args)) {
    summary = summarize(args);
  } else {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
      if (key === "_meta") continue;
      const reduced = summarize(value);
      if (reduced !== undefined) {
        out[key] = reduced;
      }
    }
    summary = out;
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(summary) ?? "";
  } catch {
    serialized = "<unserializable>";
  }
  if (serialized.length > MCP_ARGS_SUMMARY_LIMIT) {
    return `${serialized.slice(0, MCP_ARGS_SUMMARY_LIMIT - 1)}…`;
  }
  return serialized;
}
