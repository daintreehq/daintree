import { describe, expect, it, vi } from "vitest";
import { BUILT_IN_APP_SCHEMES } from "../themes.js";

// What every process derives from the palettes when it imports the theme module.
// PERF-306 grades a cold evaluation of the module against this same file, so a
// deliberate palette or engine change regenerates it with:
//   npm test -- shared/theme/__tests__/builtInSchemeOutput.test.ts -u
// and the regenerated diff is reviewed with that change. A speed-up never does.
const BUILT_IN_SCHEME_OUTPUT_SNAPSHOT = "./__snapshots__/builtInSchemeOutput.json";

// The internal light fallback is private to themes.ts. It is what a light
// scheme resolves to when no light built-in ships, so it is read that way.
async function loadLightFallback() {
  vi.resetModules();
  vi.doMock("../builtInThemeSources.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../builtInThemeSources.js")>();
    return {
      ...actual,
      BUILT_IN_THEME_SOURCES: actual.BUILT_IN_THEME_SOURCES.filter(
        (source) => source.type === "dark"
      ),
    };
  });
  try {
    const themes = await import("../themes.js");
    return themes.getBuiltInAppSchemeForType("light");
  } finally {
    vi.doUnmock("../builtInThemeSources.js");
    vi.resetModules();
  }
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
});
