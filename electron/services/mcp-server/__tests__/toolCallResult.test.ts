import { describe, it, expect } from "vitest";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  TOOL_RESULT_TEXT_MAX_BYTES,
  buildToolCallResult,
  buildToolCallTextResult,
} from "../toolCallResult.js";

const META_KEY = "anthropic/maxResultSizeChars";

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

  it("advertises the ceiling it actually enforces", () => {
    expect(buildToolCallResult({ a: 1 })._meta?.[META_KEY]).toBe(TOOL_RESULT_TEXT_MAX_BYTES);
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
  it("does not ship aliased references the text half collapsed", () => {
    // The serializer marks every *repeated* reference "[Circular]", so a result
    // holding many aliases of one big object serializes small — but the raw
    // object would expand each alias in full on the wire, smuggling megabytes
    // past a cap that only measured the text.
    const shared = { title: "x".repeat(10_000) };
    const payload = { terminals: Array.from({ length: 1_000 }, () => shared) };

    const result = buildToolCallResult(payload, { structuredContent: payload });

    expect(byteLength(result)).toBeLessThanOrEqual(TOOL_RESULT_TEXT_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(result.structuredContent), "utf8")).toBeLessThanOrEqual(
      TOOL_RESULT_TEXT_MAX_BYTES
    );
    // Both halves must agree — that is the #10676 contract.
    expect(result.structuredContent).toEqual(JSON.parse(textOf(result)));
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
    expect(
      buildToolCallResult(null, { structuredContent: { a: 1 } }).structuredContent
    ).toBeUndefined();
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

  it("does not mark a truncated success as an error", () => {
    const result = buildToolCallResult(payloadOfAtLeast(TOOL_RESULT_TEXT_MAX_BYTES * 2));
    expect(result.isError).not.toBe(true);
  });

  it("still advertises the ceiling on a truncated response", () => {
    const result = buildToolCallResult(payloadOfAtLeast(TOOL_RESULT_TEXT_MAX_BYTES * 2));
    expect(result._meta?.[META_KEY]).toBe(TOOL_RESULT_TEXT_MAX_BYTES);
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
    const text = `${"[".repeat(10_000)}${"]".repeat(10_000)}`;
    const result = buildToolCallTextResult(`{"v":${text}}`, { structuredContent: { v: [] } });

    expect(() => JSON.stringify(result)).not.toThrow();
    expect(result.structuredContent).toBeUndefined();
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
  it("survives schema validation with the size hint intact", () => {
    // The SDK returns the *parsed* result to the transport, so a key the schema
    // dropped would never reach the client even though safeParse succeeded.
    const parsed = CallToolResultSchema.safeParse(buildToolCallResult({ a: 1 }));

    expect(parsed.success).toBe(true);
    expect(parsed.data?._meta?.[META_KEY]).toBe(TOOL_RESULT_TEXT_MAX_BYTES);
  });

  it("accepts a truncated result", () => {
    const parsed = CallToolResultSchema.safeParse(
      buildToolCallResult(payloadOfAtLeast(TOOL_RESULT_TEXT_MAX_BYTES * 2))
    );

    expect(parsed.success).toBe(true);
    expect(parsed.data?.structuredContent).toBeUndefined();
  });
});
