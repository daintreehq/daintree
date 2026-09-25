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
    expect(getSchemeById(DEFAULT_SCHEME_ID)!.name).toBe("Match app theme");
  });

  it("getSchemeById returns undefined for unknown ID", () => {
    expect(getSchemeById("nonexistent")).toBeUndefined();
  });

  it("APP_THEME_TERMINAL_SCHEME_MAP covers daintree and bondi", () => {
    expect(Object.keys(APP_THEME_TERMINAL_SCHEME_MAP).sort()).toEqual(["bondi", "daintree"]);
  });

  it("every mapped terminal scheme resolves to an existing scheme", () => {
    for (const [appTheme, terminalSchemeId] of Object.entries(APP_THEME_TERMINAL_SCHEME_MAP)) {
      const scheme = getSchemeById(terminalSchemeId);
      expect(scheme, `${appTheme} → ${terminalSchemeId} not found`).toBeDefined();
    }
  });

  it("getMappedTerminalScheme returns scheme for daintree", () => {
    const scheme = getMappedTerminalScheme("daintree");
    expect(scheme).toBeDefined();
    expect(scheme!.id).toBe("daintree");
  });

  it("getMappedTerminalScheme returns undefined for unknown app theme", () => {
    expect(getMappedTerminalScheme("nonexistent")).toBeUndefined();
  });
});
