// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import {
  validateRegexTerm,
  buildSearchOptions,
  getSearchDecorationColors,
} from "../terminalSearchUtils";

afterEach(() => {
  document.documentElement.style.removeProperty("--theme-search-highlight-background");
  document.documentElement.style.removeProperty("--theme-search-highlight-text");
  document.documentElement.style.removeProperty("--theme-terminal-background");
  document.documentElement.style.removeProperty("--theme-surface-canvas");
});

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

describe("validateRegexTerm", () => {
  it("validates a simple valid regex", () => {
    const result = validateRegexTerm("test", true);
    expect(result.isValid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("validates a complex valid regex", () => {
    const result = validateRegexTerm("\\d{4}-\\d{2}-\\d{2}", true);
    expect(result.isValid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("validates character classes", () => {
    const result = validateRegexTerm("[A-Z][a-z]+", false);
    expect(result.isValid).toBe(true);
  });

  it("rejects invalid regex with unclosed bracket", () => {
    const result = validateRegexTerm("[a-", true);
    expect(result.isValid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("rejects invalid regex with unclosed paren", () => {
    const result = validateRegexTerm("(test", false);
    expect(result.isValid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("rejects unterminated escape", () => {
    const result = validateRegexTerm("test\\", true);
    expect(result.isValid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("validates lookahead", () => {
    const result = validateRegexTerm("(?=.*pattern)", true);
    expect(result.isValid).toBe(true);
  });

  it("validates case-insensitive regex compilation", () => {
    const result = validateRegexTerm("[A-Z]", false);
    expect(result.isValid).toBe(true);
  });

  it("handles empty string as valid regex", () => {
    const result = validateRegexTerm("", true);
    expect(result.isValid).toBe(true);
  });

  it("does not lowercase the pattern in case-insensitive mode (preserves named groups)", () => {
    // Lowercasing this pattern would collapse (?<A>...) and (?<a>...) into
    // duplicate group names, which is a regex syntax error.
    const result = validateRegexTerm("(?<A>x)(?<a>y)", false);
    expect(result.isValid).toBe(true);
  });
});

describe("buildSearchOptions", () => {
  it("builds options with case sensitive only", () => {
    const options = buildSearchOptions(true, false);
    expect(options.caseSensitive).toBe(true);
    expect(options.regex).toBeUndefined();
  });

  it("builds options with case insensitive only", () => {
    const options = buildSearchOptions(false, false);
    expect(options.caseSensitive).toBe(false);
    expect(options.regex).toBeUndefined();
  });

  it("builds options with regex enabled and case sensitive", () => {
    const options = buildSearchOptions(true, true);
    expect(options.caseSensitive).toBe(true);
    expect(options.regex).toBe(true);
  });

  it("builds options with regex enabled and case insensitive", () => {
    const options = buildSearchOptions(false, true);
    expect(options.caseSensitive).toBe(false);
    expect(options.regex).toBe(true);
  });

  it("does not include regex property when disabled", () => {
    const options = buildSearchOptions(true, false);
    expect(options.regex).toBeUndefined();
  });

  it("always includes decorations so onDidChangeResults fires", () => {
    const options = buildSearchOptions(false, false);
    expect(options.decorations).toBeDefined();
    expect(options.decorations?.matchOverviewRuler).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(options.decorations?.activeMatchColorOverviewRuler).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("includes wholeWord when enabled", () => {
    const options = buildSearchOptions(false, false, true);
    expect(options.wholeWord).toBe(true);
  });

  it("omits wholeWord when disabled or not provided", () => {
    expect(buildSearchOptions(false, false).wholeWord).toBeUndefined();
    expect(buildSearchOptions(false, false, false).wholeWord).toBeUndefined();
  });

  it("supports regex and wholeWord together", () => {
    const options = buildSearchOptions(true, true, true);
    expect(options.caseSensitive).toBe(true);
    expect(options.regex).toBe(true);
    expect(options.wholeWord).toBe(true);
  });
});

describe("getSearchDecorationColors", () => {
  it("returns #RRGGBB hex strings for all four color fields", () => {
    document.documentElement.style.setProperty(
      "--theme-search-highlight-background",
      "rgba(54, 206, 148, 0.20)"
    );
    document.documentElement.style.setProperty("--theme-search-highlight-text", "#5F8B6D");
    const colors = getSearchDecorationColors();
    expect(colors.matchBackground).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(colors.matchOverviewRuler).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(colors.activeMatchBackground).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(colors.activeMatchColorOverviewRuler).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("flattens a translucent match wash over the terminal background instead of dropping its alpha", () => {
    document.documentElement.style.setProperty(
      "--theme-search-highlight-background",
      "rgba(54, 206, 148, 0.20)"
    );
    document.documentElement.style.setProperty("--theme-terminal-background", "#1a1b18");
    document.documentElement.style.setProperty("--theme-search-highlight-text", "#36ce94");
    const colors = getSearchDecorationColors();
    // Every match must stay distinguishable from the one active match.
    expect(colors.matchBackground).not.toBe(colors.activeMatchBackground);
    expect(colors.matchOverviewRuler).toBe(colors.matchBackground);
    const wash = [54, 206, 148];
    const backdrop = channels("#1a1b18");
    channels(colors.matchBackground).forEach((c, i) => {
      const lo = Math.min(wash[i]!, backdrop[i]!);
      const hi = Math.max(wash[i]!, backdrop[i]!);
      expect(c).toBeGreaterThanOrEqual(lo);
      expect(c).toBeLessThanOrEqual(hi);
      // A 20% wash sits nearer the backdrop than the full-strength colour.
      expect(Math.abs(c - backdrop[i]!)).toBeLessThanOrEqual(Math.abs(c - wash[i]!));
    });
  });

  it("flattens over the canvas when the terminal background is not set", () => {
    document.documentElement.style.setProperty(
      "--theme-search-highlight-background",
      "rgba(255, 255, 255, 0.5)"
    );
    document.documentElement.style.setProperty("--theme-surface-canvas", "#000000");
    expect(getSearchDecorationColors().matchBackground).toBe("#808080");
  });

  it("passes an opaque match colour through unchanged", () => {
    document.documentElement.style.setProperty(
      "--theme-search-highlight-background",
      "rgb(10, 20, 30)"
    );
    document.documentElement.style.setProperty("--theme-terminal-background", "#ffffff");
    expect(getSearchDecorationColors().matchBackground).toBe("#0a141e");
  });

  it("reads search-highlight-text directly as active match color", () => {
    document.documentElement.style.setProperty(
      "--theme-search-highlight-background",
      "rgba(54, 206, 148, 0.20)"
    );
    document.documentElement.style.setProperty("--theme-search-highlight-text", "#123abc");
    const colors = getSearchDecorationColors();
    expect(colors.activeMatchBackground).toBe("#123abc");
    expect(colors.activeMatchColorOverviewRuler).toBe("#123abc");
  });

  it("falls back when CSS custom properties are empty", () => {
    const colors = getSearchDecorationColors();
    expect(colors.matchOverviewRuler).toBe("#71717a");
    expect(colors.activeMatchColorOverviewRuler).toBe("#22c55e");
  });

  it("falls back for matchBackground when rgba is malformed", () => {
    document.documentElement.style.setProperty(
      "--theme-search-highlight-background",
      "not-a-color"
    );
    document.documentElement.style.setProperty("--theme-search-highlight-text", "#abc123");
    const colors = getSearchDecorationColors();
    expect(colors.matchBackground).toBe("#71717a");
  });

  it("falls back for activeMatchBackground when hex is malformed", () => {
    document.documentElement.style.setProperty(
      "--theme-search-highlight-background",
      "rgba(54, 206, 148, 0.20)"
    );
    document.documentElement.style.setProperty("--theme-search-highlight-text", "not-a-color");
    const colors = getSearchDecorationColors();
    expect(colors.activeMatchBackground).toBe("#22c55e");
  });

  it("missing one token does not poison the other", () => {
    document.documentElement.style.setProperty(
      "--theme-search-highlight-background",
      "rgba(10, 20, 30, 0.5)"
    );
    // no search-highlight-text set
    const colors = getSearchDecorationColors();
    expect(colors.matchBackground).toBe("#0a141e");
    expect(colors.activeMatchBackground).toBe("#22c55e");
  });

  it("clamps out-of-range rgb channels in rgba", () => {
    document.documentElement.style.setProperty(
      "--theme-search-highlight-background",
      "rgba(300, -10, 128, 0.5)"
    );
    document.documentElement.style.setProperty("--theme-search-highlight-text", "#000000");
    const colors = getSearchDecorationColors();
    expect(colors.matchBackground).toBe("#ff0080");
  });
});
