import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeThemeMock = vi.hoisted(() => ({ shouldUseDarkColors: true }));
const windowMock = vi.hoisted(() => ({
  isDestroyed: vi.fn(() => false),
  setBackgroundColor: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => [windowMock]) },
  nativeTheme: nativeThemeMock,
}));

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

const broadcastToRenderer = vi.hoisted(() => vi.fn());
vi.mock("../../ipc/utils.js", () => ({ broadcastToVisibleRenderersOrAll: broadcastToRenderer }));

const setTitleBarOverlayTheme = vi.hoisted(() => vi.fn());
vi.mock("../../window/titleBarOverlay.js", () => ({ setTitleBarOverlayTheme }));

import {
  persistColorSchemeSelection,
  reconcilePluginThemeSelection,
} from "../appThemePluginSelection.js";
import { clearPluginThemeRegistry, registerPluginThemes } from "../plugin/PluginThemeRegistry.js";
import {
  compilePluginTheme,
  makePluginThemeId,
  toPluginThemeSnapshot,
} from "../../../shared/theme/pluginThemes.js";
import { BUILT_IN_THEME_SOURCES } from "../../../shared/theme/builtInThemes/index.js";
import type { PluginThemeSource } from "../../../shared/theme/types.js";
import { CHANNELS } from "../../ipc/channels.js";
import { store } from "../../store.js";

const DAINTREE = BUILT_IN_THEME_SOURCES.find((source) => source.id === "daintree")!;
const BONDI = BUILT_IN_THEME_SOURCES.find((source) => source.id === "bondi")!;
const LIGHT_BUILT_IN = BUILT_IN_THEME_SOURCES.find(
  (source) => source.type === "light" && source.id !== "bondi"
)!;

function themeSource(themeId: string, base: typeof DAINTREE, name = "Midnight"): PluginThemeSource {
  return {
    id: makePluginThemeId("acme.themes", themeId),
    name,
    type: base.type,
    pluginId: "acme.themes",
    pluginName: "Acme Themes",
    palette: base.palette,
  };
}

function offer(...sources: PluginThemeSource[]): void {
  registerPluginThemes(
    "acme.themes",
    sources.map((source) => ({ source, scheme: compilePluginTheme(source) }))
  );
}

function appTheme(): Record<string, unknown> {
  return storeState.data.appTheme as Record<string, unknown>;
}

const settles = () => true;

