import { describe, expect, it } from "vitest";
import { getPluginManifestSchema, MANIFEST_CONTRIBUTION_CAPS } from "../plugin.js";

const schema = getPluginManifestSchema("user");

function manifestWithThemes(themes: unknown) {
  return schema.safeParse({
    name: "acme.themes",
    version: "1.0.0",
    contributes: { themes },
  });
}

function errorCodes(result: ReturnType<typeof schema.safeParse>): string[] {
  if (result.success) return [];
  return result.error.issues
    .map((i) => (i as { params?: { errorCode?: string } }).params?.errorCode)
    .filter((c): c is string => typeof c === "string");
}

const MIDNIGHT = { id: "midnight", name: "Midnight", type: "dark", path: "./themes/midnight.json" };

describe("contributes.themes schema (#13832)", () => {
  it("accepts a theme and defaults the group to empty when absent", () => {
    const result = manifestWithThemes([MIDNIGHT]);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.contributes.themes).toEqual([MIDNIGHT]);

    const bare = schema.safeParse({ name: "acme.themes", version: "1.0.0" });
    expect(bare.success && bare.data.contributes.themes).toEqual([]);
  });

  it("rejects a duplicate theme id", () => {
    const result = manifestWithThemes([MIDNIGHT, { ...MIDNIGHT, name: "Again" }]);
    expect(errorCodes(result)).toContain("duplicate_contribution_id");
  });

  it("rejects an id that could break the namespaced theme id", () => {
    expect(manifestWithThemes([{ ...MIDNIGHT, id: "mid:night" }]).success).toBe(false);
  });

  it("requires a polarity and nothing beyond the declared fields", () => {
    const { type: _type, ...untyped } = MIDNIGHT;
    expect(manifestWithThemes([untyped]).success).toBe(false);
    expect(manifestWithThemes([{ ...MIDNIGHT, type: "dim" }]).success).toBe(false);
    expect(manifestWithThemes([{ ...MIDNIGHT, heroImage: "hero.png" }]).success).toBe(false);
  });

  it.each([
    ["absolute path", "/etc/theme.json"],
    ["parent traversal", "../theme.json"],
    ["url scheme", "https://example.com/theme.json"],
    ["backslash", "themes\\midnight.json"],
  ])("rejects a path with %s", (_label, path) => {
    expect(manifestWithThemes([{ ...MIDNIGHT, path }]).success).toBe(false);
  });

  it("caps the number of themes", () => {
    const themes = Array.from({ length: MANIFEST_CONTRIBUTION_CAPS.themes + 1 }, (_, i) => ({
      ...MIDNIGHT,
      id: `theme-${i}`,
    }));
    expect(manifestWithThemes(themes).success).toBe(false);
    expect(manifestWithThemes(themes.slice(1)).success).toBe(true);
  });

  it("is refused for a project plugin", () => {
    const result = getPluginManifestSchema("project").safeParse({
      name: "acme.themes",
      version: "1.0.0",
      scope: "project",
      contributes: { themes: [MIDNIGHT] },
    });
    expect(result.success).toBe(false);
  });
});
