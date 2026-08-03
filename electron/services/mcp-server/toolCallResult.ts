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
 * Nesting ceiling for the structured half.
 *
 * V8's `JSON.stringify` recurses per level, so whether a deep value survives
 * depends on the stack headroom wherever it happens to be called: a 10,000-deep
 * result stringifies fine on its own and then throws `RangeError` inside the
 * transport, which wraps it in the JSON-RPC envelope one frame further down.
 * Measuring nesting against a fixed bound instead makes the decision
 * deterministic. That path becomes unreliable a few thousand levels down, so
 * this sits more than an order of magnitude below the danger zone and still far
 * deeper than any real action result.
 */
const MAX_STRUCTURED_DEPTH = 100;

function buildNotice(
  shownBytes: number,
  originalBytes: number,
  structuredOmitted: boolean
): string {
  return (
    `[Tool result truncated: showing ${shownBytes} of ${originalBytes} UTF-8 bytes. ` +
    `The JSON below is incomplete and will not parse. ` +
    (structuredOmitted ? `Structured output is omitted for the same reason. ` : "") +
    `Narrow the arguments (filters, limits, paths) and retry for a complete result.]\n\n`
  );
}

/**
 * Prefixed when the caller asked for a structured half that could not be
 * produced from a body that otherwise fits. `isError` carries the same signal to
 * the protocol; this carries it to the model.
 */
const STRUCTURED_OMITTED_NOTICE =
  `[Structured output omitted: this result could not be reproduced as bounded, ` +
  `transport-safe JSON. The text body below is complete — parse it instead.]\n\n`;

/**
 * True when any path through `value` nests deeper than `maxDepth`. Iterative on
 * purpose: a recursive probe would overflow on exactly the inputs it exists to
 * reject. Only ever run on a freshly parsed value, which is a tree, so the walk
 * is linear in the (already bounded) text it came from.
 */
function exceedsDepth(value: unknown, maxDepth: number): boolean {
  const pending: { node: unknown; depth: number }[] = [{ node: value, depth: 1 }];
  while (pending.length > 0) {
    const { node, depth } = pending.pop()!;
    if (node === null || typeof node !== "object") continue;
    if (depth > maxDepth) return true;
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      pending.push({ node: child, depth: depth + 1 });
    }
  }
  return false;
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
 * Measuring only the text would leave `structuredContent` unbounded: the text is
 * measured after serialization, while the transport `JSON.stringify`s the raw
 * object independently, and the two can diverge without limit — a getter, a
 * `toJSON`, or a value the replacer rewrote all ship different bytes than the
 * ones that were counted. Parsing the already-bounded text back keeps the halves
 * byte-consistent — strengthening the #10676 contract from "same data" to "same
 * bytes" — and bounds them both. It also removes the transport's only
 * unserializable inputs: a truly cyclic or BigInt-bearing result would make the
 * transport's own `JSON.stringify` throw.
 *
 * Returns undefined when the text is not a JSON object — the "OK" body and the
 * serializer's string-coercion fallbacks have no structured form to offer.
 */
function structuredFromText(
  text: string,
  candidate: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!candidate) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  // Depth first: the size measurement below is itself a `JSON.stringify`, so on
  // a deep value it would be the call that overflows.
  if (exceedsDepth(parsed, MAX_STRUCTURED_DEPTH)) return undefined;
  // Parsing successfully is not enough to bound the result — re-serializing can
  // grow it (`1e20` parses from 4 bytes and re-emits as 21), so the budget has to
  // be measured against the bytes the transport will actually send.
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > TOOL_RESULT_TEXT_MAX_BYTES) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

/**
 * Apply the response budget to an already-serialized text body.
 *
 * Under the cap the text passes through and `structuredContent` (when the caller
 * supplied one) rides along, preserving the #10676 contract that a client can
 * parse either half and get the same data. Over the cap the text is truncated
 * behind a notice and `structuredContent` is dropped — shipping the
 * multi-megabyte payload the cap exists to bound would defeat the cap, and
 * substituting a truncated object would violate the very schema it claims to
 * satisfy.
 *
 * Whenever a promised structured half is dropped, for any reason, the envelope
 * is flagged `isError`. MCP clients treat a tool with an `outputSchema` that
 * returns neither `structuredContent` nor `isError` as a protocol violation and
 * throw before the model sees anything — so without the flag the agent gets an
 * opaque client-side error in place of the notice explaining what happened and
 * how to retry. The flag is the SDK's own escape hatch, and it also encodes the
 * right thing: the caller asked for structured output and did not get it.
 */
export function buildToolCallTextResult(
  text: string,
  options: { structuredContent?: Record<string, unknown>; isError?: boolean } = {}
): CallToolResult {
  const { structuredContent, isError } = options;
  const originalBytes = Buffer.byteLength(text, "utf8");
  const structured =
    originalBytes <= TOOL_RESULT_TEXT_MAX_BYTES
      ? structuredFromText(text, structuredContent)
      : undefined;
  const structuredOmitted = Boolean(structuredContent) && structured === undefined;
  const prefix = structuredOmitted ? STRUCTURED_OMITTED_NOTICE : "";

  if (originalBytes + Buffer.byteLength(prefix, "utf8") <= TOOL_RESULT_TEXT_MAX_BYTES) {
    return {
      content: [{ type: "text", text: `${prefix}${text}` }],
      ...(structured ? { structuredContent: structured } : {}),
      ...(isError || structuredOmitted ? { isError: true } : {}),
    };
  }

  // The notice states how many bytes survived, but its own length changes the
  // budget it is describing. Size it against the cap first — the real count is
  // always below the cap, so it can never need more digits than this placeholder
  // and the rebuilt notice can only be shorter. That keeps the total provably
  // within the cap without a second pass.
  const noticeBytes = Buffer.byteLength(
    buildNotice(TOOL_RESULT_TEXT_MAX_BYTES, originalBytes, structuredOmitted),
    "utf8"
  );
  const budget = Math.max(0, TOOL_RESULT_TEXT_MAX_BYTES - noticeBytes);
  const buffer = Buffer.from(text, "utf8");
  const shown = buffer.subarray(0, utf8BoundaryEnd(buffer, budget)).toString("utf8");

  // Notice first, not appended: a client that trims the tail again would cut a
  // trailing marker off and leave the model reading incomplete JSON as complete.
  return {
    content: [
      {
        type: "text",
        text: `${buildNotice(Buffer.byteLength(shown, "utf8"), originalBytes, structuredOmitted)}${shown}`,
      },
    ],
    ...(isError || structuredOmitted ? { isError: true } : {}),
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
