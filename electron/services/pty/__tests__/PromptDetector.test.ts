import { describe, it, expect } from "vitest";
import {
  detectPrompt,
  detectPromptLexeme,
  DEFAULT_PROMPT_PATTERNS,
  type PromptDetectorConfig,
} from "../PromptDetector.js";

function makeConfig(overrides?: Partial<PromptDetectorConfig>): PromptDetectorConfig {
  return {
    promptPatterns: DEFAULT_PROMPT_PATTERNS,
    promptHintPatterns: [],
    promptScanLineCount: 6,
    promptConfidence: 0.85,
    ...overrides,
  };
}

describe("detectPrompt", () => {
  it("returns false with no patterns", () => {
    const config = makeConfig({ promptPatterns: [], promptHintPatterns: [] });
    const result = detectPrompt(["$ "], config, "$ ");
    expect(result.isPrompt).toBe(false);
  });

  it("matches cursor line against prompt patterns", () => {
    const config = makeConfig();
    const result = detectPrompt(["line1"], config, "$ ");
    expect(result.isPrompt).toBe(true);
    expect(result.confidence).toBe(0.85);
  });

  it("matches cursor line against hint patterns", () => {
    const config = makeConfig({ promptHintPatterns: [/Type a message/] });
    const result = detectPrompt(["line1"], config, "Type a message");
    expect(result.isPrompt).toBe(true);
  });

  it("matches hint patterns in visible lines", () => {
    const config = makeConfig({ promptHintPatterns: [/Type a message/] });
    const result = detectPrompt(["Type a message"], config, "other text");
    expect(result.isPrompt).toBe(true);
  });

  it("falls back to history scan when cursor is empty", () => {
    const config = makeConfig();
    const result = detectPrompt(["", "$ ", ""], config, "");
    expect(result.isPrompt).toBe(true);
    expect(result.confidence).toBe(0.85 * 0.8);
  });

  it("blocks history scan when cursor has content and allowHistoryScan is false", () => {
    const config = makeConfig();
    const result = detectPrompt(["$ "], config, "some output");
    expect(result.isPrompt).toBe(false);
  });

  it("allows history scan when allowHistoryScan is true", () => {
    const config = makeConfig();
    const result = detectPrompt(["$ "], config, "some output", { allowHistoryScan: true });
    expect(result.isPrompt).toBe(true);
    expect(result.confidence).toBe(0.85 * 0.8);
  });

  it("scans only the last N lines", () => {
    const config = makeConfig({ promptScanLineCount: 2 });
    const lines = ["$ ", "line1", "line2", "line3"];
    const result = detectPrompt(lines, config, null);
    // Only last 2 lines are scanned, which don't contain $
    expect(result.isPrompt).toBe(false);
  });

  it("handles null cursor line", () => {
    const config = makeConfig();
    const result = detectPrompt(["$ "], config, null);
    expect(result.isPrompt).toBe(true);
  });

  it("matches various prompt characters", () => {
    const config = makeConfig();
    for (const prompt of ["$ ", "> ", "› ", "❯ ", "# ", "% "]) {
      const result = detectPrompt([prompt], config, prompt);
      expect(result.isPrompt).toBe(true);
    }
  });
});

