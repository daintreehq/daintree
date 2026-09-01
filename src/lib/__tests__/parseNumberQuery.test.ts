import { describe, it, expect } from "vitest";
import { parseNumberQuery, looksLikeNumberList, MULTI_FETCH_CAP } from "../parseNumberQuery";

describe("parseNumberQuery", () => {
  describe("single number", () => {
    it("should parse bare number", () => {
      expect(parseNumberQuery("123")).toEqual({ kind: "single", number: 123 });
    });

    it("should parse hash-prefixed number", () => {
      expect(parseNumberQuery("#123")).toEqual({ kind: "single", number: 123 });
    });

    it("should trim whitespace", () => {
      expect(parseNumberQuery("  #123  ")).toEqual({ kind: "single", number: 123 });
    });

    it("should reject zero", () => {
      expect(parseNumberQuery("0")).toBeNull();
      expect(parseNumberQuery("#0")).toBeNull();
    });
  });

  describe("comma list (multi)", () => {
    it("should parse bare numbers", () => {
      expect(parseNumberQuery("123, 124, 125")).toEqual({
        kind: "multi",
        numbers: [123, 124, 125],
      });
    });

    it("should parse hash-prefixed numbers", () => {
      expect(parseNumberQuery("#123, #124, #125")).toEqual({
        kind: "multi",
        numbers: [123, 124, 125],
      });
    });

    it("should parse mixed hash and bare numbers", () => {
      expect(parseNumberQuery("#123, 124")).toEqual({
        kind: "multi",
        numbers: [123, 124],
      });
    });

    it("should de-duplicate while preserving order", () => {
      expect(parseNumberQuery("123, 123, 124")).toEqual({
        kind: "multi",
        numbers: [123, 124],
      });
    });

    it("should handle no spaces around commas", () => {
      expect(parseNumberQuery("123,124,125")).toEqual({
        kind: "multi",
        numbers: [123, 124, 125],
      });
    });

    it("should reject double commas", () => {
      expect(parseNumberQuery("123,,124")).toBeNull();
      expect(parseNumberQuery("123,,")).toBeNull();
      expect(parseNumberQuery("12036,, 12037")).toBeNull();
    });

    it("should parse trailing comma", () => {
      expect(parseNumberQuery("123, 124,")).toEqual({
        kind: "multi",
        numbers: [123, 124],
      });
      expect(parseNumberQuery("12036,12037,")).toEqual({
        kind: "multi",
        numbers: [12036, 12037],
      });
    });

    it("should parse a single number with a trailing comma", () => {
      expect(parseNumberQuery("12036,")).toEqual({ kind: "single", number: 12036 });
      expect(parseNumberQuery("#12036 ,")).toEqual({ kind: "single", number: 12036 });
    });

    it("should parse whitespace-separated numbers", () => {
      expect(parseNumberQuery("12036 12037 12041")).toEqual({
        kind: "multi",
        numbers: [12036, 12037, 12041],
      });
      expect(parseNumberQuery("#12036  #12037")).toEqual({
        kind: "multi",
        numbers: [12036, 12037],
      });
    });

    it('should parse an "and"-joined list', () => {
      expect(parseNumberQuery("12036, 12037, and 12041")).toEqual({
        kind: "multi",
        numbers: [12036, 12037, 12041],
      });
      expect(parseNumberQuery("#12036, 12037 and 12041")).toEqual({
        kind: "multi",
        numbers: [12036, 12037, 12041],
      });
      expect(parseNumberQuery("123 AND 124")).toEqual({
        kind: "multi",
        numbers: [123, 124],
      });
    });

    it("should de-duplicate across mixed separators", () => {
      expect(parseNumberQuery("123 123 and #124")).toEqual({
        kind: "multi",
        numbers: [123, 124],
      });
    });

    it("should reject a dangling connector", () => {
      expect(parseNumberQuery("123 and")).toBeNull();
      expect(parseNumberQuery("and 123")).toBeNull();
      expect(parseNumberQuery("123 and 124 and")).toBeNull();
    });

    it("should reject separators the parser does not speak", () => {
      expect(parseNumberQuery("123 & 124")).toBeNull();
      expect(parseNumberQuery("123;124")).toBeNull();
      expect(parseNumberQuery("123 or 124")).toBeNull();
    });

    it("should keep every number in a list beyond MULTI_FETCH_CAP", () => {
      const numbers = Array.from({ length: MULTI_FETCH_CAP + 1 }, (_, i) => i + 1);
      expect(parseNumberQuery(numbers.join(", "))).toEqual({ kind: "multi", numbers });
    });

    it("should treat all-duplicate comma list as single", () => {
      expect(parseNumberQuery("123, 123")).toEqual({ kind: "single", number: 123 });
      expect(parseNumberQuery("#123,#123")).toEqual({ kind: "single", number: 123 });
    });

    it("should handle spaces around commas", () => {
      expect(parseNumberQuery("123 , 124")).toEqual({
        kind: "multi",
        numbers: [123, 124],
      });
    });
  });

  describe("range", () => {
    it("should parse basic range", () => {
      expect(parseNumberQuery("123..125")).toEqual({
        kind: "range",
        from: 123,
        to: 125,
        truncated: false,
      });
    });

    it("should parse hash-prefixed range", () => {
      expect(parseNumberQuery("#123..125")).toEqual({
        kind: "range",
        from: 123,
        to: 125,
        truncated: false,
      });
    });

    it("should handle single-item range (from === to)", () => {
      expect(parseNumberQuery("123..123")).toEqual({
        kind: "range",
        from: 123,
        to: 123,
        truncated: false,
      });
    });

    it("should truncate ranges exceeding MULTI_FETCH_CAP", () => {
      const result = parseNumberQuery("1..25");
      expect(result).toEqual({
        kind: "range",
        from: 1,
        to: MULTI_FETCH_CAP,
        truncated: true,
      });
    });

    it("should truncate with shifted start (from > 1)", () => {
      expect(parseNumberQuery("100..125")).toEqual({
        kind: "range",
        from: 100,
        to: 100 + MULTI_FETCH_CAP - 1,
        truncated: true,
      });
    });

    it("should not truncate ranges at exactly MULTI_FETCH_CAP", () => {
      expect(parseNumberQuery("1..20")).toEqual({
        kind: "range",
        from: 1,
        to: 20,
        truncated: false,
      });
    });

    it("should reject descending ranges", () => {
      expect(parseNumberQuery("125..123")).toBeNull();
    });

    it("should reject incomplete range (no end)", () => {
      expect(parseNumberQuery("123..")).toBeNull();
    });

    it("should reject incomplete range (no start)", () => {
      expect(parseNumberQuery("..125")).toBeNull();
    });

    it("should reject zero in range", () => {
      expect(parseNumberQuery("0..5")).toBeNull();
    });
  });

  describe("open-ended", () => {
    it("should parse bare open-ended", () => {
      expect(parseNumberQuery("125+")).toEqual({ kind: "open-ended", from: 125 });
    });

    it("should parse hash-prefixed open-ended", () => {
      expect(parseNumberQuery("#125+")).toEqual({ kind: "open-ended", from: 125 });
    });

    it("should reject zero", () => {
      expect(parseNumberQuery("0+")).toBeNull();
    });

    it("should reject trailing text after plus", () => {
      expect(parseNumberQuery("123+foo")).toBeNull();
    });
  });

  describe("invalid inputs", () => {
    it("should return null for empty string", () => {
      expect(parseNumberQuery("")).toBeNull();
    });

    it("should return null for whitespace only", () => {
      expect(parseNumberQuery("   ")).toBeNull();
    });

    it("should return null for text", () => {
      expect(parseNumberQuery("abc")).toBeNull();
    });

    it("should reject hyphen range syntax", () => {
      expect(parseNumberQuery("123-125")).toBeNull();
      expect(parseNumberQuery("#123-125")).toBeNull();
    });

    it("should return null for mixed text and numbers", () => {
      expect(parseNumberQuery("issue 123")).toBeNull();
    });

    it("should reject double-hash range syntax", () => {
      expect(parseNumberQuery("#123..#125")).toBeNull();
    });

    it("should reject spaced range and open-ended syntax", () => {
      expect(parseNumberQuery("123 .. 125")).toBeNull();
      expect(parseNumberQuery("123 +")).toBeNull();
    });
  });
});

