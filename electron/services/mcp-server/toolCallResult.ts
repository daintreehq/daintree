import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { safeSerializeToolResultCompact } from "../../utils/safeSerializeToolResult.js";

/**
 * Byte ceiling for the text body of a `tools/call` response (#11526).
 *
 * Matches `RESOURCE_TEXT_MAX_BYTES` — resources were already capped here and
 * tool results were not capped at all, so a single call could return 31 MB.
 * Deliberately byte-based rather than token-based: tokenization is a client
 * concern and pinning the server to one vendor's tokenizer would be worse than
 * a conservative fixed bound. 50 KiB of compact JSON lands around 13-25K
 * tokens, comfortably under the 25K-token ceiling clients commonly enforce.
 */
export const TOOL_RESULT_TEXT_MAX_BYTES = 50 * 1024;

/**
 * Advertised to clients that honour it so they don't apply a *smaller* ceiling
 * of their own to an already-bounded response. Equal to the enforced cap, which
 * is honest in both directions: the cap counts UTF-8 bytes and a string never
 * has more characters than bytes, so the response can never exceed this many
 * characters. It describes the model-visible `content` text — per MCP SEP-1624
 * `structuredContent` is for the host app to parse, not for the model context.
 */
const MAX_RESULT_SIZE_CHARS_KEY = "anthropic/maxResultSizeChars";

function buildNotice(shownBytes: number, originalBytes: number): string {
  return (
    `[Tool result truncated: showing ${shownBytes} of ${originalBytes} UTF-8 bytes. ` +
    `The JSON below is incomplete and will not parse. ` +
    `Narrow the arguments (filters, limits, paths) and retry for a complete result.]\n\n`
  );
}

/**
 * Largest cut point at or below `maxBytes` that lands on a UTF-8 character
 * boundary. `Buffer.subarray().toString()` would decode a chopped multi-byte
 * tail into U+FFFD; backing off past continuation bytes (`10xxxxxx`) drops the
 * partial character instead. A UTF-8 sequence is at most 4 bytes, so at most 3
 * continuation bytes can precede the cut.
 */
function utf8BoundaryEnd(buffer: Buffer, maxBytes: number): number {
  if (buffer.length <= maxBytes) return buffer.length;
  let end = maxBytes;
  for (let i = 0; i < 3 && end > 0 && (buffer[end] & 0xc0) === 0x80; i += 1) {
    end -= 1;
  }
  return end;
}

/**
 * Re-derive the structured half from the text half.
 *
 * Measuring only the text would leave `structuredContent` unbounded, because
 * the two are serialized by different code: the text goes through the replacer,
 * which collapses every *repeated* reference — not just genuine cycles — to
 * "[Circular]", while the transport `JSON.stringify`s the raw object and
 * expands each alias in full. A result holding 1,000 references to one 10 KB
 * object serializes to ~23 KB of text (under the cap, so the structured half is
 * kept) and then ships ~10 MB over the wire. Parsing the already-bounded text
 * back keeps the two halves byte-consistent — strengthening the #10676 contract
 * from "same data" to "same bytes" — and bounds them both. It also removes the
 * transport's only unserializable inputs: a truly cyclic or BigInt-bearing
 * result would make the transport's own `JSON.stringify` throw.
 *
 * Returns undefined when the text is not a JSON object — the "OK" body and the
 * serializer's string-coercion fallbacks have no structured form to offer.
 */
function structuredFromText(
  text: string,
  candidate: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!candidate) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON — fall through and omit the structured half.
  }
  return undefined;
}

/**
 * Apply the response budget to an already-serialized text body.
 *
 * Under the cap the text passes through untouched and `structuredContent` (when
 * the caller supplied one) rides along, preserving the #10676 contract that a
 * client can parse either half and get the same data. Over the cap the text is
 * truncated behind a notice and `structuredContent` is dropped.
 *
 * Dropping it is a deliberate protocol trade-off: MCP says the field should be
 * present whenever the tool declares an `outputSchema`, but the only ways to
 * honour that here are to ship the multi-megabyte payload the cap exists to
 * bound — which the client would reject wholesale — or to substitute a
 * truncated object that violates the very schema it claims to satisfy. Omitting
 * it and saying so in the notice is the least-bad option.
 *
 * Truncation never sets `isError`: per MCP that flag means the tool actually
 * failed, and a capped result is a successful call with a shortened body. The
 * caller's own `isError` (a real failure) is passed through untouched.
 */
export function buildToolCallTextResult(
  text: string,
  options: { structuredContent?: Record<string, unknown>; isError?: boolean } = {}
): CallToolResult {
  const { structuredContent, isError } = options;
  const originalBytes = Buffer.byteLength(text, "utf8");

  if (originalBytes <= TOOL_RESULT_TEXT_MAX_BYTES) {
    const structured = structuredFromText(text, structuredContent);
    return {
      content: [{ type: "text", text }],
      ...(structured ? { structuredContent: structured } : {}),
      ...(isError ? { isError } : {}),
      _meta: { [MAX_RESULT_SIZE_CHARS_KEY]: TOOL_RESULT_TEXT_MAX_BYTES },
    };
  }

  // The notice states how many bytes survived, but its own length changes the
  // budget it is describing. Size it against the cap first — the real count is
  // always below the cap, so it can never need more digits than this placeholder
  // and the rebuilt notice can only be shorter. That keeps the total provably
  // within the cap without a second pass.
  const noticeBytes = Buffer.byteLength(
    buildNotice(TOOL_RESULT_TEXT_MAX_BYTES, originalBytes),
    "utf8"
  );
  const budget = Math.max(0, TOOL_RESULT_TEXT_MAX_BYTES - noticeBytes);
  const buffer = Buffer.from(text, "utf8");
  const shown = buffer.subarray(0, utf8BoundaryEnd(buffer, budget)).toString("utf8");

  // Notice first, not appended: a client that trims the tail again would cut a
  // trailing marker off and leave the model reading incomplete JSON as complete.
  return {
    content: [
      { type: "text", text: `${buildNotice(Buffer.byteLength(shown, "utf8"), originalBytes)}${shown}` },
    ],
    ...(isError ? { isError } : {}),
    _meta: { [MAX_RESULT_SIZE_CHARS_KEY]: TOOL_RESULT_TEXT_MAX_BYTES },
  };
}

/**
 * Build a `tools/call` success response from a raw action result: compact-
 * serialize it, then apply the budget.
 *
 * `structuredContent` is a parameter rather than something this module derives,
 * so each call site keeps its existing policy — the generic dispatch path gates
 * on `buildStructuredContent`'s output schema check while the main-process
 * short-circuits attach theirs unconditionally.
 */
export function buildToolCallResult(
  value: unknown,
  options: { structuredContent?: Record<string, unknown> } = {}
): CallToolResult {
  const text = value !== undefined && value !== null ? safeSerializeToolResultCompact(value) : "OK";
  return buildToolCallTextResult(text, options);
}
