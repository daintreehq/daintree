import { describe, expect, it } from "vitest";
import {
  compilePluginTheme,
  getPluginThemeGateFailures,
  isPluginThemeId,
  makePluginThemeId,
  parsePluginThemeFile,
  parsePluginThemeId,
  readPluginThemeSnapshot,
  toPluginThemeSnapshot,
  withSelectedPluginTheme,
} from "../pluginThemes.js";
import { BUILT_IN_THEME_SOURCES } from "../builtInThemes/index.js";
import { BUILT_IN_APP_SCHEMES, resolveAppTheme } from "../themes.js";
import type { PluginThemeSource } from "../types.js";

const DAINTREE = BUILT_IN_THEME_SOURCES.find((source) => source.id === "daintree")!;
const BONDI = BUILT_IN_THEME_SOURCES.find((source) => source.id === "bondi")!;

function fileOf(source: (typeof BUILT_IN_THEME_SOURCES)[number]) {
  return {
    palette: structuredClone(source.palette),
    ...(source.tokens ? { tokens: structuredClone(source.tokens) } : {}),
    ...(source.extensions ? { extensions: structuredClone(source.extensions) } : {}),
  };
}

function sourceOf(
  file: ReturnType<typeof fileOf>,
  overrides: Partial<PluginThemeSource> = {}
): PluginThemeSource {
  return {
    id: makePluginThemeId("acme.themes", "midnight"),
    name: "Midnight",
    type: file.palette.type,
    pluginId: "acme.themes",
    pluginName: "Acme Themes",
    ...(file as Pick<PluginThemeSource, "palette" | "tokens" | "extensions">),
    ...overrides,
  };
}

describe("plugin theme ids", () => {
  it("round-trips through the reserved namespace", () => {
    const id = makePluginThemeId("acme.themes", "midnight");
    expect(id).toBe("plugin:acme.themes:midnight");
    expect(parsePluginThemeId(id)).toEqual({ pluginId: "acme.themes", themeId: "midnight" });
    expect(isPluginThemeId(id)).toBe(true);
  });

  it("never matches a built-in or a generated imported id", () => {
    for (const scheme of BUILT_IN_APP_SCHEMES) expect(isPluginThemeId(scheme.id)).toBe(false);
    expect(isPluginThemeId("custom-midnight")).toBe(false);
    expect(parsePluginThemeId("acme.themes.midnight")).toBeNull();
  });

  it("rejects malformed ids inside the namespace", () => {
    expect(parsePluginThemeId("plugin:acme.themes")).toBeNull();
    expect(parsePluginThemeId("plugin:acme.themes:a:b")).toBeNull();
    expect(parsePluginThemeId("plugin::midnight")).toBeNull();
    expect(isPluginThemeId("plugin:acme.themes")).toBe(true);
  });
});

describe("parsePluginThemeFile", () => {
  it("accepts a built-in theme's palette and overrides", () => {
    const result = parsePluginThemeFile(fileOf(DAINTREE), "dark");
    expect(result.ok).toBe(true);
  });

  it("requires the palette's polarity to match the declaration", () => {
    const result = parsePluginThemeFile(fileOf(DAINTREE), "light");
    expect(result).toEqual({
      ok: false,
      errors: ['palette.type is "dark" but the manifest declares "light"'],
    });
  });

  it("refuses a palette missing a required field", () => {
    const file = fileOf(DAINTREE);
    delete (file.palette.surfaces as Partial<typeof file.palette.surfaces>).canvas;
    const result = parsePluginThemeFile(file, "dark");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain("palette.surfaces.canvas");
  });

  it("refuses unknown keys at every level", () => {
    const topLevel = parsePluginThemeFile({ ...fileOf(DAINTREE), heroImage: "x.png" }, "dark");
    expect(topLevel.ok).toBe(false);
    const inPalette = parsePluginThemeFile(
      { ...fileOf(DAINTREE), palette: { ...DAINTREE.palette, glow: "#fff" } },
      "dark"
    );
    expect(inPalette.ok).toBe(false);
  });

  it("refuses tokens and extensions outside the registered sets", () => {
    const result = parsePluginThemeFile(
      {
        ...fileOf(DAINTREE),
        tokens: { "surface-canvas": "#101010", "not-a-token": "#fff" },
        extensions: { "theme-text-primary": "#fff" },
      },
      "dark"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("Unknown tokens: not-a-token");
      expect(result.errors).toContain("Unknown extensions: theme-text-primary");
    }
  });

  it("sees a `__proto__` key that a record parser would drop", () => {
    const raw = JSON.parse(
      `{"palette":${JSON.stringify(DAINTREE.palette)},"tokens":{"__proto__":"#fff"}}`
    ) as unknown;
    const result = parsePluginThemeFile(raw, "dark");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain("__proto__");
  });

  it("refuses values that could end their declaration", () => {
    const palette = { ...DAINTREE.palette, accent: "#fff; --theme-text-primary: red" };
    expect(parsePluginThemeFile({ palette }, "dark").ok).toBe(false);
    const tokens = parsePluginThemeFile(
      { ...fileOf(DAINTREE), tokens: { "shadow-dialog": "0 0 0 red } body { color: red" } },
      "dark"
    );
    expect(tokens.ok).toBe(false);
  });

  it("refuses a value that would fetch anything but an embedded image", () => {
    const beacon = 'url("https://example.com/beacon.png")';
    for (const overrides of [
      { tokens: { "chrome-noise-texture": beacon } },
      { tokens: { "chrome-noise-texture": "url(https://example.com/a.png)" } },
      { extensions: { "grain-image": beacon } },
      { extensions: { "grain-image": 'image-set("https://example.com/a.png" 1x)' } },
      { extensions: { "grain-image": "linear-gradient(red, blue), url(//example.com/a.png)" } },
    ]) {
      const result = parsePluginThemeFile({ palette: DAINTREE.palette, ...overrides }, "dark");
      expect(result.ok, JSON.stringify(overrides)).toBe(false);
    }

    const embedded = parsePluginThemeFile(
      {
        palette: DAINTREE.palette,
        tokens: {
          "chrome-noise-texture":
            "url(\"data:image/svg+xml,%3Csvg filter='url(%23grain)'/%3E\"), radial-gradient(red, transparent)",
        },
      },
      "dark"
    );
    expect(embedded.ok).toBe(true);
  });

  it("refuses a strategy value of the wrong type", () => {
    const palette = {
      ...DAINTREE.palette,
      strategy: { ...DAINTREE.palette.strategy, materialBlur: "8px; color: red" },
    };
    expect(parsePluginThemeFile({ palette }, "dark").ok).toBe(false);
  });
});

