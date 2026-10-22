import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storeState = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));

vi.mock("../../store.js", () => ({
  store: {
    get: vi.fn((key: string) => storeState.data[key]),
    set: vi.fn((key: string, value: unknown) => {
      const [root, field] = key.split(".") as [string, string | undefined];
      if (field === undefined) {
        storeState.data[root] = value;
        return;
      }
      storeState.data[root] = { ...(storeState.data[root] as object), [field]: value };
    }),
  },
}));

const broadcastToProjectRenderers = vi.hoisted(() => vi.fn());
vi.mock("../../ipc/utils.js", () => ({ broadcastToProjectRenderers }));

const repaintAllWindowThemes = vi.hoisted(() => vi.fn());
vi.mock("../../window/projectThemeChrome.js", () => ({ repaintAllWindowThemes }));

const getRegisteredProjectViews = vi.hoisted(() =>
  vi.fn<() => Array<{ projectId: string; webContents: unknown }>>(() => [])
);
vi.mock("../../window/webContentsRegistry.js", () => ({ getRegisteredProjectViews }));

import {
  answerProjectThemeSuggestion,
  getProjectThemeChoice,
  publishProjectThemeChoice,
  reconcileProjectPluginThemes,
  resetProjectThemeSuggestion,
  setProjectThemeScheme,
} from "../projectThemeStore.js";
import {
  clearPluginThemeRegistry,
  registerPluginThemes,
  unregisterPluginThemes,
} from "../plugin/PluginThemeRegistry.js";
import {
  compilePluginTheme,
  makePluginThemeId,
  toPluginThemeSnapshot,
} from "../../../shared/theme/pluginThemes.js";
import { BUILT_IN_THEME_SOURCES } from "../../../shared/theme/builtInThemes/index.js";
import type { PluginThemeSource } from "../../../shared/theme/types.js";
import { CHANNELS } from "../../ipc/channels.js";

const DAINTREE = BUILT_IN_THEME_SOURCES.find((source) => source.id === "daintree")!;
const LIGHT = BUILT_IN_THEME_SOURCES.find((source) => source.type === "light")!;

function themeSource(name = "Midnight"): PluginThemeSource {
  return {
    id: makePluginThemeId("acme.themes", "midnight"),
    name,
    type: DAINTREE.type,
    pluginId: "acme.themes",
    pluginName: "Acme Themes",
    palette: DAINTREE.palette,
  };
}

function offer(source: PluginThemeSource): void {
  registerPluginThemes("acme.themes", [{ source, scheme: compilePluginTheme(source) }]);
}

function appTheme(): Record<string, unknown> {
  return (storeState.data.appTheme ?? {}) as Record<string, unknown>;
}

