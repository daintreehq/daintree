/**
 * Inline-strings longer than this collapse to `<string: N chars>` to keep
 * the audit/modal summary compact and to avoid leaking pasted file contents
 * or terminal output.
 */
export const MCP_ARGS_INLINE_STRING_LIMIT = 50;

/** Hard cap on the serialized summary length; longer values are truncated. */
export const MCP_ARGS_SUMMARY_LIMIT = 300;

/**
 * Per-key heuristic for sensitive argument names. Catches short secret
 * values (API keys, bearer tokens, short JWTs) that fit under the 50-char
 * inline limit and would otherwise pass through verbatim. The downstream
 * `scrubSecrets` pass on the serialized summary covers structural patterns
 * (`Bearer ...`, `sk-...`, etc.) but only when the surrounding context is
 * present — a bare value like `"abc123"` keyed under `token` has none.
 *
 * Applies at the single-level summarization site only; nested objects
 * already collapse to `<object>`.
 */
const SENSITIVE_KEY_PATTERN = /(?:token|secret|password|auth|key|credential|bearer|api[_-]?key)/i;

const REDACTED_PLACEHOLDER = "<redacted>";

/**
 * Build a redacted, single-level JSON summary of an MCP tool-call argument
 * blob. Long strings collapse to `<string: N chars>` and nested
 * objects/arrays collapse to `<object>`. The same logic powers the audit
 * record and the renderer-side confirmation modal so both surfaces show
 * identical, never-leaking values.
 *
 * `postSerializeScrub` runs against the serialized JSON before the final
 * `MCP_ARGS_SUMMARY_LIMIT` truncation. The audit-write path passes a
 * `scrubSecrets(sanitizePath(...))` pipeline here so structural secrets
 * (Bearer prefixes, sk-... keys, JWTs) cannot survive a truncation that
 * cuts the token body below the scrubber's minimum match length.
 */
export function summarizeMcpArgs(
  args: unknown,
  postSerializeScrub?: (value: string) => string
): string {
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
  // `undefined` means "this call takes no arguments" and `null` means "the
  // single argument was literally null" — different facts that both used to
  // serialize to the string "null" (`undefined ?? null` is `null`). Consumers
  // treat the summary as display/audit text, so the no-arguments case must be
  // empty: an argument preview gated on `argsSummary.length > 0` was showing a
  // bare `null` to users for every no-argument action (#11299).
  if (args === undefined) {
    return "";
  }
  if (args === null) {
    summary = null;
  } else if (typeof args !== "object" || Array.isArray(args)) {
    summary = summarize(args);
  } else {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
      if (key === "_meta") continue;
      if (SENSITIVE_KEY_PATTERN.test(key) && typeof value === "string" && value.length > 0) {
        out[key] = REDACTED_PLACEHOLDER;
        continue;
      }
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
  if (postSerializeScrub) {
    serialized = postSerializeScrub(serialized);
  }
  if (serialized.length > MCP_ARGS_SUMMARY_LIMIT) {
    return `${serialized.slice(0, MCP_ARGS_SUMMARY_LIMIT - 1)}…`;
  }
  return serialized;
}

/**
 * Hard cap on a persisted tool-call result summary. Generous enough to show
 * a useful slice of a tool's response in the recent-calls popover, bounded
 * so the audit ring buffer (up to 500 records, persisted to config) can't
 * balloon the config file.
 */
export const MCP_RESULT_SUMMARY_LIMIT = 1500;

/**
 * Build a redacted, bounded, pretty-printed JSON summary of a tool-call
 * RESULT for the audit record. Unlike {@link summarizeMcpArgs} this keeps
 * nested structure — the whole point is letting the user inspect what a
 * call returned. Safety comes from three layers: the same sensitive-key
 * redaction the args summary uses (applied at EVERY depth via the stringify
 * replacer, since nesting is preserved here), the post-serialize scrub for
 * structural secrets, and the hard length cap. Scrub runs BEFORE truncation
 * so a cut can't bisect a secret below the scrubber's minimum match length.
 */
export function summarizeMcpResult(
  value: unknown,
  postSerializeScrub?: (value: string) => string
): string {
  const replacer = (key: string, v: unknown): unknown => {
    if (typeof v === "bigint") return `${v.toString()}n`;
    if (SENSITIVE_KEY_PATTERN.test(key) && typeof v === "string" && v.length > 0) {
      return REDACTED_PLACEHOLDER;
    }
    // Individual strings can't usefully exceed the final cap — bound them
    // here so a multi-megabyte payload doesn't balloon the intermediate
    // serialization only to be thrown away by the truncation below. Scrub
    // BEFORE the cap: a slice landing mid-secret would otherwise leave a
    // prefix too short for the structural scrubber to match downstream.
    if (typeof v === "string" && v.length > MCP_RESULT_SUMMARY_LIMIT) {
      const scrubbed = postSerializeScrub ? postSerializeScrub(v) : v;
      return scrubbed.length > MCP_RESULT_SUMMARY_LIMIT
        ? `${scrubbed.slice(0, MCP_RESULT_SUMMARY_LIMIT)}…`
        : scrubbed;
    }
    return v;
  };
  let serialized: string;
  try {
    serialized = JSON.stringify(value, replacer, 2) ?? "null";
  } catch {
    serialized = "<unserializable>";
  }
  if (postSerializeScrub) {
    serialized = postSerializeScrub(serialized);
  }
  if (serialized.length > MCP_RESULT_SUMMARY_LIMIT) {
    const omitted = serialized.length - MCP_RESULT_SUMMARY_LIMIT;
    return `${serialized.slice(0, MCP_RESULT_SUMMARY_LIMIT)}\n… ${omitted} more characters`;
  }
  return serialized;
}
