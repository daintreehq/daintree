import { describe, expect, it } from "vitest";
import { isCssDeclarationValue, sanitizeThemeExtensions } from "../extensionKeys.js";
import {
  BUILT_IN_APP_SCHEMES,
  getAppThemeCssVariables,
  getAppThemeFallbackType,
  normalizeAppColorScheme,
  resolveAppTheme,
} from "../themes.js";
import { EXTENSION_KEYS, type AppColorScheme } from "../types.js";

const DARK_BASE = BUILT_IN_APP_SCHEMES.find((scheme) => scheme.type === "dark")!;
const LIGHT_BASE = BUILT_IN_APP_SCHEMES.find((scheme) => scheme.type === "light")!;

function withExtensions(base: AppColorScheme, extensions: Record<string, string>): AppColorScheme {
  return { ...base, id: "custom-test", builtin: false, extensions } as AppColorScheme;
}

describe("theme extensions cannot shadow engine variables", () => {
  it("an extension named after a token does not replace the contrast-checked token", () => {
    const scheme = withExtensions(DARK_BASE, {
      "theme-text-primary": "#202020",
      "toolbar-project-bg": "#123456",
    });
    const variables = getAppThemeCssVariables(scheme);

    expect(variables["--theme-text-primary"]).toBe(DARK_BASE.tokens["text-primary"]);
    expect(variables["--toolbar-project-bg"]).toBe("#123456");
  });

  it("an extension cannot rewrite the colour mode or the light polarity chrome", () => {
    const polarityOnly = getAppThemeCssVariables(withExtensions(LIGHT_BASE, {}));
    const variables = getAppThemeCssVariables(
      withExtensions(LIGHT_BASE, {
        "theme-color-mode": "dark",
        "shadow-modal": "none",
        "pill-surface": "red",
      })
    );

    expect(variables["--theme-color-mode"]).toBe("light");
    expect(variables["--shadow-modal"]).toBe(polarityOnly["--shadow-modal"]);
    expect(variables["--pill-surface"]).toBe(polarityOnly["--pill-surface"]);
  });

  it("emits no variable for an unregistered extension key", () => {
    const variables = getAppThemeCssVariables(
      withExtensions(
        DARK_BASE,
        JSON.parse('{"custom-foo":"#123456","__proto__":"x","constructor":"y"}')
      )
    );

    expect(Object.keys(variables).filter((name) => name.includes("custom-foo"))).toEqual([]);
    expect(Object.hasOwn(variables, "--constructor")).toBe(false);
  });

  it("normalizing a scheme drops unregistered extension keys and keeps registered ones", () => {
    const scheme = normalizeAppColorScheme({
      type: "dark",
      tokens: { "text-primary": "#e6e6e6" },
      extensions: JSON.parse(
        '{"theme-text-primary":"#202020","__proto__":"#000000","panel-grid-bg":"#101010"}'
      ),
    });

    expect(scheme.tokens["text-primary"]).toBe("#e6e6e6");
    expect(scheme.extensions).toEqual({ "panel-grid-bg": "#101010" });
  });
});

describe("sanitizeThemeExtensions", () => {
  it("keeps registered string values and returns a fresh object", () => {
    const input = { "panel-grid-bg": "#101010", "dock-bg": "#202020" };
    const sanitized = sanitizeThemeExtensions(input);

    expect(sanitized).toEqual(input);
    expect(sanitized).not.toBe(input);
  });

  it("drops unregistered keys, non-string values and inherited properties", () => {
    const inherited = Object.create({ "panel-grid-bg": "#101010" }) as Record<string, unknown>;
    inherited["dock-bg"] = 3;
    Object.defineProperty(inherited, "toString", { value: "#000000", enumerable: true });

    expect(sanitizeThemeExtensions(inherited)).toEqual({});
    expect(sanitizeThemeExtensions(undefined)).toEqual({});
  });

  it("keeps every built-in theme's extensions", () => {
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      expect(sanitizeThemeExtensions(scheme.extensions), scheme.id).toEqual(
        scheme.extensions ?? {}
      );
    }
  });

  it("drops a registered key whose value would end its declaration", () => {
    expect(
      sanitizeThemeExtensions({ "panel-grid-bg": "#101010; --theme-text-primary: #202020" })
    ).toEqual({});
  });

  it("no registered key collides with a variable the engine emits", () => {
    const engineVariables = new Set(
      BUILT_IN_APP_SCHEMES.flatMap((scheme) =>
        Object.keys(getAppThemeCssVariables({ ...scheme, extensions: {} }))
      )
    );

    expect(EXTENSION_KEYS.filter((key) => engineVariables.has(`--${key}`))).toEqual([]);
  });
});