describe("project theme store (#13833)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRegisteredProjectViews.mockReturnValue([]);
    storeState.data = { appTheme: { colorSchemeId: "daintree" } };
  });

  afterEach(() => {
    clearPluginThemeRegistry();
  });

  it("sets and clears a project's theme without touching the global selection", () => {
    setProjectThemeScheme("p1", LIGHT.id);
    expect(getProjectThemeChoice("p1")).toEqual({ colorSchemeId: LIGHT.id });
    expect(getProjectThemeChoice("p2")).toBeNull();
    expect(appTheme().colorSchemeId).toBe("daintree");

    setProjectThemeScheme("p1", null);
    expect(getProjectThemeChoice("p1")).toBeNull();
    expect(appTheme().projectThemes).toEqual({});
  });

  it("accepts an imported theme and refuses an id that names nothing", () => {
    storeState.data.appTheme = {
      colorSchemeId: "daintree",
      customSchemes: [{ id: "custom-paper", name: "Paper" }],
    };
    setProjectThemeScheme("p1", "custom-paper");
    expect(getProjectThemeChoice("p1")?.colorSchemeId).toBe("custom-paper");

    expect(() => setProjectThemeScheme("p1", "custom-missing")).toThrow();
    expect(getProjectThemeChoice("p1")?.colorSchemeId).toBe("custom-paper");
  });

  it("snapshots a plugin theme that is offered and refuses one that isn't", () => {
    const source = themeSource();
    expect(() => setProjectThemeScheme("p1", source.id)).toThrow();
    expect(getProjectThemeChoice("p1")).toBeNull();

    offer(source);
    setProjectThemeScheme("p1", source.id);
    expect(getProjectThemeChoice("p1")).toEqual({
      colorSchemeId: source.id,
      pluginThemeSnapshot: toPluginThemeSnapshot(source),
    });
  });

  it("drops the old plugin snapshot when the project moves to another theme", () => {
    const source = themeSource();
    offer(source);
    setProjectThemeScheme("p1", source.id);
    setProjectThemeScheme("p1", LIGHT.id);
    expect(getProjectThemeChoice("p1")).toEqual({ colorSchemeId: LIGHT.id });
  });

  it("accepting a suggestion shows it and remembers the answer", () => {
    answerProjectThemeSuggestion("p1", LIGHT.id, "accepted");
    expect(getProjectThemeChoice("p1")).toEqual({
      colorSchemeId: LIGHT.id,
      suggestionAnswer: { schemeId: LIGHT.id, answer: "accepted" },
    });
  });

  it("declining remembers the answer and keeps the project's current theme", () => {
    setProjectThemeScheme("p1", "daintree");
    answerProjectThemeSuggestion("p1", LIGHT.id, "declined");
    expect(getProjectThemeChoice("p1")).toEqual({
      colorSchemeId: "daintree",
      suggestionAnswer: { schemeId: LIGHT.id, answer: "declined" },
    });
  });

  it("records no answer when accepting a theme that can't be shown", () => {
    const source = themeSource();
    expect(() => answerProjectThemeSuggestion("p1", source.id, "accepted")).toThrow();
    expect(getProjectThemeChoice("p1")).toBeNull();
  });

  it("resetting the answer offers the suggestion again and keeps the theme", () => {
    answerProjectThemeSuggestion("p1", LIGHT.id, "accepted");
    resetProjectThemeSuggestion("p1");
    expect(getProjectThemeChoice("p1")).toEqual({ colorSchemeId: LIGHT.id });
  });

  it("publishes the choice to the project's views and repaints window chrome", () => {
    setProjectThemeScheme("p1", LIGHT.id);
    publishProjectThemeChoice("p1");
    expect(broadcastToProjectRenderers).toHaveBeenCalledWith("p1", CHANNELS.PROJECT_THEME_CHANGED, {
      projectId: "p1",
      choice: { colorSchemeId: LIGHT.id },
    });
    expect(repaintAllWindowThemes).toHaveBeenCalled();
  });

  it("also reaches a remote view of the project, which is routed by its host-scoped key", () => {
    getRegisteredProjectViews.mockReturnValue([
      { projectId: "p1", webContents: {} },
      { projectId: "host-1:p1", webContents: {} },
      { projectId: "host-1:p2", webContents: {} },
    ]);
    publishProjectThemeChoice("p1");
    const keys = broadcastToProjectRenderers.mock.calls.map(([key]) => key);
    expect(keys.sort()).toEqual(["host-1:p1", "p1"]);
  });

  describe("reconcileProjectPluginThemes", () => {
    it("refreshes the snapshot when the plugin updates its palette", () => {
      offer(themeSource());
      setProjectThemeScheme("p1", themeSource().id);
      const renamed = themeSource("Midnight Blue");
      offer(renamed);

      expect(reconcileProjectPluginThemes(() => true)).toEqual(["p1"]);
      expect(getProjectThemeChoice("p1")?.pluginThemeSnapshot).toEqual(
        toPluginThemeSnapshot(renamed)
      );
      expect(reconcileProjectPluginThemes(() => true)).toEqual([]);
    });

    it("keeps the choice but drops the snapshot once the plugin is gone", () => {
      const source = themeSource();
      offer(source);
      setProjectThemeScheme("p1", source.id);
      unregisterPluginThemes("acme.themes");

      expect(reconcileProjectPluginThemes(() => false)).toEqual([]);
      expect(getProjectThemeChoice("p1")?.pluginThemeSnapshot).toBeDefined();

      expect(reconcileProjectPluginThemes(() => true)).toEqual(["p1"]);
      expect(getProjectThemeChoice("p1")).toEqual({ colorSchemeId: source.id });
    });

    it("leaves projects showing a built-in alone", () => {
      setProjectThemeScheme("p1", LIGHT.id);
      expect(reconcileProjectPluginThemes(() => true)).toEqual([]);
    });
  });
});
