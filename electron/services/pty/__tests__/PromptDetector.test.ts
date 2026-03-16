import { describe, it, expect } from "vitest";
import {
  detectPrompt,
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
