import { describe, it, expect } from "vitest";
import {
  detectCompletion,
  extractCostFromLines,
  extractTokensFromLines,
} from "../CompletionDetector.js";

describe("detectCompletion", () => {
  it("returns false with no patterns", () => {
    const result = detectCompletion(["done"], [], 0.9, 6);
    expect(result.isCompletion).toBe(false);
  });

  it("detects completion pattern", () => {
    const patterns = [/Task completed/];
    const result = detectCompletion(["Task completed successfully"], patterns, 0.9, 6);
    expect(result.isCompletion).toBe(true);
    expect(result.confidence).toBe(0.9);
  });

  it("scans only last N lines", () => {
    const patterns = [/done/];
    const lines = ["done", "line1", "line2", "line3"];
    const result = detectCompletion(lines, patterns, 0.9, 2);
    // Only last 2 lines scanned
    expect(result.isCompletion).toBe(false);
  });

  it("returns false when no lines match", () => {
    const patterns = [/done/];
    const result = detectCompletion(["in progress"], patterns, 0.9, 6);
    expect(result.isCompletion).toBe(false);
  });

  it("strips ANSI from lines", () => {
    const patterns = [/done/];
    const result = detectCompletion(["\x1b[32mdone\x1b[0m"], patterns, 0.9, 6);
    expect(result.isCompletion).toBe(true);
  });

  describe("cost extraction", () => {
    const claudePatterns = [
      /[✢✳✶✻✽●]\s+\w+\s+for\s+\d/,
      /Total cost:\s+\$\d/,
      /Total duration/,
      /\$\d+\.\d+\s*·\s*\d+\s*tokens/,
    ];

    it("handles $0.00 cost correctly", () => {
      const result = detectCompletion(["Total cost:            $0.00"], claudePatterns, 0.9, 6);
      expect(result.isCompletion).toBe(true);
      expect(result.extractedCost).toBe(0);
    });
  });

  describe("token extraction", () => {
    const claudePatterns = [
      /[✢✳✶✻✽●]\s+\w+\s+for\s+\d/,
      /Total cost:\s+\$\d/,
      /Total duration/,
      /\$\d+\.\d+\s*·\s*\d+\s*tokens/,
    ];

    it("returns undefined tokens for modern Total cost format", () => {
      const result = detectCompletion(
        ["✻ Worked for 12s.", "Total cost:            $3.10"],
        claudePatterns,
        0.9,
        6
      );
      expect(result.isCompletion).toBe(true);
      expect(result.extractedCost).toBe(3.1);
      expect(result.extractedTokens).toBeUndefined();
    });

    it("extracts both cost and tokens from legacy format", () => {
      const result = detectCompletion(["$1.23 · 45000 tokens"], claudePatterns, 0.9, 6);
      expect(result.extractedCost).toBe(1.23);
      expect(result.extractedTokens).toBe(45000);
    });
  });

  describe("extractTokensFromLines", () => {
    it("extracts from legacy token format", () => {
      expect(extractTokensFromLines(["$0.50 · 1234 tokens"])).toBe(1234);
    });

    it("returns undefined for Total cost format", () => {
      expect(extractTokensFromLines(["Total cost:            $2.89"])).toBeUndefined();
    });

    it("returns undefined for non-cost lines", () => {
      expect(extractTokensFromLines(["some random output"])).toBeUndefined();
    });

    it("strips ANSI before matching", () => {
      expect(extractTokensFromLines(["\x1b[32m$0.50 · 999 tokens\x1b[0m"])).toBe(999);
    });

    it("extracts zero tokens", () => {
      expect(extractTokensFromLines(["$0.00 · 0 tokens"])).toBe(0);
    });

    it("parses comma-formatted token counts", () => {
      expect(extractTokensFromLines(["$0.50 · 1,234 tokens"])).toBe(1234);
    });

    it("parses Gemini stats-table token counts", () => {
      expect(extractTokensFromLines(["Total Tokens: 12,345"])).toBe(12345);
    });

    it("parses Codex token-usage summaries", () => {
      expect(extractTokensFromLines(["Token usage: total=8123"])).toBe(8123);
      expect(extractTokensFromLines(["Token usage: 8,123"])).toBe(8123);
    });

    it("parses 'tokens used' phrasing", () => {
      expect(extractTokensFromLines(["4,096 tokens used this session"])).toBe(4096);
    });
  });

  describe("extractCostFromLines", () => {
    it("extracts from Total cost line", () => {
      expect(extractCostFromLines(["Total cost:            $2.89"])).toBe(2.89);
    });

    it("extracts from token format", () => {
      expect(extractCostFromLines(["$0.50 · 1234 tokens"])).toBe(0.5);
    });

    it("returns undefined for non-cost lines", () => {
      expect(extractCostFromLines(["some random output"])).toBeUndefined();
    });

    it("strips ANSI before matching", () => {
      expect(extractCostFromLines(["\x1b[32mTotal cost:   $1.23\x1b[0m"])).toBe(1.23);
    });
  });
});