describe("approval prompt detection via hint patterns", () => {
  const approvalHints = [
    /allow\s+once/i,
    /allow\s+always/i,
    /approve\s+once/i,
    /approve\s+this\s+session/i,
    /allow\s+permission/i,
    /deny\s+permission/i,
    /\[y[/\\]n\]/i,
    /\(y[/\\]n\)/i,
    /proceed\?\s*\[y/i,
  ];

  function approvalConfig(overrides?: Partial<PromptDetectorConfig>): PromptDetectorConfig {
    return makeConfig({ promptHintPatterns: approvalHints, ...overrides });
  }

  it("detects 'Approve Once' in visible lines", () => {
    const config = approvalConfig();
    const lines = [
      "Canopy wants to run: rm -rf /tmp/test",
      "Approve Once",
      "Approve This Session",
      "Reject",
    ];
    const result = detectPrompt(lines, config, "");
    expect(result.isPrompt).toBe(true);
    expect(result.matchedText).toMatch(/approve\s+once/i);
  });

  it("detects 'allow once' on cursor line", () => {
    const config = approvalConfig();
    const result = detectPrompt(["other"], config, "Yes, allow once");
    expect(result.isPrompt).toBe(true);
    expect(result.confidence).toBe(0.85);
  });

  it("detects 'Proceed? [y/N]'", () => {
    const config = approvalConfig();
    const result = detectPrompt(["Proceed? [y/N]"], config, null);
    expect(result.isPrompt).toBe(true);
  });

  it("detects OpenCode 'Allow permission'", () => {
    const config = approvalConfig();
    const lines = [
      "OpenCode wants to run: git status",
      "a, Allow permission",
      "d, Deny permission",
    ];
    const result = detectPrompt(lines, config, "");
    expect(result.isPrompt).toBe(true);
  });

  it("detects [Y/n] bracket pattern", () => {
    const config = approvalConfig();
    const result = detectPrompt(["Install packages? [Y/n]"], config, null);
    expect(result.isPrompt).toBe(true);
  });

  it("detects (y/n) paren pattern", () => {
    const config = approvalConfig();
    const result = detectPrompt(["Continue? (y/n):"], config, null);
    expect(result.isPrompt).toBe(true);
  });

  it("handles ANSI-wrapped approval text", () => {
    const config = approvalConfig();
    const result = detectPrompt(["\x1b[32mApprove\x1b[0m Once"], config, null);
    expect(result.isPrompt).toBe(true);
  });

  it("is case-insensitive", () => {
    const config = approvalConfig();
    for (const text of ["ALLOW ONCE", "allow once", "Allow Once"]) {
      const result = detectPrompt([text], config, null);
      expect(result.isPrompt, `Expected "${text}" to be detected`).toBe(true);
    }
  });

  it("does not match text outside scan window", () => {
    const config = approvalConfig({ promptScanLineCount: 2 });
    const lines = ["Approve Once", "line2", "line3", "line4"];
    const result = detectPrompt(lines, config, "line4");
    expect(result.isPrompt).toBe(false);
  });
});

describe("detectPromptLexeme", () => {
  it("detects trailing question mark", () => {
    const result = detectPromptLexeme("Which file should I modify?");
    expect(result.isPrompt).toBe(true);
    expect(result.confidence).toBe(0.7);
    expect(result.matchedText).toBe("?");
  });

  it("detects question mark with trailing space", () => {
    expect(detectPromptLexeme("Are you sure? ").isPrompt).toBe(true);
  });

  it("detects bracket confirmation [y/N]", () => {
    const result = detectPromptLexeme("Proceed? [y/N]");
    expect(result.isPrompt).toBe(true);
    expect(result.matchedText).toMatch(/\[y\/N\]/);
  });

  it("detects parenthesized confirmation (yes/no)", () => {
    expect(detectPromptLexeme("Continue (yes/no)").isPrompt).toBe(true);
  });

  it("detects [Yes/No] mixed case", () => {
    expect(detectPromptLexeme("Overwrite? [Yes/No]").isPrompt).toBe(true);
  });

  it("detects keyword+colon: Enter password:", () => {
    const result = detectPromptLexeme("Enter password:");
    expect(result.isPrompt).toBe(true);
    expect(result.matchedText).toMatch(/password:/i);
  });

  it("detects keyword+colon: Select host:", () => {
    expect(detectPromptLexeme("Select host:").isPrompt).toBe(true);
  });

  it("detects 'Press enter to continue'", () => {
    expect(detectPromptLexeme("Press enter to continue...").isPrompt).toBe(true);
  });

  it("detects 'Press any key to exit'", () => {
    expect(detectPromptLexeme("Press any key to exit").isPrompt).toBe(true);
  });

  it("does NOT match bare colon at end", () => {
    expect(detectPromptLexeme("value:").isPrompt).toBe(false);
  });

  it("does NOT match error output with colon", () => {
    expect(detectPromptLexeme("Error: file not found").isPrompt).toBe(false);
  });

  it("does NOT match build output", () => {
    expect(detectPromptLexeme("Building project...").isPrompt).toBe(false);
  });

  it("does NOT match empty string", () => {
    expect(detectPromptLexeme("").isPrompt).toBe(false);
  });

  it("does NOT match whitespace-only", () => {
    expect(detectPromptLexeme("   ").isPrompt).toBe(false);
  });

  it("does NOT match text without lexemes", () => {
    expect(detectPromptLexeme("Compiling 42 modules").isPrompt).toBe(false);
  });

  it("handles ANSI-colored input", () => {
    expect(detectPromptLexeme("\x1b[32mContinue?\x1b[0m").isPrompt).toBe(true);
  });
});
