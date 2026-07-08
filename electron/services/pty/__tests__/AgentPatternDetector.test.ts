import { describe, it, expect } from "vitest";
import {
  createPatternDetector,
  stripAnsi,
  UNIVERSAL_PATTERN_CONFIG,
} from "../AgentPatternDetector.js";
import { getAgentConfig } from "../../../../shared/config/agentRegistry.js";
import { buildPatternConfig } from "../terminalActivityPatterns.js";

function buildTestDetector(agentId: string) {
  const detection = getAgentConfig(agentId)?.detection;
  if (!detection) throw new Error(`No detection config for agent "${agentId}" in AGENT_REGISTRY`);
  const config = buildPatternConfig(detection, agentId);
  if (!config) throw new Error(`buildPatternConfig returned undefined for agent "${agentId}"`);
  return createPatternDetector(agentId, config);
}

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
    const detector = buildTestDetector("claude");

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
    const detector = buildTestDetector("gemini");

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

    it("should detect Braille spinner glyphs outside the legacy 10-codepoint subset (primary)", () => {
      // ⣿ (U+28FF) is at the end of the Braille block; not in the old subset.
      const output = "⣿ Analyzing code structure (esc to cancel, 3s)";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(true);
      expect(result.matchTier).toBe("primary");
    });

    it("should detect Braille spinner glyphs outside the legacy 10-codepoint subset (fallback)", () => {
      // ⡿ (U+287F), ⢿ (U+28BF), ⣟ (U+28DF) all fall in the widened range.
      for (const ch of ["⡿", "⢿", "⣟", "⣿"]) {
        const result = detector.detect(`${ch} Processing`);
        expect(result.isWorking).toBe(true);
        expect(result.matchTier).toBe("fallback");
      }
    });

    it("should detect low/mid/high Braille glyphs across U+2800–U+28FF block", () => {
      // Guards against the registry string pattern drifting back to a narrow
      // subset: sample codepoints across the block (excluding U+2800 blank).
      const samples = ["⠁", "⡀", "⢀", "⣀", "⣿"];
      for (const ch of samples) {
        const result = detector.detect(`${ch} Generating response (esc to cancel, 1s)`);
        expect(result.isWorking).toBe(true);
        expect(result.matchTier).toBe("primary");
      }
    });
  });

  describe("Codex pattern detection", () => {
    const detector = buildTestDetector("codex");

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

    it("should detect widened Braille glyphs in universal patterns", () => {
      // Glyphs outside the legacy 10-codepoint subset are now part of the
      // universal char class, so primary-tier matches still trigger.
      const output = "⣿ Working (esc to interrupt)";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(true);
      expect(result.matchTier).toBe("primary");
    });

    it("should detect widened Braille glyph + activity word in fallback", () => {
      const output = "⣿ thinking through the problem";
      const result = detector.detect(output);

      expect(result.isWorking).toBe(true);
      expect(result.matchTier).toBe("fallback");
    });
  });

  describe("detectFromLines", () => {
    const detector = buildTestDetector("claude");

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
    it.each(["claude", "gemini", "codex", "opencode", "cursor", "kiro", "copilot", "crush"])(
      "%s registry patterns compile to a valid config",
      (agentId) => {
        const detection = getAgentConfig(agentId)?.detection;
        expect(detection).toBeDefined();
        const config = buildPatternConfig(detection!, agentId);
        expect(config).toBeDefined();
        expect(config!.primaryPatterns.length).toBeGreaterThan(0);
      }
    );

    it("should have universal patterns defined", () => {
      expect(UNIVERSAL_PATTERN_CONFIG.primaryPatterns.length).toBeGreaterThan(0);
    });
  });

  describe("registry fallback path (no customConfig)", () => {
    it("resolves the registry detection config when no customConfig is provided", () => {
      const detector = createPatternDetector("claude");
      const result = detector.detect("✽ Deliberating… (esc to interrupt · 15s)");
      expect(result.isWorking).toBe(true);
      expect(result.matchTier).toBe("primary");
    });

    it("registry-resolved detector matches the explicitly-built config's verdicts", () => {
      const explicit = buildTestDetector("codex");
      const fromRegistry = createPatternDetector("codex");
      for (const sample of ["• Working (1s • esc to interrupt)", "› ", "plain unrelated output"]) {
        expect(fromRegistry.detect(sample)).toEqual(explicit.detect(sample));
      }
    });

    it("unknown agents fall back to the universal config", () => {
      const detector = createPatternDetector("some-unregistered-agent");
      expect(detector.detect("✽ Thinking… (esc to interrupt · 2s)").isWorking).toBe(true);
      expect(detector.detect("plain output").isWorking).toBe(false);
    });
  });

  describe("long status text detection (issue #1444)", () => {
    describe("Codex patterns with long descriptions", () => {
      const detector = buildTestDetector("codex");

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
      const detector = buildTestDetector("claude");

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
      const detector = buildTestDetector("gemini");

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
      it("prose with a long tail after the hint no longer matches", () => {
        // The end-of-line hint pattern bounds its tail to ~20 chars: real
        // status lines trail only short time info ("· 15s)"), while prose
        // keeps talking past the hint.
        const detector = buildTestDetector("codex");
        const output = "Press esc to interrupt the operation when it is needed";
        const result = detector.detect(output);

        expect(result.isWorking).toBe(false);
      });

      it("prose with a long tail does not match for claude either", () => {
        const detector = buildTestDetector("claude");
        const output = "You can always use esc to interrupt whenever the task takes too long";
        const result = detector.detect(output);

        expect(result.isWorking).toBe(false);
      });

      it("escape hints with a short tail may still trigger detection (accepted ambiguity)", () => {
        const detector = buildTestDetector("gemini");
        const output =
          "Task complete. Remember esc to cancel works anytime.\n\nReady for next task.";
        const result = detector.detect(output);

        expect(result.isWorking).toBe(true);
        expect(result.matchTier).toBe("primary");
      });
    });

    describe("ANSI codes in long status text", () => {
      it("should detect Codex pattern with ANSI-colored long description", () => {
        const detector = buildTestDetector("codex");
        const longDescription =
          "Exploring files with search and listing across multiple directories";
        const output = `\x1b[34m•\x1b[0m \x1b[1m${longDescription}\x1b[0m (4s • esc to interrupt)`;
        const result = detector.detect(output);

        expect(result.isWorking).toBe(true);
        expect(result.matchTier).toBe("primary");
      });

      it("should detect escape hint with ANSI codes at end of line", () => {
        const detector = buildTestDetector("claude");
        const output = "Very long text here \x1b[2mesc to interrupt\x1b[0m)";
        const result = detector.detect(output);

        expect(result.isWorking).toBe(true);
      });
    });
  });

  describe("edge cases", () => {
    const detector = buildTestDetector("claude");

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

  describe("alreadyStripped option", () => {
    it("strips by default and yields the same result as pre-stripped input", () => {
      const detector = buildTestDetector("codex");
      const raw = "\x1b[34m•\x1b[0m Exploring the codebase (4s • esc to interrupt)";
      const fromRaw = detector.detect(raw);
      const fromStripped = detector.detect(stripAnsi(raw), { alreadyStripped: true });

      expect(fromRaw.isWorking).toBe(true);
      expect(fromRaw.matchTier).toBe("primary");
      expect(fromStripped).toEqual(fromRaw);
    });

    it("skips the internal strip when alreadyStripped is true", () => {
      const detector = buildTestDetector("claude");
      // ANSI codes sit between the spinner and the verb, so the fallback
      // pattern (spinner + whitespace + verb + ellipsis) only matches once
      // stripped. With alreadyStripped:true the strip is skipped, so no match.
      const raw = "✽\x1b[0m Thinking…";

      expect(detector.detect(raw).isWorking).toBe(true);
      expect(detector.detect(raw, { alreadyStripped: true }).isWorking).toBe(false);
    });
  });

  describe("last-N-lines scan window", () => {
    const detector = buildTestDetector("claude");
    const pattern = "✽ Thinking…";

    it("detects a pattern on the 10th line from the end", () => {
      const noise = Array(9).fill("noise").join("\n");
      const result = detector.detect(`${pattern}\n${noise}`);
      expect(result.isWorking).toBe(true);
    });

    it("ignores a pattern on the 11th line from the end", () => {
      const noise = Array(10).fill("noise").join("\n");
      const result = detector.detect(`${pattern}\n${noise}`);
      expect(result.isWorking).toBe(false);
    });

    it("detects a pattern on the final line with a trailing newline", () => {
      const result = detector.detect(`${pattern}\n`);
      expect(result.isWorking).toBe(true);
    });

    it("detects a pattern when there is no trailing newline", () => {
      const result = detector.detect(`leading line\n${pattern}`);
      expect(result.isWorking).toBe(true);
    });

    it("matches split/slice/join window semantics across boundary inputs", () => {
      // Parity oracle: the old implementation joined the last scanLineCount
      // lines. The new lastIndexOf scan must scan exactly the same text.
      const scanLineCount = 10;
      const oracleWindow = (text: string) => text.split("\n").slice(-scanLineCount).join("\n");

      for (const lineCount of [1, 9, 10, 11, 25]) {
        for (const trailing of ["", "\n"]) {
          const lines = Array.from({ length: lineCount }, (_, i) =>
            i === 0 ? pattern : `noise-${i}`
          );
          const text = lines.join("\n") + trailing;
          const windowed = oracleWindow(text);
          // Detecting on the full text (new lastIndexOf window) must produce the
          // exact same result as detecting on the oracle-windowed text (old
          // split/slice/join). Full-object equality — not just isWorking — so a
          // tier/confidence drift can't hide behind a matching boolean.
          expect(detector.detect(text)).toEqual(detector.detect(windowed));
        }
      }
    });
  });

  describe("pattern flag invariants", () => {
    it("no configured pattern uses a stateful (/g, /y) flag", () => {
      const configs = [UNIVERSAL_PATTERN_CONFIG];
      for (const config of configs) {
        const patterns = [...config.primaryPatterns, ...(config.fallbackPatterns ?? [])];
        for (const pattern of patterns) {
          expect(pattern.flags).not.toContain("g");
          expect(pattern.flags).not.toContain("y");
        }
      }
    });
  });

  describe("hot-path allocation guarantees", () => {
    it("does not populate matchedText (debug field retired)", () => {
      const detector = buildTestDetector("claude");
      const result = detector.detect("✽ Deliberating… (esc to interrupt · 15s)");
      expect(result.isWorking).toBe(true);
      expect(result.matchedText).toBeUndefined();
    });

    it("returns identical results on repeated calls (no lastIndex mutation)", () => {
      const detector = buildTestDetector("claude");
      const output = "✽ Deliberating… (esc to interrupt · 15s)";
      const first = detector.detect(output);
      const second = detector.detect(output);
      expect(first).toEqual(second);
      expect(first.isWorking).toBe(true);
    });

    it("stays deterministic even with a stateful (/g) custom pattern", () => {
      // Guards the lastIndex reset in matchPatterns: a /g pattern would
      // otherwise advance lastIndex and miss on alternating calls.
      const detector = createPatternDetector(undefined, {
        primaryPatterns: [/working/g],
        scanLineCount: 10,
        primaryConfidence: 0.9,
      });
      expect(detector.detect("working").isWorking).toBe(true);
      expect(detector.detect("working").isWorking).toBe(true);
      expect(detector.detect("working").isWorking).toBe(true);
    });
  });

  describe("universal interrupt-hint coverage", () => {
    const detector = createPatternDetector(); // universal config

    it.each([
      ["Goose ctrl+c wording", "⠹ Reticulating splines… (Ctrl+C to interrupt)"],
      ["Cursor esc-to-stop wording", "⬢ Searching the codebase (esc to stop)"],
      ["OpenCode esc-again wording", "⣽ Building tool call… press esc again to interrupt"],
      ["Gemini comma time separator", "(14s, esc to cancel)"],
      ["Codex bullet time separator", "(4s • esc to interrupt)"],
      ["escape spelled out", "✶ Working on the change (escape to interrupt)"],
    ])("detects %s", (_name, output) => {
      expect(detector.detect(output).isWorking).toBe(true);
    });

    it("does not fire on prose that merely mentions the escape key", () => {
      const output = "I added a handler so pressing esc to cancel the dialog works. Done.";
      expect(detector.detect(output).isWorking).toBe(false);
    });
  });

  describe("wrapped status lines", () => {
    it("detects a hint that soft-wrapped mid-word across visual rows", () => {
      const detector = buildTestDetector("claude");
      // A narrow terminal wraps "esc to interrupt" across the row boundary.
      const rows = ["✽ Refactoring the terminal identity module… (esc to inte", "rrupt · 15s)"];
      const result = detector.detectFromLines(rows);
      expect(result.isWorking).toBe(true);
    });

    it("detects a hint that wrapped cleanly onto its own row", () => {
      const detector = buildTestDetector("gemini");
      const rows = [
        "⠼ Unpacking a very long project description that wraps (",
        "esc to cancel, 14s)",
      ];
      expect(detector.detectFromLines(rows).isWorking).toBe(true);
    });

    it("detects a wrapped hint row with a long time + token-counter tail", () => {
      // Tails past the 20-char short bound are still status lines when they
      // end in ")" — a wrapped row carrying elapsed time and token counters
      // must not be mistaken for prose.
      const detector = buildTestDetector("claude");
      const rows = [
        "✽ Refactoring the analysis worker pool and rebuilding slots… (",
        "esc to interrupt · 1m 23s · ↓ 4.2k tokens)",
      ];
      expect(detector.detectFromLines(rows).isWorking).toBe(true);
    });
  });

  describe("working signal beats a visible prompt", () => {
    it("still reports working when a prompt row sits under the status line", () => {
      // Agents redraw their input prompt while background work continues; the
      // working indicator must win over the prompt-looking row.
      const detector = buildTestDetector("claude");
      const rows = ["✽ Running tests… (esc to interrupt · 32s)", "", "> "];
      expect(detector.detectFromLines(rows).isWorking).toBe(true);
    });
  });

  describe("raw-window edge cases", () => {
    it("detects a working indicator followed by an OSC payload with embedded newlines", () => {
      // detect() windows the RAW buffer to the last N lines before stripping.
      // Newlines inside an OSC payload inflate the raw line count, so a naive
      // window could start inside the payload and miss the indicator that
      // precedes it — the widen-and-rewindow fallback must recover it.
      const detector = buildTestDetector("claude");
      const oscWithNewlines = `\x1b]0;${"\n".repeat(20)}\x07`;
      const output = "line above\n✽ Running tests… (esc to interrupt · 32s)" + oscWithNewlines;
      expect(detector.detect(output).isWorking).toBe(true);
    });
  });
});
