import { describe, it, expect } from "vitest";
import {
  BUILT_IN_SCHEMES,
  ANSI_COLOR_KEYS,
  DEFAULT_SCHEME_ID,
  getSchemeById,
  APP_THEME_TERMINAL_SCHEME_MAP,
  getMappedTerminalScheme,
} from "../terminalColorSchemes";

describe("terminalColorSchemes", () => {
  it("has exactly 23 built-in schemes", () => {
    expect(BUILT_IN_SCHEMES).toHaveLength(23);
  });

  it("all schemes have unique IDs", () => {
    const ids = BUILT_IN_SCHEMES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(BUILT_IN_SCHEMES.map((s) => [s.id, s]))(
    "scheme %s has all required color fields",
    (_id, scheme) => {
      for (const key of ANSI_COLOR_KEYS) {
        expect(scheme.colors[key], `missing ${key}`).toBeDefined();
        expect(typeof scheme.colors[key]).toBe("string");
        expect(scheme.colors[key]).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    }
  );

  it("default scheme ID exists", () => {
    expect(getSchemeById(DEFAULT_SCHEME_ID)).toBeDefined();
    expect(getSchemeById(DEFAULT_SCHEME_ID)!.name).toBe("Match App Theme");
  });

  it("has 6 light schemes", () => {
    const lightSchemes = BUILT_IN_SCHEMES.filter((s) => s.type === "light");
    expect(lightSchemes).toHaveLength(6);
  });

  it("getSchemeById returns undefined for unknown ID", () => {
    expect(getSchemeById("nonexistent")).toBeUndefined();
  });

  it("canopy scheme uses eucalyptus accent cursor and selection", () => {
    const scheme = getSchemeById("canopy")!;
    expect(scheme.colors.cursor).toBe("#3F9366");
    expect(scheme.colors.selectionBackground).toBe("#1a2c22");
    expect(scheme.colors.green).toBe("#10b981");
    expect(scheme.colors.brightGreen).toBe("#34d399");
  });

  it("APP_THEME_TERMINAL_SCHEME_MAP covers all 12 app themes", () => {
    const expectedThemes = [
      "daintree",
      "fiordland",
      "highlands",
      "arashiyama",
      "galapagos",
      "namib",
      "redwoods",
      "bondi",
      "svalbard",
      "atacama",
      "serengeti",
      "hokkaido",
    ];
    expect(Object.keys(APP_THEME_TERMINAL_SCHEME_MAP).sort()).toEqual(expectedThemes.sort());
  });

  it("every mapped terminal scheme resolves to an existing scheme", () => {
    for (const [appTheme, terminalSchemeId] of Object.entries(APP_THEME_TERMINAL_SCHEME_MAP)) {
      const scheme = getSchemeById(terminalSchemeId);
      expect(scheme, `${appTheme} → ${terminalSchemeId} not found`).toBeDefined();
    }
  });

  it("Match App Theme reuses a small set of shared terminal schemes", () => {
    expect(new Set(Object.values(APP_THEME_TERMINAL_SCHEME_MAP))).toEqual(
      new Set([
        "atom-one-light",
        "canopy-ember",
        "daintree",
        "dracula",
        "github-dark",
        "highlands",
        "redwoods",
        "solarized-light",
      ])
    );
  });

  it("getMappedTerminalScheme returns scheme for known app theme", () => {
    const scheme = getMappedTerminalScheme("fiordland");
    expect(scheme).toBeDefined();
    expect(scheme!.id).toBe("dracula");
  });

  it("redwoods maps to its bespoke terminal scheme", () => {
    const scheme = getMappedTerminalScheme("redwoods");
    expect(scheme).toBeDefined();
    expect(scheme!.id).toBe("redwoods");
  });

  it("highlands maps to its own generated terminal scheme", () => {
    const scheme = getMappedTerminalScheme("highlands");
    expect(scheme).toBeDefined();
    expect(scheme!.id).toBe("highlands");
    expect(scheme!.type).toBe("dark");
    expect(scheme!.colors.background).toBe("#1A1614");
  });

  it("getMappedTerminalScheme returns undefined for unknown app theme", () => {
    expect(getMappedTerminalScheme("nonexistent")).toBeUndefined();
  });
});
