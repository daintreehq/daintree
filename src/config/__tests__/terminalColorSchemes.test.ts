import { describe, it, expect } from "vitest";
import {
  BUILT_IN_SCHEMES,
  ANSI_COLOR_KEYS,
  DEFAULT_SCHEME_ID,
  getSchemeById,
} from "../terminalColorSchemes";

describe("terminalColorSchemes", () => {
  it("has exactly 8 built-in schemes", () => {
    expect(BUILT_IN_SCHEMES).toHaveLength(8);
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
    expect(getSchemeById(DEFAULT_SCHEME_ID)!.name).toBe("Canopy (Default)");
  });

  it("solarized-light is the only light scheme", () => {
    const lightSchemes = BUILT_IN_SCHEMES.filter((s) => s.type === "light");
    expect(lightSchemes).toHaveLength(1);
    expect(lightSchemes[0].id).toBe("solarized-light");
  });

  it("getSchemeById returns undefined for unknown ID", () => {
    expect(getSchemeById("nonexistent")).toBeUndefined();
  });
});
