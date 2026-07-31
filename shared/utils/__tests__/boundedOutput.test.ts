import { describe, it, expect } from "vitest";
import { paginate, sliceUtf8Window, truncateUtf8, utf8ByteLength } from "../boundedOutput.js";

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("paginate", () => {
  it("returns a page bounded by limit and reports the remainder", () => {
    const result = paginate(range(250), 0, 100);
    expect(result.items).toHaveLength(100);
    expect(result.items[0]).toBe(0);
    expect(result.total).toBe(250);
    expect(result.hasMore).toBe(true);
    expect(result.nextOffset).toBe(100);
  });

  it("closes out the final page with nextOffset null", () => {
    const result = paginate(range(250), 200, 100);
    expect(result.items).toEqual(range(250).slice(200));
    expect(result.hasMore).toBe(false);
    expect(result.nextOffset).toBeNull();
  });

  it("walking nextOffset visits every item exactly once", () => {
    const source = range(250);
    const seen: number[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const current: number = offset;
      const page = paginate(source, current, 40);
      seen.push(...page.items);
      offset = page.nextOffset;
    }
    expect(seen).toEqual(source);
  });

  it("yields an empty page past the end rather than throwing", () => {
    const result = paginate(range(10), 999, 50);
    expect(result.items).toEqual([]);
    expect(result.total).toBe(10);
    expect(result.hasMore).toBe(false);
    expect(result.nextOffset).toBeNull();
  });

  it("clamps a negative offset and a non-positive limit", () => {
    expect(paginate(range(10), -5, 3).items).toEqual([0, 1, 2]);
    expect(paginate(range(10), 0, 0).items).toEqual([0]);
    expect(paginate(range(10), 0, -7).items).toEqual([0]);
  });
});

describe("sliceUtf8Window", () => {
  it("reports the byte total and no truncation when the window covers everything", () => {
    const result = sliceUtf8Window("hello", 0, 1024);
    expect(result.content).toBe("hello");
    expect(result.totalBytes).toBe(5);
    expect(result.truncated).toBe(false);
    expect(result.nextOffset).toBeNull();
  });

  it("never splits a multi-byte character at the window end", () => {
    // "€" is 3 bytes; a 2-byte window must not emit a replacement character.
    const result = sliceUtf8Window("ab€cd", 0, 4);
    expect(result.content).toBe("ab");
    expect(result.content).not.toContain("�");
    expect(result.nextOffset).toBe(2);
  });

  it("emits an oversized leading character whole so the caller still progresses", () => {
    const result = sliceUtf8Window("😀tail", 0, 2);
    expect(result.content).toBe("😀");
    expect(result.nextOffset).toBe(4);
    expect(result.truncated).toBe(true);
  });

  it("reconstructs the original text when walking nextOffset", () => {
    const text = "héllo — wörld 😀 ".repeat(500);
    let offset: number | null = 0;
    let rebuilt = "";
    let iterations = 0;
    while (offset !== null) {
      const current: number = offset;
      const window = sliceUtf8Window(text, current, 7);
      rebuilt += window.content;
      offset = window.nextOffset;
      expect(++iterations).toBeLessThan(20000);
    }
    expect(rebuilt).toBe(text);
  });

  it("advances a mid-character offset to the next boundary instead of emitting U+FFFD", () => {
    const result = sliceUtf8Window("€x", 1, 16);
    expect(result.content).toBe("x");
    expect(result.offset).toBe(3);
    expect(result.content).not.toContain("�");
  });

  it("returns an empty terminal window when the offset is past the end", () => {
    const result = sliceUtf8Window("abc", 99, 16);
    expect(result.content).toBe("");
    expect(result.totalBytes).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.nextOffset).toBeNull();
  });

  it("keeps each window within maxBytes for single-byte content", () => {
    const window = sliceUtf8Window("x".repeat(5000), 0, 1000);
    expect(utf8ByteLength(window.content)).toBe(1000);
    expect(window.truncated).toBe(true);
  });
});

describe("truncateUtf8", () => {
  it("passes short text through untouched", () => {
    expect(truncateUtf8("short", 1024)).toEqual({ text: "short", truncated: false });
  });

  it("cuts to the byte ceiling and flags truncation", () => {
    const result = truncateUtf8("y".repeat(3000), 1024);
    expect(utf8ByteLength(result.text)).toBe(1024);
    expect(result.truncated).toBe(true);
  });

  it("does not split a character at the cut point", () => {
    const result = truncateUtf8("あ".repeat(100), 10);
    expect(result.text).not.toContain("�");
    expect(utf8ByteLength(result.text)).toBeLessThanOrEqual(10);
    expect(result.truncated).toBe(true);
  });

  it("counts bytes, not UTF-16 code units", () => {
    expect(utf8ByteLength("😀")).toBe(4);
    expect("😀".length).toBe(2);
  });
});
