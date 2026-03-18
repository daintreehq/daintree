import { describe, it, expect } from "vitest";
import { parseNumberQuery, MULTI_FETCH_CAP } from "../parseNumberQuery";

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
    });

    it("should reject trailing comma", () => {
      expect(parseNumberQuery("123, 124,")).toBeNull();
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
