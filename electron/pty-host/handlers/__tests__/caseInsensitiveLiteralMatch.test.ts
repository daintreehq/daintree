import { describe, it, expect } from "vitest";
import { findCaseInsensitiveLiteral } from "../caseInsensitiveLiteralMatch.js";

function slice(line: string, needle: string): string | null {
  const range = findCaseInsensitiveLiteral(line, needle);
  return range ? line.slice(range.start, range.end) : null;
}

describe("findCaseInsensitiveLiteral", () => {
  it("matches case-insensitively at the same offsets when lowercasing keeps the length", () => {
    expect(findCaseInsensitiveLiteral("Build FAILED: retry", "failed")).toEqual({
      start: 6,
      end: 12,
    });
  });

  it("keeps UTF-16 offsets inside a character that lowercases to the same width", () => {
    expect(findCaseInsensitiveLiteral("x𐐀y", "\uDC28")).toEqual({ start: 2, end: 3 });
    expect(findCaseInsensitiveLiteral("İ𐐀x", "\uDC28")).toEqual({ start: 2, end: 3 });
    expect(findCaseInsensitiveLiteral("İ𐐀x", "\uD801")).toEqual({ start: 1, end: 2 });
  });

  it("returns original coordinates after a length-changing prefix (#17515)", () => {
    const line = "İSTANBUL: done";
    // `İ` lowercases to two UTF-16 units, so the lowered index of "done" is 11.
    expect(line.toLowerCase().indexOf("done")).toBe(11);
    expect(findCaseInsensitiveLiteral(line, "done")).toEqual({ start: 10, end: 14 });
    expect(slice(line, "done")).toBe("done");
  });

  it("matches a query that contains the length-changing character", () => {
    const line = "İSTANBUL: done";
    expect(findCaseInsensitiveLiteral(line, "İSTANBUL")).toEqual({ start: 0, end: 8 });
    expect(slice(line, "İstanbul: DONE")).toBe(line);
    expect(slice("go to İzmir now", "İzmir")).toBe("İzmir");
    // The matched span is one unit longer than the query, so end must not be start + query.length.
    expect(findCaseInsensitiveLiteral("İ xi\u0307y", "İY")).toEqual({ start: 3, end: 6 });
  });

  it("handles several expanded characters before and inside the match", () => {
    const line = "İİ ok İİ done";
    expect(slice(line, "done")).toBe("done");
    expect(slice(line, "İİ d")).toBe("İİ d");
    expect(findCaseInsensitiveLiteral(line, "ok")).toEqual({ start: 3, end: 5 });
  });

  it("snaps a match that starts or ends inside an expanded character to the whole character", () => {
    const line = "xİy";
    // The combining dot (U+0307) is the second half of the lowered `İ`.
    expect(slice(line, "̇")).toBe("İ");
    expect(slice(line, "i")).toBe("İ");
    expect(slice(line, "i̇y")).toBe("İy");
  });

  it("keeps astral characters whole", () => {
    const line = "𐐀𐐁 İ done";
    expect(slice(line, "done")).toBe("done");
    expect(slice(line, "𐐨")).toBe("𐐀");
    expect(slice(line, "𐐁 İ")).toBe("𐐁 İ");
  });

  it("keeps matching the way a whole-string lowercase does for final sigma", () => {
    expect(slice("ΟΔΟΣ", "οδος")).toBe("ΟΔΟΣ");
    expect(slice("İ ΟΔΟΣ", "οδος")).toBe("ΟΔΟΣ");
    // The query is lowered as a whole too, so an uppercase final sigma still finds it.
    expect(findCaseInsensitiveLiteral("İ οδος!", "ΟΔΟΣ")).toEqual({ start: 2, end: 6 });
  });

  it("reports the first occurrence", () => {
    expect(findCaseInsensitiveLiteral("İ ok ok", "OK")).toEqual({ start: 2, end: 4 });
    expect(findCaseInsensitiveLiteral("ok ok", "OK")).toEqual({ start: 0, end: 2 });
  });

  it("returns null when nothing matches or the query is empty", () => {
    expect(findCaseInsensitiveLiteral("İSTANBUL: done", "missing")).toBeNull();
    expect(findCaseInsensitiveLiteral("plain", "missing")).toBeNull();
    expect(findCaseInsensitiveLiteral("plain", "")).toBeNull();
    expect(findCaseInsensitiveLiteral("İ", "")).toBeNull();
    expect(findCaseInsensitiveLiteral("", "x")).toBeNull();
  });
});
