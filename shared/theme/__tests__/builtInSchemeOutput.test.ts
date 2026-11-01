import { describe, expect, it, vi } from "vitest";
import { BUILT_IN_APP_SCHEMES } from "../themes.js";
import type { BuiltInThemeSource } from "../builtInThemeSources.js";

// What every process derives from the palettes when it imports the theme module.
// PERF-306 grades a cold evaluation of the module against this same file, which
// lives with the perf harness so it is part of the apparatus the harness hashes.
// A deliberate palette or engine change regenerates it with:
//   npm test -- shared/theme/__tests__/builtInSchemeOutput.test.ts -u
// and the regenerated diff is reviewed with that change. A speed-up never does.
const BUILT_IN_SCHEME_OUTPUT_SNAPSHOT = "../../../scripts/perf/fixtures/builtInSchemeOutput.json";

// Built-in sources go through a module-private resolver at import, so a test
// that needs other sources re-imports the module over a stand-in source list.
async function loadThemesWith(
  pick: (sources: BuiltInThemeSource[]) => BuiltInThemeSource[]
): Promise<typeof import("../themes.js")> {
  vi.resetModules();
  vi.doMock("../builtInThemeSources.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../builtInThemeSources.js")>();
    return { ...actual, BUILT_IN_THEME_SOURCES: pick(actual.BUILT_IN_THEME_SOURCES) };
  });
  try {
    return await import("../themes.js");
  } finally {
    vi.doUnmock("../builtInThemeSources.js");
    vi.resetModules();
  }
}

// The internal light fallback is private to themes.ts. It is what a light
// scheme resolves to when no light built-in ships, so it is read that way.
async function loadLightFallback() {
  const themes = await loadThemesWith((sources) =>
    sources.filter((source) => source.type === "dark")
  );
  return themes.getBuiltInAppSchemeForType("light");
}

describe("built-in scheme output", () => {
  it("reads the light fallback rather than a shipped light theme", async () => {
    const fallback = await loadLightFallback();
    expect(fallback.type).toBe("light");
    expect(BUILT_IN_APP_SCHEMES.some((scheme) => scheme.id === fallback.id)).toBe(false);
  });

  it("matches the recorded engine output for every built-in and the light fallback", async () => {
    const fallback = await loadLightFallback();
    const output = `${JSON.stringify({ schemes: BUILT_IN_APP_SCHEMES, fallback }, null, 2)}\n`;
    await expect(output).toMatchFileSnapshot(BUILT_IN_SCHEME_OUTPUT_SNAPSHOT);
  });

  it("keeps the compile's lift under a blank override, however the theme spells it", async () => {
    // Normalisation drops a blank override and the follow-ups defer to it, so
    // the ink the compile lifted is the one that ships. An inherited or hidden
    // blank must be honoured exactly like an own one (#15673).
    const blank = "diff-text-insert";
    const themes = await loadThemesWith((sources) => {
      const base = sources.find((source) => source.id === "daintree")!;
      const inherited = Object.assign(Object.create({ [blank]: "" }), base.tokens);
      const hidden = { ...base.tokens };
      Object.defineProperty(hidden, blank, { value: "", enumerable: false });
      return [
        { ...base, id: "own", tokens: { ...base.tokens, [blank]: "" } },
        { ...base, id: "inherited", tokens: inherited },
        { ...base, id: "hidden", tokens: hidden },
      ];
    });
    const [own, inherited, hidden] = themes.BUILT_IN_APP_SCHEMES.map((scheme) => scheme.tokens);
    expect(own![blank]).not.toBe(own!["status-success"]);
    expect(inherited![blank]).toBe(own![blank]);
    expect(hidden![blank]).toBe(own![blank]);
  });
});
