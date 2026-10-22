import { describe, expect, it } from "vitest";
import {
  compilePluginTheme,
  makePluginThemeId,
  toPluginThemeSnapshot,
} from "../pluginThemes.js";
import {
  projectThemeSuggestionAnswer,
  readProjectThemeChoice,
  resolveProjectThemeOverride,
} from "../projectThemes.js";
import { BUILT_IN_THEME_SOURCES } from "../builtInThemes/index.js";
import { BUILT_IN_APP_SCHEMES } from "../themes.js";
import type { AppColorScheme, PluginThemeSource } from "../types.js";

const DAINTREE = BUILT_IN_THEME_SOURCES.find((source) => source.id === "daintree")!;
const PLUGIN_SOURCE: PluginThemeSource = {
  id: makePluginThemeId("acme.themes", "midnight"),
  name: "Midnight",
  type: "dark",
  pluginId: "acme.themes",
  pluginName: "Acme Themes",
  palette: structuredClone(DAINTREE.palette),
  ...(DAINTREE.tokens ? { tokens: structuredClone(DAINTREE.tokens) } : {}),
  ...(DAINTREE.extensions ? { extensions: structuredClone(DAINTREE.extensions) } : {}),
};

const lightBuiltIn = BUILT_IN_APP_SCHEMES.find((scheme) => scheme.type === "light")!;

describe("readProjectThemeChoice", () => {
  it("reads the named project's choice and nobody else's", () => {
    const config = {
      colorSchemeId: "daintree",
      projectThemes: {
        a: { colorSchemeId: ` ${lightBuiltIn.id} ` },
        b: { suggestionAnswer: { schemeId: lightBuiltIn.id, answer: "declined" } },
      },
    };
    expect(readProjectThemeChoice(config, "a")).toEqual({ colorSchemeId: lightBuiltIn.id });
    expect(readProjectThemeChoice(config, "b")).toEqual({
      suggestionAnswer: { schemeId: lightBuiltIn.id, answer: "declined" },
    });
    expect(readProjectThemeChoice(config, "c")).toBeNull();
    expect(readProjectThemeChoice(config, null)).toBeNull();
  });

  it("drops malformed fields from a hand-edited store without losing the rest", () => {
    const config = {
      projectThemes: {
        a: {
          colorSchemeId: lightBuiltIn.id,
          suggestionAnswer: { schemeId: lightBuiltIn.id, answer: "maybe" },
        },
        b: { colorSchemeId: 42, suggestionAnswer: "accepted" },
      },
    };
    expect(readProjectThemeChoice(config, "a")).toEqual({ colorSchemeId: lightBuiltIn.id });
    expect(readProjectThemeChoice(config, "b")).toBeNull();
  });

  it("never reads an inherited key as a project", () => {
    expect(readProjectThemeChoice({ projectThemes: {} }, "toString")).toBeNull();
    expect(readProjectThemeChoice({ projectThemes: [] }, "0")).toBeNull();
  });

  it("keeps a plugin snapshot only beside a theme id", () => {
    const snapshot = toPluginThemeSnapshot(PLUGIN_SOURCE);
    const config = { projectThemes: { a: { pluginThemeSnapshot: snapshot } } };
    expect(readProjectThemeChoice(config, "a")).toBeNull();
  });
});

describe("resolveProjectThemeOverride", () => {
  it("is null for a project following the global theme", () => {
    expect(resolveProjectThemeOverride(null, [])).toBeNull();
    expect(
      resolveProjectThemeOverride(
        { suggestionAnswer: { schemeId: "x", answer: "declined" } },
        []
      )
    ).toBeNull();
  });

  it("resolves a built-in and an imported theme", () => {
    const custom = { ...lightBuiltIn, id: "custom-paper", name: "Paper", builtin: false };
    expect(resolveProjectThemeOverride({ colorSchemeId: lightBuiltIn.id }, [])).toBe(lightBuiltIn);
    expect(resolveProjectThemeOverride({ colorSchemeId: "custom-paper" }, [custom])).toBe(custom);
  });

  it("is null for a theme that no longer exists, rather than a fallback built-in", () => {
    expect(resolveProjectThemeOverride({ colorSchemeId: "custom-deleted" }, [])).toBeNull();
  });

  it("paints a plugin theme from its snapshot before the plugin loads", () => {
    const choice = {
      colorSchemeId: PLUGIN_SOURCE.id,
      pluginThemeSnapshot: toPluginThemeSnapshot(PLUGIN_SOURCE),
    };
    expect(resolveProjectThemeOverride(choice, [])).toEqual(compilePluginTheme(PLUGIN_SOURCE));
  });

  it("prefers the loaded catalog's copy over the snapshot", () => {
    const updated: AppColorScheme = { ...compilePluginTheme(PLUGIN_SOURCE), name: "Midnight 2" };
    const choice = {
      colorSchemeId: PLUGIN_SOURCE.id,
      pluginThemeSnapshot: toPluginThemeSnapshot(PLUGIN_SOURCE),
    };
    expect(resolveProjectThemeOverride(choice, [updated])).toBe(updated);
  });

  it("is null for a plugin theme with no plugin and no snapshot", () => {
    expect(resolveProjectThemeOverride({ colorSchemeId: PLUGIN_SOURCE.id }, [])).toBeNull();
  });
});

describe("projectThemeSuggestionAnswer", () => {
  const choice = {
    suggestionAnswer: { schemeId: lightBuiltIn.id, answer: "accepted" as const },
  };

  it("returns the answer only for the theme it was about", () => {
    expect(projectThemeSuggestionAnswer(choice, lightBuiltIn.id)).toBe("accepted");
    expect(projectThemeSuggestionAnswer(choice, "daintree")).toBeNull();
    expect(projectThemeSuggestionAnswer(null, lightBuiltIn.id)).toBeNull();
    expect(projectThemeSuggestionAnswer(choice, null)).toBeNull();
  });
});