describe("isCssDeclarationValue", () => {
  it.each([
    "#101010",
    "rgb(from var(--theme-shadow-color) r g b / 0.4)",
    'url("data:image/png;base64,AAAA")',
    "url(data:image/png;base64,AAAA)",
    "linear-gradient(180deg, #1a2027, #0f1115)",
    "'a;b' 'c}d'",
    '"a\\"b"',
    "URL(data:image/png;base64,AAAA)",
    'url( "a;b" )',
    "url()",
  ])("accepts %s", (value) => {
    expect(isCssDeclarationValue(value)).toBe(true);
  });

  it.each([
    "red; --theme-text-primary: #202020",
    "red !important",
    "red } :root { color: blue",
    "red /* hidden",
    "calc(1px",
    "1px)",
    '"unterminated',
    '"red\\',
    "red\nblue",
    "\\31 0px",
    'url(a"); } :root { --theme-text-primary: #202020 !important; } #x { --y: url("b)',
    'u\\72l(a"); } :root { color: red; } #x { --y: url("b)',
    "url(a b)",
    "url(a",
  ])("rejects %s", (value) => {
    expect(isCssDeclarationValue(value)).toBe(false);
  });
});

describe("resolveAppTheme fallback polarity", () => {
  it("falls back to a built-in of the requested type for an unknown id", () => {
    expect(resolveAppTheme("custom-deleted", [], "light").type).toBe("light");
    expect(resolveAppTheme("custom-deleted", [], "dark").type).toBe("dark");
    expect(resolveAppTheme("custom-deleted").type).toBe("dark");
  });

  it("resolves a known id regardless of the fallback type", () => {
    const custom = withExtensions(DARK_BASE, {});
    expect(resolveAppTheme(custom.id, [custom], "light")).toBe(custom);
    expect(resolveAppTheme(LIGHT_BASE.id, [], "dark")).toBe(LIGHT_BASE);
  });

  it("takes the polarity of the one appearance slot that holds the id", () => {
    const preferences = { preferredDarkSchemeId: "daintree", preferredLightSchemeId: "mine" };

    expect(getAppThemeFallbackType("mine", preferences, true)).toBe("light");
    expect(
      getAppThemeFallbackType("mine", { ...preferences, preferredDarkSchemeId: "mine" }, true)
    ).toBe("dark");
    expect(getAppThemeFallbackType("other", preferences, false)).toBe("light");
    expect(getAppThemeFallbackType("other", {}, true)).toBe("dark");
  });

  it("follows the system when both slots or neither hold the id", () => {
    const both = { preferredDarkSchemeId: "mine", preferredLightSchemeId: "mine" };

    expect(getAppThemeFallbackType("mine", both, false)).toBe("light");
    expect(getAppThemeFallbackType("mine", both, true)).toBe("dark");
    expect(getAppThemeFallbackType("", { preferredLightSchemeId: "" }, true)).toBe("dark");
  });

  it("ignores a slot persisted with a non-string value", () => {
    const corrupt: { preferredLightSchemeId?: string } = JSON.parse(
      '{"preferredLightSchemeId":42}'
    );

    expect(getAppThemeFallbackType("mine", corrupt, true)).toBe("dark");
  });

  it("matches a slot regardless of surrounding whitespace", () => {
    expect(getAppThemeFallbackType(" mine ", { preferredLightSchemeId: "mine" }, true)).toBe(
      "light"
    );
    expect(getAppThemeFallbackType("mine", { preferredLightSchemeId: " mine " }, true)).toBe(
      "light"
    );
  });
});
