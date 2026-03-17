import { describe, it, expect } from "vitest";
import { parseNoteWithLinks } from "../textParsing";

describe("parseNoteWithLinks", () => {
  it("should return a single text segment for plain text", () => {
    const result = parseNoteWithLinks("hello world");
    expect(result).toEqual([{ type: "text", content: "hello world", start: 0 }]);
  });

  it("should return a single link segment for a standalone URL", () => {
    const result = parseNoteWithLinks("https://example.com");
    expect(result).toEqual([{ type: "link", content: "https://example.com", start: 0 }]);
  });

  it("should parse text with an embedded URL", () => {
    const result = parseNoteWithLinks("Visit https://example.com for details");
    expect(result).toEqual([
      { type: "text", content: "Visit ", start: 0 },
      { type: "link", content: "https://example.com", start: 6 },
      { type: "text", content: " for details", start: 25 },
    ]);
  });

  it("should parse multiple URLs with correct start offsets", () => {
    const result = parseNoteWithLinks("See https://a.com and https://b.com end");
    expect(result).toEqual([
      { type: "text", content: "See ", start: 0 },
      { type: "link", content: "https://a.com", start: 4 },
      { type: "text", content: " and ", start: 17 },
      { type: "link", content: "https://b.com", start: 22 },
      { type: "text", content: " end", start: 35 },
    ]);
  });

  it("should handle duplicate URLs at different offsets", () => {
    const result = parseNoteWithLinks("https://a.com https://a.com");
    expect(result).toEqual([
      { type: "link", content: "https://a.com", start: 0 },
      { type: "text", content: " ", start: 13 },
      { type: "link", content: "https://a.com", start: 14 },
    ]);
  });

  it("should handle URL at start with trailing text", () => {
    const result = parseNoteWithLinks("https://start.com is first");
    expect(result).toEqual([
      { type: "link", content: "https://start.com", start: 0 },
      { type: "text", content: " is first", start: 17 },
    ]);
  });

  it("should handle URL at end with leading text", () => {
    const result = parseNoteWithLinks("check out https://end.com");
    expect(result).toEqual([
      { type: "text", content: "check out ", start: 0 },
      { type: "link", content: "https://end.com", start: 10 },
    ]);
  });

  it("should satisfy round-trip invariant: segments reconstruct the original string", () => {
    const input = "Hello https://a.com world https://b.com!";
    const result = parseNoteWithLinks(input);

    const reconstructed = result.map((s) => s.content).join("");
    expect(reconstructed).toBe(input);

    for (const segment of result) {
      expect(input.slice(segment.start, segment.start + segment.content.length)).toBe(
        segment.content
      );
    }
  });

  it("should return empty array for empty string", () => {
    const result = parseNoteWithLinks("");
    expect(result).toEqual([]);
  });
});
