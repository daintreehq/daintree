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
      const output = "✽ Thinking…";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(true);
      expect(result.matchTier).toBe("fallback");
      expect(result.confidence).toBe(0.75);
    });

    it("should detect Claude deliberating pattern (fallback)", () => {
      const output = "✻ Deliberating…";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(true);
      expect(result.matchTier).toBe("fallback");
    });

    it("should detect custom spinnerVerb (fallback)", () => {
      const output = "✶ Cogitating…";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(true);
      expect(result.matchTier).toBe("fallback");
    });

    it("should detect new v2.1.79 spinner chars with primary pattern", () => {
      const chars = ["·", "*", "✢", "✳", "✶"];
      for (const char of chars) {
        const output = `${char} Working… (esc to interrupt · 5s)`;
        const result = detector.detect(output);
        expect(result.isWorking).toBe(true);
        expect(result.matchTier).toBe("primary");
      }
    });

    it("should detect reduced-motion spinner (primary)", () => {
      const output = "● Processing… (esc to interrupt · 10s)";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(true);
      expect(result.matchTier).toBe("primary");
    });

    it("should not match middle dot or asterisk in fallback (false positive prevention)", () => {
      const dotResult = detector.detect("· some text…");
      expect(dotResult.isWorking).toBe(false);

      const starResult = detector.detect("* some text…");
      expect(starResult.isWorking).toBe(false);
    });

    it("should detect fallback-only with new v2.1.79 spinner char (no esc to interrupt)", () => {
      const output = "✢ Analyzing…";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(true);
      expect(result.matchTier).toBe("fallback");
      expect(result.confidence).toBe(0.75);
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
      const lines = ["✽ Thinking…", ...Array(20).fill("Regular output line")];
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
      const output = "✽ Processing... (esc to interrupt)";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(true);
      expect(result.matchTier).toBe("primary");
    });

    it("should detect generic 'esc to cancel' pattern", () => {
      const output = "⠼ Running task (esc to cancel)";
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
      const lines = ["\x1b[32m✽ Thinking…\x1b[0m"];
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

  describe("long status text detection (issue #1444)", () => {
    describe("Codex patterns with long descriptions", () => {
      const detector = createPatternDetector("codex");

      it("should detect pattern with very long status text (120+ chars)", () => {
        const longDescription =
          "Exploring files with search and listing across multiple directories including node_modules and checking for dependencies in package.json";
        const output = `• ${longDescription} (4s • esc to interrupt)`;
        const result = detector.detect(output);

        expect(result.isWorking).toBe(true);
        expect(result.matchTier).toBe("primary");
      });

      it("should detect pattern with just time + escape hint structure", () => {
        const output = "(15s • esc to interrupt)";
        const result = detector.detect(output);

        expect(result.isWorking).toBe(true);
        expect(result.matchTier).toBe("primary");
      });

      it("should detect 'esc to interrupt' at end of line", () => {
        const output = "some very long text esc to interrupt)";
        const result = detector.detect(output);

        expect(result.isWorking).toBe(true);
        expect(result.matchTier).toBe("primary");
      });

      it("should detect pattern when status text wraps to new line", () => {
        const output = `• Exploring files with search and listing across multiple
(4s • esc to interrupt)`;
        const result = detector.detect(output);

        expect(result.isWorking).toBe(true);
        expect(result.matchTier).toBe("primary");
      });

      it("should detect escape hint on separate line after wrap", () => {
        const output = `Previous output
• Very long status description that gets cut off at terminal edge and
wraps to the next line where the escape hint appears: esc to interrupt)`;
        const result = detector.detect(output);

        expect(result.isWorking).toBe(true);
      });
    });

    describe("Claude patterns with long descriptions", () => {
      const detector = createPatternDetector("claude");

      it("should detect pattern with very long status text (120+ chars)", () => {
        const longDescription =
          "Deliberating about the best approach to implement the feature while considering multiple factors and edge cases that might arise";
        const output = `✽ ${longDescription} (esc to interrupt · 15s)`;
        const result = detector.detect(output);

        expect(result.isWorking).toBe(true);
        expect(result.matchTier).toBe("primary");
      });

      it("should detect pattern with just time + escape hint structure", () => {
        const output = "(15s · esc to interrupt)";
        const result = detector.detect(output);

        expect(result.isWorking).toBe(true);
        expect(result.matchTier).toBe("primary");
      });

      it("should detect 'esc to interrupt' at end of line", () => {
        const output = "some very long wrapped text esc to interrupt)";
        const result = detector.detect(output);

        expect(result.isWorking).toBe(true);
        expect(result.matchTier).toBe("primary");
      });
    });

    describe("Gemini patterns with long descriptions", () => {
      const detector = createPatternDetector("gemini");

      it("should detect pattern with very long status text (120+ chars)", () => {
        const longDescription =
          "Unpacking Project Details including analyzing the directory structure and understanding the codebase architecture thoroughly";
        const output = `⠼ ${longDescription} (esc to cancel, 14s)`;
        const result = detector.detect(output);

        expect(result.isWorking).toBe(true);
        expect(result.matchTier).toBe("primary");
      });

      it("should detect pattern with just time + escape hint structure", () => {
        const output = "(14s, esc to cancel)";
        const result = detector.detect(output);

        expect(result.isWorking).toBe(true);
        expect(result.matchTier).toBe("primary");
      });

      it("should detect 'esc to cancel' at end of line", () => {
        const output = "some very long wrapped text esc to cancel)";
        const result = detector.detect(output);

        expect(result.isWorking).toBe(true);
        expect(result.matchTier).toBe("primary");
      });
    });

    describe("Universal patterns with long descriptions", () => {
      const detector = createPatternDetector();

      it("should detect 'esc to interrupt' at end of line regardless of text before", () => {
        const output =
          "A very long status description that exceeds 80 characters and might cause issues with pattern matching esc to interrupt)";
        const result = detector.detect(output);

        expect(result.isWorking).toBe(true);
        expect(result.matchTier).toBe("primary");
      });

      it("should detect 'esc to cancel' at end of line regardless of text before", () => {
        const output =
          "A very long status description that exceeds 80 characters and might cause issues with pattern matching esc to cancel)";
        const result = detector.detect(output);

        expect(result.isWorking).toBe(true);
        expect(result.matchTier).toBe("primary");
      });
    });

    describe("Known pattern behavior", () => {
      it("end-of-line patterns may match help text (acceptable tradeoff)", () => {
        const detector = createPatternDetector("codex");
        const output = "Press esc to interrupt the operation when needed";
        const result = detector.detect(output);

        expect(result.isWorking).toBe(true);
        expect(result.matchTier).toBe("primary");
      });

      it("patterns prioritize detecting real status over avoiding false positives", () => {
        const detector = createPatternDetector("claude");
        const output = "You can always use esc to interrupt if the task takes too long";
        const result = detector.detect(output);

        expect(result.isWorking).toBe(true);
        expect(result.matchTier).toBe("primary");
      });

      it("escape hints in idle output may trigger detection (rare in practice)", () => {
        const detector = createPatternDetector("gemini");
        const output =
          "Task complete. Remember esc to cancel works anytime.\n\nReady for next task.";
        const result = detector.detect(output);

        expect(result.isWorking).toBe(true);
        expect(result.matchTier).toBe("primary");
      });
    });

    describe("ANSI codes in long status text", () => {
      it("should detect Codex pattern with ANSI-colored long description", () => {
        const detector = createPatternDetector("codex");
        const longDescription =
          "Exploring files with search and listing across multiple directories";
        const output = `\x1b[34m•\x1b[0m \x1b[1m${longDescription}\x1b[0m (4s • esc to interrupt)`;
        const result = detector.detect(output);

        expect(result.isWorking).toBe(true);
        expect(result.matchTier).toBe("primary");
      });

      it("should detect escape hint with ANSI codes at end of line", () => {
        const detector = createPatternDetector("claude");
        const output = "Very long text here \x1b[2mesc to interrupt\x1b[0m)";
        const result = detector.detect(output);

        expect(result.isWorking).toBe(true);
      });
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
      const longOutput = "x".repeat(100000) + "\n✽ Thinking…";
      const result = detector.detect(longOutput);

      // Should still detect pattern in last lines
      expect(result.isWorking).toBe(true);
    });

    it("should handle output with only newlines", () => {
      const result = detector.detect("\n\n\n\n\n");
      expect(result.isWorking).toBe(false);
    });

    it("should handle mixed unicode characters", () => {
      const output = "🚀 ✽ Thinking… about 日本語";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(true);
    });
  });
});
