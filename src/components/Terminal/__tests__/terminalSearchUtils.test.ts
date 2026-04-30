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
});

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

  it("converts rgba search-highlight-background to solid hex for matchBackground", () => {
    document.documentElement.style.setProperty(
      "--theme-search-highlight-background",
      "rgba(54, 206, 148, 0.20)"
    );
    document.documentElement.style.setProperty("--theme-search-highlight-text", "#5F8B6D");
    const colors = getSearchDecorationColors();
    expect(colors.matchBackground).toBe("#36ce94");
    expect(colors.matchOverviewRuler).toBe("#36ce94");
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
