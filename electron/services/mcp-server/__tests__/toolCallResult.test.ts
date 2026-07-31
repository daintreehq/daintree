import { describe, it, expect } from "vitest";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  TOOL_RESULT_TEXT_MAX_BYTES,
  buildToolCallResult,
  buildToolCallTextResult,
} from "../toolCallResult.js";

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content[0]?.text ?? "";
}

function byteLength(result: { content: { type: string; text?: string }[] }): number {
  return Buffer.byteLength(textOf(result), "utf8");
}

/** Serializes to just over `bytes` once compacted, without a huge allocation. */
function payloadOfAtLeast(bytes: number): { blob: string } {
  return { blob: "x".repeat(bytes) };
}

/** The payload that follows the truncation notice. */
function bodyAfterNotice(text: string): string {
  return text.slice(text.indexOf("]\n\n") + 3);
}

describe("buildToolCallResult under the cap", () => {
  it("serializes without the indentation the wire has no reader for", () => {
    const value = { a: 1, b: { c: 2 }, d: [1, 2] };
    expect(textOf(buildToolCallResult(value))).toBe(JSON.stringify(value));
  });

  it("round-trips the payload and keeps structuredContent alongside it", () => {
    const payload = { terminals: [{ id: "t-1", isFocused: true }] };
    const result = buildToolCallResult(payload, { structuredContent: payload });

    expect(JSON.parse(textOf(result))).toEqual(payload);
    expect(result.structuredContent).toEqual(payload);
    expect(result.isError).not.toBe(true);
  });

  it("omits structuredContent when the caller supplies none", () => {
    expect(buildToolCallResult({ a: 1 }).structuredContent).toBeUndefined();
  });

  it("preserves the 'OK' body for null and undefined results", () => {
    expect(textOf(buildToolCallResult(null))).toBe("OK");
    expect(textOf(buildToolCallResult(undefined))).toBe("OK");
  });

  it("leaves a body sitting exactly on the limit untouched", () => {
    const exact = "y".repeat(TOOL_RESULT_TEXT_MAX_BYTES);
    expect(textOf(buildToolCallTextResult(exact))).toBe(exact);
  });

  it("keeps a payload that only fits once compacted", () => {
    // Proves compaction buys real headroom rather than just looking tidier: this
    // survives whole because it is measured compact, and would have truncated
    // under the 2-space form.
    const rows = Array.from({ length: 900 }, (_, i) => ({ id: `terminal-${i}`, index: i }));
    const payload = { rows };
    expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeLessThanOrEqual(
      TOOL_RESULT_TEXT_MAX_BYTES
    );
    expect(Buffer.byteLength(JSON.stringify(payload, null, 2), "utf8")).toBeGreaterThan(
      TOOL_RESULT_TEXT_MAX_BYTES
    );

    const result = buildToolCallResult(payload, { structuredContent: payload });
    expect(textOf(result)).not.toContain("truncated");
    expect(result.structuredContent).toEqual(payload);
  });
});

describe("structuredContent is bounded by the same budget as the text", () => {
  it("bounds a payload whose aliases expand on the wire", () => {
    // Aliases are expanded, not collapsed, so a thousand references to one 10 KB
    // object really is a ~10 MB response — and both halves have to be measured
    // after that expansion, not before it.
    const shared = { title: "x".repeat(10_000) };
    const payload = { terminals: Array.from({ length: 1_000 }, () => shared) };

    const result = buildToolCallResult(payload, { structuredContent: payload });

    expect(byteLength(result)).toBeLessThanOrEqual(TOOL_RESULT_TEXT_MAX_BYTES);
    expect(result.structuredContent).toBeUndefined();
  });

  it("keeps an aliased but acyclic result intact in both halves", () => {
    // Nothing here is cyclic, so nothing may be replaced by a placeholder: a
    // "[Circular]" string where the declared output schema expects an object is
    // rejected outright by the client.
    const shared = { id: "s-1", label: "shared" };
    const payload = { first: shared, second: shared };

    const result = buildToolCallResult(payload, { structuredContent: payload });

    expect(result.structuredContent).toEqual(payload);
    expect(JSON.parse(textOf(result))).toEqual(payload);
    expect(result.isError).not.toBe(true);
  });

  it("keeps a cyclic result serializable for the transport", () => {
    // The transport JSON.stringify()s structuredContent itself; handing it a raw
    // cyclic object throws and fails the whole response.
    const payload: Record<string, unknown> = { name: "root" };
    payload.self = payload;

    const result = buildToolCallResult(payload, { structuredContent: payload });

    expect(() => JSON.stringify(result)).not.toThrow();
    expect(result.structuredContent).toEqual({ name: "root", self: "[Circular]" });
  });

  it("keeps a BigInt-bearing result serializable for the transport", () => {
    const payload = { count: 10n };
    const result = buildToolCallResult(payload, {
      structuredContent: payload as unknown as Record<string, unknown>,
    });

    expect(() => JSON.stringify(result)).not.toThrow();
    expect(result.structuredContent).toEqual({ count: "10" });
  });

  it("omits the structured half when the body is not JSON", () => {
    const result = buildToolCallResult(null, { structuredContent: { a: 1 } });

    expect(result.structuredContent).toBeUndefined();
    // Silently omitting a promised structured half makes the client reject the
    // whole response; the flag keeps the text body reaching the model.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Structured output omitted");
  });

  it("keeps an ordinarily nested result — the depth bound is not a size bound", () => {
    const nest = (depth: number): Record<string, unknown> =>
      depth === 0 ? { leaf: true } : { child: nest(depth - 1) };
    const payload = nest(20);

    const result = buildToolCallResult(payload, { structuredContent: payload });

    expect(result.structuredContent).toEqual(payload);
    expect(result.isError).not.toBe(true);
  });
});

