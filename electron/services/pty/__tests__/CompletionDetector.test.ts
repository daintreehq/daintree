import { describe, it, expect } from "vitest";
import { detectCompletion } from "../CompletionDetector.js";

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
});
