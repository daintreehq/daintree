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

describe("buildToolCallResult under the cap", () => {
  it("emits compact JSON with no cosmetic indentation", () => {
    const result = buildToolCallResult({ a: 1, b: { c: 2 } });
    expect(textOf(result)).toBe('{"a":1,"b":{"c":2}}');
  });

  it("round-trips the payload and keeps structuredContent alongside it", () => {
    const payload = { terminals: [{ id: "t-1", isFocused: true }] };
    const result = buildToolCallResult(payload, { structuredContent: payload });

    expect(JSON.parse(textOf(result))).toEqual(payload);
    expect(result.structuredContent).toEqual(payload);
    expect(result.isError).toBeUndefined();
  });

  it("omits structuredContent when the caller supplies none", () => {
    const result = buildToolCallResult({ a: 1 });
    expect(result.structuredContent).toBeUndefined();
  });

  it("preserves the 'OK' body for null and undefined results", () => {
    expect(textOf(buildToolCallResult(null))).toBe("OK");
    expect(textOf(buildToolCallResult(undefined))).toBe("OK");
  });

  it("advertises the ceiling so clients do not re-truncate a bounded response", () => {
    const result = buildToolCallResult({ a: 1 });
    expect(result._meta?.[META_KEY]).toBe(TOOL_RESULT_TEXT_MAX_BYTES);
  });

  it("leaves a body sitting exactly on the limit untouched", () => {
    const exact = "y".repeat(TOOL_RESULT_TEXT_MAX_BYTES);
    const result = buildToolCallTextResult(exact);

    expect(textOf(result)).toBe(exact);
    expect(byteLength(result)).toBe(TOOL_RESULT_TEXT_MAX_BYTES);
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

  it("reports the delivered and original sizes honestly", () => {
    const payload = payloadOfAtLeast(TOOL_RESULT_TEXT_MAX_BYTES * 2);
    const originalBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    const text = textOf(buildToolCallResult(payload));

    const notice = /^\[Tool result truncated: showing (\d+) of (\d+) UTF-8 bytes\./.exec(text);
    expect(notice).not.toBeNull();
    expect(Number(notice![2])).toBe(originalBytes);

    // The reported "showing" count must match the payload that actually follows
    // the notice, or the model is being told something false about its data.
    const body = text.slice(text.indexOf("]\n\n") + 3);
    expect(Number(notice![1])).toBe(Buffer.byteLength(body, "utf8"));
  });

  it("drops structuredContent so the unbounded duplicate does not defeat the cap", () => {
    const payload = payloadOfAtLeast(TOOL_RESULT_TEXT_MAX_BYTES * 2);
    const result = buildToolCallResult(payload, { structuredContent: payload });
    expect(result.structuredContent).toBeUndefined();
  });

  it("does not mark a truncated success as an error", () => {
    const result = buildToolCallResult(payloadOfAtLeast(TOOL_RESULT_TEXT_MAX_BYTES * 2));
    expect(result.isError).toBeUndefined();
  });

  it("cuts on a character boundary instead of emitting a replacement char", () => {
    // 4-byte astral chars tile the buffer so the budget lands mid-character.
    const result = buildToolCallTextResult("🌳".repeat(TOOL_RESULT_TEXT_MAX_BYTES / 2));

    expect(textOf(result)).not.toContain("�");
    expect(byteLength(result)).toBeLessThanOrEqual(TOOL_RESULT_TEXT_MAX_BYTES);
  });

  it("still advertises the ceiling on a truncated response", () => {
    const result = buildToolCallResult(payloadOfAtLeast(TOOL_RESULT_TEXT_MAX_BYTES * 2));
    expect(result._meta?.[META_KEY]).toBe(TOOL_RESULT_TEXT_MAX_BYTES);
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
  });
});

describe("SDK conformance", () => {
  it("produces results the SDK schema accepts, capped or not", () => {
    expect(CallToolResultSchema.safeParse(buildToolCallResult({ a: 1 })).success).toBe(true);
    expect(
      CallToolResultSchema.safeParse(
        buildToolCallResult(payloadOfAtLeast(TOOL_RESULT_TEXT_MAX_BYTES * 2))
      ).success
    ).toBe(true);
  });
});
