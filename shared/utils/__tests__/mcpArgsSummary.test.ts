import { describe, expect, it, vi } from "vitest";
import {
  MCP_ARGS_INLINE_STRING_LIMIT,
  MCP_ARGS_SUMMARY_LIMIT,
  MCP_RESULT_SUMMARY_LIMIT,
  summarizeMcpArgs,
  summarizeMcpResult,
} from "../mcpArgsSummary.js";

describe("summarizeMcpArgs", () => {
  it("distinguishes no arguments from an explicit null argument", () => {
    // Callers render this as a preview and gate the block on emptiness, so
    // "this call takes no arguments" must be empty rather than the word
    // "null" — which is what users were shown for every no-arg action
    // (#11299). An argument that genuinely *is* null keeps its own summary.
    expect(summarizeMcpArgs(undefined)).toBe("");
    expect(summarizeMcpArgs(null)).toBe("null");
  });

  it("keeps the no-arguments summary empty even with a scrubber attached", () => {
    // The audit path always passes a scrubber. A scrubber that returns a
    // sentinel proves the empty case never reaches it — a scrubber mapping
    // "" to "" would pass whether or not it ran.
    const scrub = vi.fn(() => "SCRUBBED");
    expect(summarizeMcpArgs(undefined, scrub)).toBe("");
    expect(scrub).not.toHaveBeenCalled();
  });

  it("collapses long strings to a length placeholder", () => {
    const long = "x".repeat(MCP_ARGS_INLINE_STRING_LIMIT + 10);
    const out = summarizeMcpArgs({ note: long });
    expect(out).toContain(`<string: ${long.length} chars>`);
    expect(out).not.toContain("xxx");
  });

  it("collapses nested objects to <object>", () => {
    const out = summarizeMcpArgs({ args: { deep: { value: 1 } } });
    expect(out).toBe('{"args":"<object>"}');
  });

  it("excludes the _meta field entirely", () => {
    const out = summarizeMcpArgs({ toolId: "x", _meta: { secret: "abc" } });
    expect(out).toBe('{"toolId":"x"}');
  });

  it("redacts short string values keyed under sensitive names", () => {
    const out = summarizeMcpArgs({
      token: "abc123",
      apiKey: "sk-xyz",
      password: "hunter2",
      authToken: "Bearer xyz",
      credential: "x",
      bearerToken: "x",
      api_key: "x",
    });
    expect(out).toContain('"token":"<redacted>"');
    expect(out).toContain('"apiKey":"<redacted>"');
    expect(out).toContain('"password":"<redacted>"');
    expect(out).toContain('"authToken":"<redacted>"');
    expect(out).toContain('"credential":"<redacted>"');
    expect(out).toContain('"bearerToken":"<redacted>"');
    expect(out).toContain('"api_key":"<redacted>"');
  });

  it("redacts conservatively on key names that contain a sensitive substring", () => {
    // Substring matching is intentional: `tokenizer` contains `token`,
    // `keyword` contains `key`. Erring toward false positives keeps short
    // secret values from slipping through under unfamiliar argument names.
    const out = summarizeMcpArgs({ tokenizer: "ok", keyword: "ok" });
    expect(out).toContain('"tokenizer":"<redacted>"');
    expect(out).toContain('"keyword":"<redacted>"');
  });

  it("does not redact non-string values under sensitive keys", () => {
    const out = summarizeMcpArgs({ tokenCount: 42, hasKey: true });
    expect(out).toContain('"tokenCount":42');
    expect(out).toContain('"hasKey":true');
  });

  it("does not redact empty strings (callers pass through)", () => {
    const out = summarizeMcpArgs({ token: "" });
    expect(out).toBe('{"token":""}');
  });

  it("does not redact non-sensitive keys with similarly-named substrings", () => {
    // `tool` and `path` and `query` should not match the sensitive pattern.
    const out = summarizeMcpArgs({ tool: "hello", path: "/tmp", query: "world" });
    expect(out).not.toContain("<redacted>");
  });

  it("truncates the serialized summary at MCP_ARGS_SUMMARY_LIMIT", () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 100; i += 1) {
      big[`key${i}`] = "v";
    }
    const out = summarizeMcpArgs(big);
    expect(out.length).toBeLessThanOrEqual(MCP_ARGS_SUMMARY_LIMIT);
    expect(out.endsWith("…")).toBe(true);
  });

  it("inlines short non-sensitive string values verbatim", () => {
    const out = summarizeMcpArgs({ name: "hello" });
    expect(out).toBe('{"name":"hello"}');
  });
});