describe("the contrast gate", () => {
  it.each(BUILT_IN_THEME_SOURCES.map((source) => [source.id, source] as const))(
    "offers built-in %s shipped as a plugin theme",
    (_id, builtIn) => {
      const file = parsePluginThemeFile(fileOf(builtIn), builtIn.type);
      expect(file.ok, file.ok ? "" : file.errors.join("\n")).toBe(true);
      if (!file.ok) return;
      const scheme = compilePluginTheme(sourceOf(file.file as ReturnType<typeof fileOf>));
      expect(getPluginThemeGateFailures(scheme)).toEqual([]);
    }
  );

  it("refuses a theme whose text is unreadable", () => {
    const file = fileOf(DAINTREE);
    file.palette.text = { ...file.palette.text, primary: "#1a1a1a", secondary: "#1b1b1b" };
    const scheme = compilePluginTheme(sourceOf(file));
    expect(getPluginThemeGateFailures(scheme).length).toBeGreaterThan(0);
  });

  it("refuses a theme whose contrast can't be evaluated", () => {
    const file = { ...fileOf(DAINTREE), tokens: { "text-primary": "rebeccapurple" } };
    const scheme = compilePluginTheme(sourceOf(file));
    expect(getPluginThemeGateFailures(scheme).join("\n")).toContain("Cannot evaluate");
  });

  it("attributes the compiled scheme to its plugin", () => {
    const scheme = compilePluginTheme(sourceOf(fileOf(BONDI)));
    expect(scheme).toMatchObject({
      id: "plugin:acme.themes:midnight",
      name: "Midnight",
      type: "light",
      builtin: false,
      plugin: { id: "acme.themes", name: "Acme Themes" },
    });
  });
});

describe("readPluginThemeSnapshot", () => {
  const source = sourceOf(fileOf(DAINTREE));
  const snapshot = toPluginThemeSnapshot(source);

  it("resolves the selected plugin theme with no plugin loaded", () => {
    const scheme = readPluginThemeSnapshot({
      colorSchemeId: source.id,
      pluginThemeSnapshot: snapshot,
    });
    expect(scheme).toEqual(compilePluginTheme(source));
  });

  it("ignores a snapshot of anything but the selection", () => {
    expect(
      readPluginThemeSnapshot({ colorSchemeId: "daintree", pluginThemeSnapshot: snapshot })
    ).toBeNull();
  });

  it("ignores a snapshot that doesn't validate", () => {
    const tampered = {
      ...snapshot,
      palette: { ...snapshot.palette, accent: "#fff; color: red" },
    };
    expect(
      readPluginThemeSnapshot({ colorSchemeId: source.id, pluginThemeSnapshot: tampered })
    ).toBeNull();
    expect(
      readPluginThemeSnapshot({
        colorSchemeId: source.id,
        pluginThemeSnapshot: { ...snapshot, pluginId: "other.plugin" },
      })
    ).toBeNull();
    expect(
      readPluginThemeSnapshot({
        colorSchemeId: source.id,
        pluginThemeSnapshot: { ...snapshot, version: 2 },
      })
    ).toBeNull();
    expect(readPluginThemeSnapshot(null)).toBeNull();
  });

  it("lets a boot path resolve the selection, after imported themes", () => {
    const config = { colorSchemeId: source.id, pluginThemeSnapshot: snapshot };
    const schemes = withSelectedPluginTheme([], config);
    expect(resolveAppTheme(source.id, schemes).id).toBe(source.id);

    const imported = { ...BUILT_IN_APP_SCHEMES[1]!, id: source.id, builtin: false };
    const shadowed = withSelectedPluginTheme([imported], config);
    expect(shadowed).toEqual([imported]);
  });
});
