import { describe, it, expect } from "vitest";
import {
  validateRegexTerm,
  buildSearchOptions,
  getSearchDecorationColors,
} from "../terminalSearchUtils";

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
    const colors = getSearchDecorationColors();
    expect(colors.matchBackground).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(colors.matchOverviewRuler).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(colors.activeMatchBackground).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(colors.activeMatchColorOverviewRuler).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("falls back to defaults when CSS custom properties are empty", () => {
    const colors = getSearchDecorationColors();
    // In a non-jsdom environment `document` is undefined; in jsdom the
    // CSS vars resolve empty — either way the fallback palette kicks in.
    expect(colors.matchOverviewRuler).toBe("#6366f1");
    expect(colors.activeMatchColorOverviewRuler).toBe("#0ea5e9");
  });
});