describe("buildToolCallResult over the cap", () => {
  it("truncates one byte past the limit", () => {
    const result = buildToolCallTextResult("y".repeat(TOOL_RESULT_TEXT_MAX_BYTES + 1));
    expect(textOf(result)).toContain("Tool result truncated");
  });

  it("keeps the notice and payload together within the byte budget", () => {
    const result = buildToolCallResult(payloadOfAtLeast(TOOL_RESULT_TEXT_MAX_BYTES * 4));
    expect(byteLength(result)).toBeLessThanOrEqual(TOOL_RESULT_TEXT_MAX_BYTES);
  });

  it("leads with the notice so a client trimming the tail cannot hide it", () => {
    const result = buildToolCallResult(payloadOfAtLeast(TOOL_RESULT_TEXT_MAX_BYTES * 2));
    expect(textOf(result).startsWith("[Tool result truncated:")).toBe(true);
  });

  it("delivers the leading bytes of the result, not some other slice", () => {
    const original = JSON.stringify(payloadOfAtLeast(TOOL_RESULT_TEXT_MAX_BYTES * 2));
    const body = bodyAfterNotice(textOf(buildToolCallTextResult(original)));

    expect(body.length).toBeGreaterThan(0);
    expect(original.startsWith(body)).toBe(true);
  });

  it("spends the whole budget — one more character would overflow it", () => {
    const original = JSON.stringify(payloadOfAtLeast(TOOL_RESULT_TEXT_MAX_BYTES * 2));
    const text = textOf(buildToolCallTextResult(original));
    const body = bodyAfterNotice(text);
    const noticeBytes = Buffer.byteLength(text, "utf8") - Buffer.byteLength(body, "utf8");

    const oneMore = original.slice(0, body.length + 1);
    expect(noticeBytes + Buffer.byteLength(oneMore, "utf8")).toBeGreaterThan(
      TOOL_RESULT_TEXT_MAX_BYTES
    );
  });

  it("reports the delivered and original sizes honestly", () => {
    const payload = payloadOfAtLeast(TOOL_RESULT_TEXT_MAX_BYTES * 2);
    const originalBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    const text = textOf(buildToolCallResult(payload));

    const notice = /^\[Tool result truncated: showing (\d+) of (\d+) UTF-8 bytes\./.exec(text);
    expect(notice).not.toBeNull();
    expect(Number(notice![2])).toBe(originalBytes);
    expect(Number(notice![1])).toBe(Buffer.byteLength(bodyAfterNotice(text), "utf8"));
  });

  it("drops structuredContent so the unbounded duplicate does not defeat the cap", () => {
    const payload = payloadOfAtLeast(TOOL_RESULT_TEXT_MAX_BYTES * 2);
    const result = buildToolCallResult(payload, { structuredContent: payload });
    expect(result.structuredContent).toBeUndefined();
  });

  it("does not mark a truncated success as an error when nothing was promised", () => {
    const result = buildToolCallResult(payloadOfAtLeast(TOOL_RESULT_TEXT_MAX_BYTES * 2));
    expect(result.isError).not.toBe(true);
  });

  it("flags a truncation that cost a promised structured half", () => {
    // A client whose tool declares an outputSchema throws on a response carrying
    // neither structuredContent nor isError, so the unflagged form would replace
    // the notice below with an opaque protocol error.
    const payload = payloadOfAtLeast(TOOL_RESULT_TEXT_MAX_BYTES * 2);
    const result = buildToolCallResult(payload, { structuredContent: payload });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Structured output is omitted");
    expect(byteLength(result)).toBeLessThanOrEqual(TOOL_RESULT_TEXT_MAX_BYTES);
  });

  // A 4-byte code point tiled across the buffer puts the cut at each of the four
  // possible offsets within a character as the padding shifts the budget.
  it.each([0, 1, 2, 3])("cuts on a character boundary at phase %i", (phase) => {
    const text = `${"a".repeat(phase)}${"🌳".repeat(TOOL_RESULT_TEXT_MAX_BYTES / 2)}`;
    const result = buildToolCallTextResult(text);

    expect(bodyAfterNotice(textOf(result))).not.toContain("�");
    expect(byteLength(result)).toBeLessThanOrEqual(TOOL_RESULT_TEXT_MAX_BYTES);
  });

  it("backs off no further than the straddling character", () => {
    // The back-off must shave only the partial code point, never a whole one
    // that fit — so the unused tail is always narrower than one character.
    const text = textOf(buildToolCallTextResult("🌳".repeat(TOOL_RESULT_TEXT_MAX_BYTES / 2)));
    const bodyBytes = Buffer.byteLength(bodyAfterNotice(text), "utf8");
    const budget = TOOL_RESULT_TEXT_MAX_BYTES - (Buffer.byteLength(text, "utf8") - bodyBytes);

    expect(bodyBytes % 4).toBe(0);
    expect(budget - bodyBytes).toBeLessThan(4);
  });

  it("omits a structured half that would re-serialize past the cap", () => {
    // `1e20` parses from 4 bytes and re-emits as 21, so a body that measured
    // under the cap can blow past it the moment the transport stringifies it.
    const text = `{"v":[${Array(10_000).fill("1e20").join(",")}]}`;
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(TOOL_RESULT_TEXT_MAX_BYTES);

    const result = buildToolCallTextResult(text, { structuredContent: { v: [] } });
    expect(result.structuredContent).toBeUndefined();
  });

  it("omits a structured half too deeply nested for the transport to serialize", () => {
    // A trial JSON.stringify here is not the operation the transport performs:
    // that one wraps the JSON-RPC envelope around the same value, deeper and at a
    // different stack depth, so a value that survives the trial can still throw
    // RangeError on the wire. Only a fixed depth bound decides this the same way
    // every time.
    const text = `${"[".repeat(10_000)}${"]".repeat(10_000)}`;
    const result = buildToolCallTextResult(`{"v":${text}}`, { structuredContent: { v: [] } });

    expect(result.structuredContent).toBeUndefined();
    expect(result.isError).toBe(true);
    expect(() => JSON.stringify({ jsonrpc: "2.0", id: 1, result })).not.toThrow();
  });
});

describe("error envelopes", () => {
  it("preserves isError through truncation", () => {
    const result = buildToolCallTextResult("y".repeat(TOOL_RESULT_TEXT_MAX_BYTES * 2), {
      isError: true,
    });

    expect(result.isError).toBe(true);
    expect(byteLength(result)).toBeLessThanOrEqual(TOOL_RESULT_TEXT_MAX_BYTES);
  });

  it("leaves a small error body parseable", () => {
    const payload = { code: "EXECUTION_ERROR", message: "boom" };
    const result = buildToolCallTextResult(JSON.stringify(payload), { isError: true });

    expect(JSON.parse(textOf(result))).toEqual(payload);
    expect(result.isError).toBe(true);
  });
});

describe("SDK conformance", () => {
  it("survives schema validation with both halves intact", () => {
    // The SDK returns the *parsed* result to the transport, so a key the schema
    // dropped would never reach the client even though safeParse succeeded.
    const payload = { a: 1 };
    const parsed = CallToolResultSchema.safeParse(
      buildToolCallResult(payload, { structuredContent: payload })
    );

    expect(parsed.success).toBe(true);
    expect(parsed.data?.structuredContent).toEqual(payload);
  });

  it("accepts a truncated result and keeps the flag that makes it valid", () => {
    const payload = payloadOfAtLeast(TOOL_RESULT_TEXT_MAX_BYTES * 2);
    const parsed = CallToolResultSchema.safeParse(
      buildToolCallResult(payload, { structuredContent: payload })
    );

    expect(parsed.success).toBe(true);
    expect(parsed.data?.structuredContent).toBeUndefined();
    expect(parsed.data?.isError).toBe(true);
  });
});
