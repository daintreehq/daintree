import { describe, expect, it } from "vitest";
import { BUILT_IN_APP_SCHEMES } from "@/config/appColorSchemes";
import { THEME_MODE_ORDER, parseThemeQuery, searchThemes } from "../themeSearch";

const ids = (query: string) => searchThemes(BUILT_IN_APP_SCHEMES, query).items.map((s) => s.id);

function isBanded(query: string): boolean {
  const modes = searchThemes(BUILT_IN_APP_SCHEMES, query).items.map((s) => s.type);
  const order = modes.map((m) => THEME_MODE_ORDER.indexOf(m));
  return order.every((o, i) => i === 0 || o >= order[i - 1]!);
}

describe("searchThemes", () => {
  it("finds a theme by the place on its row", () => {
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const country = scheme.location?.split(",").pop()?.trim();
      if (!country) continue;
      expect(ids(country)).toContain(scheme.id);
    }
  });

  it("marks where a place search matched", () => {
    const { items, matches } = searchThemes(BUILT_IN_APP_SCHEMES, "japan");
    expect(items.length).toBeGreaterThan(0);
    for (const s of items) {
      expect(matches.get(s.id)?.some((m) => m.key === "location")).toBe(true);
    }
  });

  it.each(["light", "dark"] as const)("treats %s as a mode filter, never as text", (mode) => {
    const found = searchThemes(BUILT_IN_APP_SCHEMES, mode).items;
    const expected = BUILT_IN_APP_SCHEMES.filter((s) => s.type === mode);
    expect(found.map((s) => s.id).sort()).toEqual(expected.map((s) => s.id).sort());
  });

  it("combines a mode with a text query", () => {
    for (const s of searchThemes(BUILT_IN_APP_SCHEMES, "light japan").items) {
      expect(s.type).toBe("light");
      expect(s.location).toMatch(/japan/i);
    }
    expect(ids("light japan").length).toBeGreaterThan(0);
  });

  it.each(["", "a", "ba", "japan", "light"])("keeps every band contiguous for %j", (query) => {
    expect(isBanded(query)).toBe(true);
  });

  it("keeps every theme when browsing", () => {
    expect(ids("").sort()).toEqual(BUILT_IN_APP_SCHEMES.map((s) => s.id).sort());
  });
});

describe("parseThemeQuery", () => {
  it("only takes whole words as a mode", () => {
    expect(parseThemeQuery("highlights")).toEqual({ mode: null, text: "highlights" });
    expect(parseThemeQuery("Dark  fjord")).toEqual({ mode: "dark", text: "fjord" });
  });
});