describe("summarizeMcpArgs postSerializeScrub", () => {
  it("runs the callback on the serialized JSON before truncation", () => {
    const out = summarizeMcpArgs({ q: "hello" }, (s) => s.replace(/hello/g, "REDACTED"));
    expect(out).toBe('{"q":"REDACTED"}');
  });

  it("scrubs structural secrets that would otherwise survive truncation", () => {
    // Scrubber stub matches Bearer tokens with at least 8 chars of body.
    const scrub = (s: string) => s.replace(/Bearer [A-Za-z0-9]{8,}/g, "Bearer [REDACTED]");
    const padding = "x".repeat(MCP_ARGS_INLINE_STRING_LIMIT);
    const out = summarizeMcpArgs({ padding, ctx: "Bearer aabbccddeeff" }, scrub);
    expect(out).toContain("Bearer [REDACTED]");
    expect(out).not.toContain("aabbccddeeff");
  });

  it("scrubs before truncation so a sliced bearer body is not leaked", () => {
    // Build args whose serialized form places a bearer token at a position
    // where the 300-char truncation would cut its body. With pre-truncation
    // scrub the bearer body never reaches the slice.
    const padding = "x".repeat(MCP_ARGS_INLINE_STRING_LIMIT);
    const args: Record<string, string> = {};
    for (let i = 0; i < 5; i += 1) args[`a${i}`] = padding;
    args.tail = "Bearer abcdefghij";
    const scrub = (s: string) => s.replace(/Bearer [A-Za-z0-9]{8,}/g, "Bearer [REDACTED]");
    const out = summarizeMcpArgs(args, scrub);
    // Either the bearer body was scrubbed before truncation, or the entire
    // tail was truncated. Neither leaves the partial body visible.
    expect(out).not.toMatch(/Bearer abcd/);
  });
});

describe("summarizeMcpResult", () => {
  it("keeps nested structure, unlike the args summary", () => {
    const out = summarizeMcpResult({ terminals: [{ id: "t1", state: "waiting" }] });
    expect(out).toContain('"id": "t1"');
    expect(out).toContain('"state": "waiting"');
  });

  it("scrubs before truncating so a sliced secret body is not leaked", () => {
    const scrub = (s: string) => s.replace(/Bearer [A-Za-z0-9]{8,}/g, "Bearer [REDACTED]");
    const filler = "x".repeat(MCP_RESULT_SUMMARY_LIMIT);
    const out = summarizeMcpResult({ filler, token: "Bearer abcdefghij" }, scrub);
    expect(out).not.toMatch(/Bearer abcd/);
  });

  it("truncates past the limit with an omission note", () => {
    const out = summarizeMcpResult({ big: "y".repeat(MCP_RESULT_SUMMARY_LIMIT * 2) });
    expect(out.length).toBeLessThan(MCP_RESULT_SUMMARY_LIMIT + 64);
    expect(out).toMatch(/more characters$/);
  });

  it("redacts sensitive keys at every depth", () => {
    const out = summarizeMcpResult({
      data: { nested: { apiKey: "sk-supersecret", note: "fine" } },
    });
    expect(out).not.toContain("sk-supersecret");
    expect(out).toContain("<redacted>");
    expect(out).toContain('"note": "fine"');
  });

  it("scrubs structural secrets inside long strings before the per-string cap", () => {
    // The Bearer body straddles the cap boundary: a naive slice-then-scrub
    // would leave a "Bearer abc" prefix too short for the scrubber to match.
    const scrub = (s: string) => s.replace(/Bearer [A-Za-z0-9]{8,}/g, "Bearer [REDACTED]");
    const long = "x".repeat(MCP_RESULT_SUMMARY_LIMIT - 10) + "Bearer abcdefghijklmnop";
    const out = summarizeMcpResult({ log: long }, scrub);
    expect(out).not.toMatch(/Bearer abc/);
  });

  it("survives unserializable values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(summarizeMcpResult(cyclic)).toBe("<unserializable>");
  });

  it("stringifies bigints instead of throwing", () => {
    expect(summarizeMcpResult({ n: 5n })).toContain('"5n"');
  });
});
