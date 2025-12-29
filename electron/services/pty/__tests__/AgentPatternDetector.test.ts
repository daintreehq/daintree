import { describe, it, expect } from "vitest";
import {
  createPatternDetector,
  stripAnsi,
  AGENT_PATTERN_CONFIGS,
  UNIVERSAL_PATTERN_CONFIG,
} from "../AgentPatternDetector.js";

describe("AgentPatternDetector", () => {
  describe("stripAnsi", () => {
    it("should strip CSI color codes", () => {
      const input = "\x1b[32mHello\x1b[0m World";
      expect(stripAnsi(input)).toBe("Hello World");
    });

    it("should strip CSI cursor movement codes", () => {
      const input = "\x1b[2A\x1b[3BText\x1b[K";
      expect(stripAnsi(input)).toBe("Text");
    });

    it("should strip OSC sequences", () => {
      const input = "\x1b]0;Terminal Title\x07Some text";
      expect(stripAnsi(input)).toBe("Some text");
    });

    it("should strip OSC sequences with ST terminator", () => {
      const input = "\x1b]8;;https://example.com\x1b\\Link\x1b]8;;\x1b\\";
      expect(stripAnsi(input)).toBe("Link");
    });

    it("should handle mixed ANSI codes", () => {
      const input = "\x1b[33m\x1b[1mBold Yellow\x1b[0m \x1b[2AUp 2 lines";
      expect(stripAnsi(input)).toBe("Bold Yellow Up 2 lines");
    });

    it("should preserve non-ANSI content", () => {
      const input = "Plain text without any escape codes";
      expect(stripAnsi(input)).toBe("Plain text without any escape codes");
    });
  });

  describe("Claude pattern detection", () => {
    const detector = createPatternDetector("claude");

    it("should detect full Claude working pattern with interrupt hint", () => {
      const output = "Some output\n✽ Deliberating… (esc to interrupt · 15s)";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(true);
      expect(result.matchTier).toBe("primary");
      expect(result.confidence).toBe(0.95);
    });

    it("should detect Claude pattern with different spinner character", () => {
      const output = "◇ Reading files… (esc to interrupt · 3s)";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(true);
      expect(result.matchTier).toBe("primary");
    });

    it("should detect minimal Claude pattern (fallback)", () => {
      const output = "✽ thinking";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(true);
      expect(result.matchTier).toBe("fallback");
      expect(result.confidence).toBe(0.75);
    });

    it("should detect Claude deliberating pattern", () => {
      const output = "✽ deliberating";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(true);
      expect(result.matchTier).toBe("fallback");
    });

    it("should detect Claude searching pattern", () => {
      const output = "○ searching for files...";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(true);
      expect(result.matchTier).toBe("fallback");
    });

    it("should not match on idle Claude output", () => {
      const output = "User prompt completed.\n\nWhat would you like me to help you with?";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(false);
      expect(result.matchTier).toBe("none");
    });

    it("should handle output with ANSI codes", () => {
      const output = "\x1b[33m✽\x1b[0m \x1b[1mDeliberating…\x1b[0m (esc to interrupt · 5s)";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(true);
      expect(result.matchTier).toBe("primary");
    });

    it("should detect pattern in last N lines only", () => {
      // Pattern in first line, followed by many other lines
      const lines = ["✽ thinking", ...Array(20).fill("Regular output line")];
      const output = lines.join("\n");
      const result = detector.detect(output);

      // Pattern should not be detected since it's outside scan window
      expect(result.isWorking).toBe(false);
    });

    it("should detect pattern in last lines when present", () => {
      // Many lines followed by pattern at end
      const lines = [...Array(20).fill("Regular output line"), "✽ Working… (esc to interrupt)"];
      const output = lines.join("\n");
      const result = detector.detect(output);

      expect(result.isWorking).toBe(true);
    });
  });

  describe("Gemini pattern detection", () => {
    const detector = createPatternDetector("gemini");

    it("should detect Gemini working pattern with cancel hint", () => {
      const output = "⠼ Unpacking Project Details (esc to cancel, 14s)";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(true);
      expect(result.matchTier).toBe("primary");
      expect(result.confidence).toBe(0.95);
    });

    it("should detect Gemini pattern with different spinner state", () => {
      const output = "⠋ Analyzing code structure (esc to cancel, 2s)";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(true);
      expect(result.matchTier).toBe("primary");
    });

    it("should detect Gemini spinner fallback pattern", () => {
      const output = "⠙ Processing";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(true);
      expect(result.matchTier).toBe("fallback");
      expect(result.confidence).toBe(0.7);
    });

    it("should not match idle Gemini output", () => {
      const output = "Task completed. What else can I help with?";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(false);
    });
  });

  describe("Codex pattern detection", () => {
    const detector = createPatternDetector("codex");

    it("should detect Codex working pattern with interrupt hint", () => {
      const output = "• Working (1s • esc to interrupt)";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(true);
      expect(result.matchTier).toBe("primary");
      expect(result.confidence).toBe(0.95);
    });

    it("should detect Codex pattern with middle dot", () => {
      const output = "· Working (5s · esc to interrupt)";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(true);
      expect(result.matchTier).toBe("primary");
    });

    it("should detect minimal Codex working pattern (fallback)", () => {
      const output = "• Working";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(true);
      expect(result.matchTier).toBe("fallback");
      expect(result.confidence).toBe(0.75);
    });

    it("should not match idle Codex output", () => {
      const output = "Done. Ready for next task.";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(false);
    });
  });

  describe("Universal pattern detection", () => {
    const detector = createPatternDetector(); // No agent ID = universal

    it("should detect generic 'esc to interrupt' pattern", () => {
      const output = "Processing... (esc to interrupt)";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(true);
      expect(result.matchTier).toBe("primary");
    });

    it("should detect generic 'esc to cancel' pattern", () => {
      const output = "Running task (esc to cancel)";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(true);
      expect(result.matchTier).toBe("primary");
    });

    it("should detect spinner with activity word (fallback)", () => {
      const output = "✽ working on your request";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(true);
      expect(result.matchTier).toBe("fallback");
    });
  });

  describe("detectFromLines", () => {
    const detector = createPatternDetector("claude");

    it("should detect pattern from array of lines", () => {
      const lines = [
        "Previous output line 1",
        "Previous output line 2",
        "✽ Deliberating… (esc to interrupt · 10s)",
      ];
      const result = detector.detectFromLines(lines);

      expect(result.isWorking).toBe(true);
      expect(result.matchTier).toBe("primary");
    });

    it("should handle empty lines array", () => {
      const result = detector.detectFromLines([]);

      expect(result.isWorking).toBe(false);
      expect(result.confidence).toBe(0);
    });

    it("should strip ANSI from individual lines", () => {
      const lines = ["\x1b[32m✽ thinking\x1b[0m"];
      const result = detector.detectFromLines(lines);

      expect(result.isWorking).toBe(true);
    });
  });

  describe("custom configuration", () => {
    it("should use custom patterns when provided", () => {
      const customConfig = {
        primaryPatterns: [/custom-working-indicator/i],
        fallbackPatterns: [/maybe-working/i],
        scanLineCount: 5,
        primaryConfidence: 0.99,
        fallbackConfidence: 0.6,
      };

      const detector = createPatternDetector(undefined, customConfig);

      const result1 = detector.detect("custom-working-indicator");
      expect(result1.isWorking).toBe(true);
      expect(result1.confidence).toBe(0.99);

      const result2 = detector.detect("maybe-working");
      expect(result2.isWorking).toBe(true);
      expect(result2.confidence).toBe(0.6);

      const result3 = detector.detect("esc to interrupt");
      expect(result3.isWorking).toBe(false);
    });
  });

  describe("pattern configuration validation", () => {
    it("should have claude patterns defined", () => {
      expect(AGENT_PATTERN_CONFIGS.claude).toBeDefined();
      expect(AGENT_PATTERN_CONFIGS.claude.primaryPatterns.length).toBeGreaterThan(0);
    });

    it("should have gemini patterns defined", () => {
      expect(AGENT_PATTERN_CONFIGS.gemini).toBeDefined();
      expect(AGENT_PATTERN_CONFIGS.gemini.primaryPatterns.length).toBeGreaterThan(0);
    });

    it("should have codex patterns defined", () => {
      expect(AGENT_PATTERN_CONFIGS.codex).toBeDefined();
      expect(AGENT_PATTERN_CONFIGS.codex.primaryPatterns.length).toBeGreaterThan(0);
    });

    it("should have universal patterns defined", () => {
      expect(UNIVERSAL_PATTERN_CONFIG.primaryPatterns.length).toBeGreaterThan(0);
    });
  });

  describe("edge cases", () => {
    const detector = createPatternDetector("claude");

    it("should handle empty string", () => {
      const result = detector.detect("");
      expect(result.isWorking).toBe(false);
      expect(result.matchTier).toBe("none");
    });

    it("should handle null/undefined gracefully", () => {
      // TypeScript would normally prevent this, but testing runtime safety
      const result = detector.detect(null as unknown as string);
      expect(result.isWorking).toBe(false);
    });

    it("should handle very long output", () => {
      const longOutput = "x".repeat(100000) + "\n✽ thinking";
      const result = detector.detect(longOutput);

      // Should still detect pattern in last lines
      expect(result.isWorking).toBe(true);
    });

    it("should handle output with only newlines", () => {
      const result = detector.detect("\n\n\n\n\n");
      expect(result.isWorking).toBe(false);
    });

    it("should handle mixed unicode characters", () => {
      const output = "🚀 ✽ thinking about 日本語";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(true);
    });
  });
});