describe("looksLikeNumberList", () => {
  it("flags number lists the parser rejected", () => {
    expect(looksLikeNumberList("123,,124")).toBe(true);
    expect(looksLikeNumberList("12036,, 12037")).toBe(true);
    expect(looksLikeNumberList("123 & 124")).toBe(true);
    expect(looksLikeNumberList("123;124")).toBe(true);
    expect(looksLikeNumberList("12036, 12037, or 12041")).toBe(true);
    expect(looksLikeNumberList("#123 , , #124")).toBe(true);
  });

  it("stays quiet for queries the parser accepts", () => {
    expect(looksLikeNumberList("123")).toBe(false);
    expect(looksLikeNumberList("123, 124,")).toBe(false);
    expect(looksLikeNumberList("12036 12037 12041")).toBe(false);
    expect(looksLikeNumberList("12036, 12037, and 12041")).toBe(false);
    expect(looksLikeNumberList("1..5")).toBe(false);
    expect(looksLikeNumberList("130+")).toBe(false);
  });

  it("stays quiet for ordinary text searches", () => {
    expect(looksLikeNumberList("")).toBe(false);
    expect(looksLikeNumberList("   ")).toBe(false);
    expect(looksLikeNumberList("fix 123 crash")).toBe(false);
    expect(looksLikeNumberList("issue 123")).toBe(false);
    expect(looksLikeNumberList("2024 2025 roadmap")).toBe(false);
    expect(looksLikeNumberList("12036 12037 fix")).toBe(false);
  });

  it("stays quiet for version strings and dates", () => {
    expect(looksLikeNumberList("1.2.3")).toBe(false);
    expect(looksLikeNumberList("2024-01-15")).toBe(false);
    expect(looksLikeNumberList("1/2/2024")).toBe(false);
    expect(looksLikeNumberList("123-125")).toBe(false);
  });

  it("needs two numbers before it speaks", () => {
    expect(looksLikeNumberList("123 and")).toBe(false);
    expect(looksLikeNumberList("123,,")).toBe(false);
    expect(looksLikeNumberList("0")).toBe(false);
  });
});
