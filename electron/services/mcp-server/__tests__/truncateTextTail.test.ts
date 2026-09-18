import { describe, expect, it } from "vitest";
import { truncateTextTail } from "../shared.js";

const MARKER = "[truncated]\n\n";
const markerBytes = Buffer.byteLength(MARKER, "utf8");
const OLDER = "old\n".repeat(20);

describe("truncateTextTail (#12450)", () => {
  it("returns text at exactly the budget unchanged", () => {
    const text = "a".repeat(40);
    expect(truncateTextTail(text, 40)).toBe(text);
  });

  it("keeps whole trailing lines behind a leading marker", () => {
    const result = truncateTextTail(`${OLDER}aaa\nbbb\nccc\nddd`, markerBytes + 9);
    expect(result).toBe(`${MARKER}ccc\nddd`);
  });

  it("keeps a line the cut lands exactly at the start of", () => {
    const result = truncateTextTail(`${OLDER}aaa\nbbb\nccc\nddd`, markerBytes + 7);
    expect(result).toBe(`${MARKER}ccc\nddd`);
  });

  it("keeps CRLF-terminated lines whole", () => {
    const result = truncateTextTail(`${"old\r\n".repeat(20)}aaa\r\nbbb\r\nccc`, markerBytes + 8);
    expect(result).toBe(`${MARKER}bbb\r\nccc`);
  });

  it("keeps the end of a single line too long to fit, on a character boundary", () => {
    const result = truncateTextTail("🌳".repeat(10), markerBytes + 10);
    expect(result).toBe(`${MARKER}🌳🌳`);
  });

  it("falls back to a partial line when the only newline is the last byte", () => {
    const result = truncateTextTail(`${"x".repeat(100)}\n`, markerBytes + 10);
    expect(result).toBe(`${MARKER}${"x".repeat(9)}\n`);
  });

  it("never exceeds budgets smaller than its own marker", () => {
    const text = "x".repeat(64);
    for (let budget = 0; budget <= markerBytes + 2; budget += 1) {
      expect(Buffer.byteLength(truncateTextTail(text, budget), "utf8")).toBeLessThanOrEqual(budget);
    }
  });
});