describe("plugin theme selection (#13832)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.data = {};
    nativeThemeMock.shouldUseDarkColors = true;
  });

  afterEach(() => {
    clearPluginThemeRegistry();
  });

  it("writes the snapshot before the id it paints", () => {
    const source = themeSource("midnight", DAINTREE);
    offer(source);
    storeState.data.appTheme = { colorSchemeId: "daintree" };

    persistColorSchemeSelection(source.id);

    expect(appTheme()).toEqual({
      colorSchemeId: source.id,
      pluginThemeSnapshot: toPluginThemeSnapshot(source),
    });
    expect(vi.mocked(store.set).mock.calls.map(([key]) => key)).toEqual([
      "appTheme.pluginThemeSnapshot",
      "appTheme.colorSchemeId",
    ]);
  });

  it("leaves a built-in selection's stale snapshot alone, where it no longer applies", () => {
    const source = themeSource("midnight", DAINTREE);
    storeState.data.appTheme = {
      colorSchemeId: source.id,
      pluginThemeSnapshot: toPluginThemeSnapshot(source),
    };
    persistColorSchemeSelection("bondi");
    expect(appTheme().colorSchemeId).toBe("bondi");
  });

  it("does nothing while a built-in or imported theme is selected", () => {
    storeState.data.appTheme = { colorSchemeId: "custom-ocean" };
    expect(reconcilePluginThemeSelection(settles)).toBeNull();
    expect(broadcastToRenderer).not.toHaveBeenCalled();
  });

  it("refreshes the snapshot when the offered theme changed", () => {
    const before = themeSource("midnight", DAINTREE);
    const after = { ...before, name: "Midnight 2" };
    offer(after);
    storeState.data.appTheme = {
      colorSchemeId: before.id,
      pluginThemeSnapshot: toPluginThemeSnapshot(before),
    };

    expect(reconcilePluginThemeSelection(settles)).toBeNull();
    expect(appTheme().pluginThemeSnapshot).toEqual(toPluginThemeSnapshot(after));
    expect(broadcastToRenderer).not.toHaveBeenCalled();
  });

  it("falls back to the preferred built-in of the lost theme's polarity and says so", () => {
    const lost = themeSource("dawn", BONDI, "Dawn");
    storeState.data.appTheme = {
      colorSchemeId: lost.id,
      pluginThemeSnapshot: toPluginThemeSnapshot(lost),
      preferredDarkSchemeId: "daintree",
      preferredLightSchemeId: LIGHT_BUILT_IN.id,
      recentSchemeIds: [lost.id, "daintree"],
    };

    expect(reconcilePluginThemeSelection(settles)).toBe(LIGHT_BUILT_IN.id);
    expect(appTheme()).toMatchObject({
      colorSchemeId: LIGHT_BUILT_IN.id,
      recentSchemeIds: ["daintree"],
    });
    expect(windowMock.setBackgroundColor).toHaveBeenCalledTimes(1);
    expect(setTitleBarOverlayTheme).toHaveBeenCalledTimes(1);
    expect(broadcastToRenderer).toHaveBeenCalledWith(
      CHANNELS.NOTIFICATION_SHOW_TOAST,
      expect.objectContaining({
        type: "info",
        title: "Theme switched",
        message: `"Dawn" from Acme Themes isn't available anymore. Now using "${LIGHT_BUILT_IN.name}".`,
      })
    );
  });

  it("ignores a preferred slot that holds an imported or opposite-polarity theme", () => {
    const lost = themeSource("dawn", BONDI, "Dawn");
    storeState.data.appTheme = {
      colorSchemeId: lost.id,
      pluginThemeSnapshot: toPluginThemeSnapshot(lost),
      preferredLightSchemeId: "custom-paper",
    };
    expect(reconcilePluginThemeSelection(settles)).toBe("bondi");

    storeState.data.appTheme = {
      colorSchemeId: lost.id,
      pluginThemeSnapshot: toPluginThemeSnapshot(lost),
      preferredLightSchemeId: "daintree",
    };
    expect(reconcilePluginThemeSelection(settles)).toBe("bondi");
  });

  it("refuses a plugin theme no loaded plugin offers, writing nothing", () => {
    storeState.data.appTheme = { colorSchemeId: "daintree" };
    expect(() => persistColorSchemeSelection(makePluginThemeId("acme.themes", "gone"))).toThrow();
    expect(appTheme()).toEqual({ colorSchemeId: "daintree" });
  });

  it("falls back by system appearance when no snapshot says which polarity was lost", () => {
    nativeThemeMock.shouldUseDarkColors = false;
    storeState.data.appTheme = { colorSchemeId: makePluginThemeId("acme.themes", "gone") };

    expect(reconcilePluginThemeSelection(settles)).toBe("bondi");
    expect(broadcastToRenderer).toHaveBeenCalledWith(
      CHANNELS.NOTIFICATION_SHOW_TOAST,
      expect.objectContaining({ message: expect.stringContaining("The plugin theme you chose") })
    );
  });

  it("waits while the catalog can't speak for the plugin that owns the selection", () => {
    const lost = themeSource("midnight", DAINTREE);
    storeState.data.appTheme = { colorSchemeId: lost.id };

    expect(reconcilePluginThemeSelection((pluginId) => pluginId !== "acme.themes")).toBeNull();
    expect(appTheme().colorSchemeId).toBe(lost.id);
    expect(broadcastToRenderer).not.toHaveBeenCalled();
  });
});
