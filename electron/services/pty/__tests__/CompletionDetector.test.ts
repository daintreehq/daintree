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

  it("uses configured confidence", () => {
    const patterns = [/done/];
    const result = detectCompletion(["done"], patterns, 0.75, 6);
    expect(result.confidence).toBe(0.75);
  });

  it("strips ANSI from lines", () => {
    const patterns = [/done/];
    const result = detectCompletion(["\x1b[32mdone\x1b[0m"], patterns, 0.9, 6);
    expect(result.isCompletion).toBe(true);
  });

  describe("Claude completion patterns (v2.1.79+)", () => {
    const claudePatterns = [
      /[✢✳✶✻✽●]\s+\w+\s+for\s+\d/,
      /Total cost:\s+\$\d/,
      /Total duration/,
      /\$\d+\.\d+\s*·\s*\d+\s*tokens/,
    ];

    it("detects 'Worked for' completion", () => {
      const result = detectCompletion(["✻ Worked for 12s."], claudePatterns, 0.9, 6);
      expect(result.isCompletion).toBe(true);
    });

    it("detects randomized past-tense verb completion", () => {
      const result = detectCompletion(["✽ Deliberated for 5s."], claudePatterns, 0.9, 6);
      expect(result.isCompletion).toBe(true);
    });

    it("detects Total cost line", () => {
      const result = detectCompletion(["Total cost:            $2.89"], claudePatterns, 0.9, 6);
      expect(result.isCompletion).toBe(true);
    });

    it("detects Total duration line", () => {
      const result = detectCompletion(["Total duration (API):  1m 2s"], claudePatterns, 0.9, 6);
      expect(result.isCompletion).toBe(true);
    });

    it("detects ANSI-wrapped completion", () => {
      const result = detectCompletion(["\x1b[32m✻ Worked for 5s.\x1b[0m"], claudePatterns, 0.9, 6);
      expect(result.isCompletion).toBe(true);
    });

    it("still detects legacy token cost format", () => {
      const result = detectCompletion(["$0.50 · 1234 tokens"], claudePatterns, 0.9, 6);
      expect(result.isCompletion).toBe(true);
    });
  });

  describe("cost extraction", () => {
    const claudePatterns = [
      /[✢✳✶✻✽●]\s+\w+\s+for\s+\d/,
      /Total cost:\s+\$\d/,
      /Total duration/,
      /\$\d+\.\d+\s*·\s*\d+\s*tokens/,
    ];

    it("extracts cost from 'Total cost' line", () => {
      const result = detectCompletion(
        ["✻ Worked for 12s.", "Total cost:            $2.89"],
        claudePatterns,
        0.9,
        6
      );
      expect(result.isCompletion).toBe(true);
      expect(result.extractedCost).toBe(2.89);
    });

    it("extracts cost from legacy token format", () => {
      const result = detectCompletion(["$0.50 · 1234 tokens"], claudePatterns, 0.9, 6);
      expect(result.isCompletion).toBe(true);
      expect(result.extractedCost).toBe(0.5);
    });

    it("extracts cost from ANSI-wrapped lines", () => {
      const result = detectCompletion(
        ["\x1b[32mTotal cost:            $3.14\x1b[0m"],
        claudePatterns,
        0.9,
        6
      );
      expect(result.isCompletion).toBe(true);
      expect(result.extractedCost).toBe(3.14);
    });

    it("returns undefined cost when no cost line present", () => {
      const result = detectCompletion(["Total duration (API):  1m 2s"], claudePatterns, 0.9, 6);
      expect(result.isCompletion).toBe(true);
      expect(result.extractedCost).toBeUndefined();
    });

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

    it("extracts tokens from legacy format", () => {
      const result = detectCompletion(["$0.50 · 1234 tokens"], claudePatterns, 0.9, 6);
      expect(result.isCompletion).toBe(true);
      expect(result.extractedTokens).toBe(1234);
    });

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

    it("does not match comma-formatted token counts", () => {
      expect(extractTokensFromLines(["$0.50 · 1,234 tokens"])).toBeUndefined();
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
