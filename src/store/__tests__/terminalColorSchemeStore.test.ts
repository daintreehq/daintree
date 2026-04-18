import { beforeEach, describe, expect, it } from "vitest";
import { getTerminalScrollbarDefaults } from "@shared/theme";
import { DAINTREE_TERMINAL_THEME } from "@/utils/terminalTheme";
import {
  DEFAULT_SCHEME_ID,
  getMappedTerminalScheme,
  getSchemeById,
  type TerminalColorScheme,
} from "@/config/terminalColorSchemes";
import { useAppThemeStore } from "../appThemeStore";
import {
  selectEffectiveTheme,
  selectWrapperBackground,
  useTerminalColorSchemeStore,
} from "../terminalColorSchemeStore";

const CUSTOM_SCHEME: TerminalColorScheme = {
  id: "custom-test",
  name: "Test Theme",
  type: "dark",
  builtin: false,
  colors: {
    background: "#111111",
    foreground: "#eeeeee",
    cursor: "#ff0000",
    cursorAccent: "#111111",
    selectionBackground: "#333333",
    selectionForeground: "#eeeeee",
    black: "#000000",
    red: "#ff0000",
    green: "#00ff00",
    yellow: "#ffff00",
    blue: "#0000ff",
    magenta: "#ff00ff",
    cyan: "#00ffff",
    white: "#ffffff",
    brightBlack: "#555555",
    brightRed: "#ff5555",
    brightGreen: "#55ff55",
    brightYellow: "#ffff55",
    brightBlue: "#5555ff",
    brightMagenta: "#ff55ff",
    brightCyan: "#55ffff",
    brightWhite: "#ffffff",
  },
};

describe("terminalColorSchemeStore", () => {
  beforeEach(() => {
    useTerminalColorSchemeStore.setState({
      selectedSchemeId: DEFAULT_SCHEME_ID,
      customSchemes: [],
      recentSchemeIds: [],
      previewSchemeId: null,
    });
    useAppThemeStore.setState({
      selectedSchemeId: "daintree",
      customSchemes: [],
      colorVisionMode: "default",
    });
  });

  it("defaults to daintree scheme", () => {
    expect(useTerminalColorSchemeStore.getState().selectedSchemeId).toBe(DEFAULT_SCHEME_ID);
  });

  it("switching scheme updates selectedSchemeId", () => {
    useTerminalColorSchemeStore.getState().setSelectedSchemeId("dracula");
    expect(useTerminalColorSchemeStore.getState().selectedSchemeId).toBe("dracula");
  });

  it("uses the mapped terminal scheme when the default app-linked scheme is selected", () => {
    const mapped = getMappedTerminalScheme("daintree");
    expect(mapped).toBeDefined();

    const theme = useTerminalColorSchemeStore.getState().getEffectiveTheme();

    expect(theme).toEqual({
      ...mapped!.colors,
      ...getTerminalScrollbarDefaults(mapped!.type),
    });
  });

  it("updates the default app-linked terminal scheme when the app theme changes", () => {
    useAppThemeStore.setState({ selectedSchemeId: "bondi" });
    const mapped = getMappedTerminalScheme("bondi");
    expect(mapped).toBeDefined();

    const theme = useTerminalColorSchemeStore.getState().getEffectiveTheme();

    expect(theme).toEqual({
      ...mapped!.colors,
      ...getTerminalScrollbarDefaults(mapped!.type),
    });
  });

  it("returns built-in scheme colors with type-based scrollbar defaults for explicit schemes", () => {
    const dracula = getSchemeById("dracula");
    expect(dracula).toBeDefined();
    useTerminalColorSchemeStore.getState().setSelectedSchemeId("dracula");

    const theme = useTerminalColorSchemeStore.getState().getEffectiveTheme();

    expect(theme).toEqual({
      ...dracula!.colors,
      ...getTerminalScrollbarDefaults(dracula!.type),
    });
  });

  it("keeps an explicit scheme stable when the app theme changes", () => {
    const dracula = getSchemeById("dracula");
    expect(dracula).toBeDefined();
    useTerminalColorSchemeStore.getState().setSelectedSchemeId("dracula");
    useAppThemeStore.setState({ selectedSchemeId: "bondi" });

    const theme = useTerminalColorSchemeStore.getState().getEffectiveTheme();

    expect(theme).toEqual({
      ...dracula!.colors,
      ...getTerminalScrollbarDefaults(dracula!.type),
    });
  });

  it("addCustomScheme adds and deduplicates", () => {
    const store = useTerminalColorSchemeStore.getState();
    store.addCustomScheme(CUSTOM_SCHEME);
    expect(useTerminalColorSchemeStore.getState().customSchemes).toHaveLength(1);

    store.addCustomScheme({ ...CUSTOM_SCHEME, name: "Updated" });
    expect(useTerminalColorSchemeStore.getState().customSchemes).toHaveLength(1);
    expect(useTerminalColorSchemeStore.getState().customSchemes[0]!.name).toBe("Updated");
  });

  it("removeCustomScheme removes and resets selection if needed", () => {
    const store = useTerminalColorSchemeStore.getState();
    store.addCustomScheme(CUSTOM_SCHEME);
    store.setSelectedSchemeId("custom-test");
    expect(useTerminalColorSchemeStore.getState().selectedSchemeId).toBe("custom-test");

    useTerminalColorSchemeStore.getState().removeCustomScheme("custom-test");
    expect(useTerminalColorSchemeStore.getState().customSchemes).toHaveLength(0);
    expect(useTerminalColorSchemeStore.getState().selectedSchemeId).toBe(DEFAULT_SCHEME_ID);
  });

  it("returns custom scheme colors with scrollbar defaults", () => {
    const store = useTerminalColorSchemeStore.getState();
    store.addCustomScheme(CUSTOM_SCHEME);
    store.setSelectedSchemeId("custom-test");

    const theme = useTerminalColorSchemeStore.getState().getEffectiveTheme();

    expect(theme).toEqual({
      ...CUSTOM_SCHEME.colors,
      ...getTerminalScrollbarDefaults(CUSTOM_SCHEME.type),
    });
  });

  describe("previewSchemeId override", () => {
    it("previewSchemeId overrides selectedSchemeId in getEffectiveTheme", () => {
      const store = useTerminalColorSchemeStore.getState();
      store.setSelectedSchemeId("dracula");
      store.setPreviewSchemeId("solarized-dark");

      const solarized = getSchemeById("solarized-dark");
      const theme = useTerminalColorSchemeStore.getState().getEffectiveTheme();

      expect(theme).toEqual({
        ...solarized!.colors,
        ...getTerminalScrollbarDefaults(solarized!.type),
      });
    });

    it("clearing previewSchemeId restores the committed theme", () => {
      const store = useTerminalColorSchemeStore.getState();
      store.setSelectedSchemeId("dracula");
      store.setPreviewSchemeId("solarized-dark");
      store.setPreviewSchemeId(null);

      const dracula = getSchemeById("dracula");
      const theme = useTerminalColorSchemeStore.getState().getEffectiveTheme();

      expect(theme).toEqual({
        ...dracula!.colors,
        ...getTerminalScrollbarDefaults(dracula!.type),
      });
    });

    it("does not mutate selectedSchemeId or recentSchemeIds during preview", () => {
      const store = useTerminalColorSchemeStore.getState();
      store.setSelectedSchemeId("dracula");
      store.setPreviewSchemeId("solarized-dark");

      const state = useTerminalColorSchemeStore.getState();
      expect(state.selectedSchemeId).toBe("dracula");
      expect(state.recentSchemeIds).not.toContain("solarized-dark");
    });

    it("selectEffectiveTheme cache invalidates when only previewSchemeId changes", () => {
      const store = useTerminalColorSchemeStore.getState();
      store.setSelectedSchemeId("dracula");
      const first = selectEffectiveTheme(useTerminalColorSchemeStore.getState());

      store.setPreviewSchemeId("solarized-dark");
      const second = selectEffectiveTheme(useTerminalColorSchemeStore.getState());

      const solarized = getSchemeById("solarized-dark");
      expect(first).not.toEqual(second);
      expect(second).toEqual({
        ...solarized!.colors,
        ...getTerminalScrollbarDefaults(solarized!.type),
      });
    });

    it("previewing the default app-linked scheme derives from the app theme", () => {
      useAppThemeStore.setState({ selectedSchemeId: "bondi" });
      const store = useTerminalColorSchemeStore.getState();
      store.setSelectedSchemeId("dracula");
      store.setPreviewSchemeId(DEFAULT_SCHEME_ID);

      const mapped = getMappedTerminalScheme("bondi");
      expect(mapped).toBeDefined();

      const theme = useTerminalColorSchemeStore.getState().getEffectiveTheme();
      expect(theme).toEqual({
        ...mapped!.colors,
        ...getTerminalScrollbarDefaults(mapped!.type),
      });
    });

    it("invalidates the cache correctly across a null → dracula → null → default → null walk", () => {
      const store = useTerminalColorSchemeStore.getState();
      store.setSelectedSchemeId("solarized-dark");

      const solarized = getSchemeById("solarized-dark")!;
      const dracula = getSchemeById("dracula")!;
      const mapped = getMappedTerminalScheme("daintree")!;

      const expectSolarized = () =>
        expect(selectEffectiveTheme(useTerminalColorSchemeStore.getState())).toEqual({
          ...solarized.colors,
          ...getTerminalScrollbarDefaults(solarized.type),
        });
      const expectDracula = () =>
        expect(selectEffectiveTheme(useTerminalColorSchemeStore.getState())).toEqual({
          ...dracula.colors,
          ...getTerminalScrollbarDefaults(dracula.type),
        });
      const expectMapped = () =>
        expect(selectEffectiveTheme(useTerminalColorSchemeStore.getState())).toEqual({
          ...mapped.colors,
          ...getTerminalScrollbarDefaults(mapped.type),
        });

      // Start: previewSchemeId null → committed is solarized-dark.
      expectSolarized();

      // Hop 1: preview dracula.
      store.setPreviewSchemeId("dracula");
      expectDracula();

      // Hop 2: clear preview → back to solarized.
      store.setPreviewSchemeId(null);
      expectSolarized();

      // Hop 3: preview the default app-linked scheme → reflects app theme mapping.
      store.setPreviewSchemeId(DEFAULT_SCHEME_ID);
      expectMapped();

      // Hop 4: clear again → back to solarized.
      store.setPreviewSchemeId(null);
      expectSolarized();
    });

    it("removeCustomScheme clears a dangling previewSchemeId pointing at it", () => {
      const store = useTerminalColorSchemeStore.getState();
      store.addCustomScheme(CUSTOM_SCHEME);
      store.setPreviewSchemeId("custom-test");
      store.removeCustomScheme("custom-test");
      expect(useTerminalColorSchemeStore.getState().previewSchemeId).toBeNull();
    });
  });

  it("falls back to the default CSS-backed terminal theme for an unmapped app theme", () => {
    useAppThemeStore.setState({ selectedSchemeId: "custom-unknown-theme" });

    const theme = useTerminalColorSchemeStore.getState().getEffectiveTheme();

    expect(theme).toEqual(DAINTREE_TERMINAL_THEME);
  });

  describe("recentSchemeIds LRU", () => {
    it("starts empty", () => {
      expect(useTerminalColorSchemeStore.getState().recentSchemeIds).toEqual([]);
    });

    it("prepends the newly selected scheme id", () => {
      useTerminalColorSchemeStore.getState().setSelectedSchemeId("dracula");
      expect(useTerminalColorSchemeStore.getState().recentSchemeIds).toEqual(["dracula"]);

      useTerminalColorSchemeStore.getState().setSelectedSchemeId("solarized-dark");
      expect(useTerminalColorSchemeStore.getState().recentSchemeIds).toEqual([
        "solarized-dark",
        "dracula",
      ]);
    });

    it("deduplicates when re-selecting an existing id (moves to front)", () => {
      const store = useTerminalColorSchemeStore.getState();
      store.setSelectedSchemeId("dracula");
      store.setSelectedSchemeId("solarized-dark");
      store.setSelectedSchemeId("monokai");
      store.setSelectedSchemeId("dracula");

      expect(useTerminalColorSchemeStore.getState().recentSchemeIds).toEqual([
        "dracula",
        "monokai",
        "solarized-dark",
      ]);
    });

    it("caps the list at 5 entries", () => {
      const store = useTerminalColorSchemeStore.getState();
      const ids = ["a", "b", "c", "d", "e", "f", "g"];
      for (const id of ids) store.setSelectedSchemeId(id);

      const recent = useTerminalColorSchemeStore.getState().recentSchemeIds;
      expect(recent).toHaveLength(5);
      expect(recent).toEqual(["g", "f", "e", "d", "c"]);
    });

    it("setRecentSchemeIds replaces the list and respects the 5-cap", () => {
      useTerminalColorSchemeStore
        .getState()
        .setRecentSchemeIds(["a", "b", "c", "d", "e", "f", "g"]);
      expect(useTerminalColorSchemeStore.getState().recentSchemeIds).toEqual([
        "a",
        "b",
        "c",
        "d",
        "e",
      ]);
    });

    it("removing a custom scheme strips its id from the recents list", () => {
      const store = useTerminalColorSchemeStore.getState();
      store.addCustomScheme(CUSTOM_SCHEME);
      store.setSelectedSchemeId("custom-test");
      store.setSelectedSchemeId("dracula");
      expect(useTerminalColorSchemeStore.getState().recentSchemeIds).toContain("custom-test");

      useTerminalColorSchemeStore.getState().removeCustomScheme("custom-test");
      expect(useTerminalColorSchemeStore.getState().recentSchemeIds).not.toContain("custom-test");
      expect(useTerminalColorSchemeStore.getState().recentSchemeIds).toEqual(["dracula"]);
    });
  });

  describe("selectWrapperBackground", () => {
    it("returns the mapped terminal background for the default app-linked scheme", () => {
      const mapped = getMappedTerminalScheme("daintree");
      expect(mapped).toBeDefined();

      expect(selectWrapperBackground(useTerminalColorSchemeStore.getState())).toBe(
        mapped!.colors.background
      );
    });

    it("tracks app theme changes for the default app-linked scheme", () => {
      useAppThemeStore.setState({ selectedSchemeId: "bondi" });
      const mapped = getMappedTerminalScheme("bondi");
      expect(mapped).toBeDefined();

      expect(selectWrapperBackground(useTerminalColorSchemeStore.getState())).toBe(
        mapped!.colors.background
      );
    });

    it("returns the selected built-in scheme background for explicit schemes", () => {
      const dracula = getSchemeById("dracula");
      expect(dracula).toBeDefined();
      useTerminalColorSchemeStore.getState().setSelectedSchemeId("dracula");

      expect(selectWrapperBackground(useTerminalColorSchemeStore.getState())).toBe(
        dracula!.colors.background
      );
    });

    it("returns the selected custom scheme background", () => {
      useTerminalColorSchemeStore.getState().addCustomScheme(CUSTOM_SCHEME);
      useTerminalColorSchemeStore.getState().setSelectedSchemeId("custom-test");

      expect(selectWrapperBackground(useTerminalColorSchemeStore.getState())).toBe(
        CUSTOM_SCHEME.colors.background
      );
    });

    it("returns updated color when a custom scheme is replaced", () => {
      const store = useTerminalColorSchemeStore.getState();
      store.addCustomScheme(CUSTOM_SCHEME);
      store.setSelectedSchemeId("custom-test");
      store.addCustomScheme({
        ...CUSTOM_SCHEME,
        colors: { ...CUSTOM_SCHEME.colors, background: "#222222" },
      });

      expect(selectWrapperBackground(useTerminalColorSchemeStore.getState())).toBe("#222222");
    });

    it("falls back to the canvas variable for an unmapped app theme", () => {
      useAppThemeStore.setState({ selectedSchemeId: "custom-unknown-theme" });

      expect(selectWrapperBackground(useTerminalColorSchemeStore.getState())).toBe(
        "var(--theme-surface-canvas)"
      );
    });

    it("falls back to the canvas variable for an unknown scheme id", () => {
      useTerminalColorSchemeStore.setState({ selectedSchemeId: "nonexistent" });

      expect(selectWrapperBackground(useTerminalColorSchemeStore.getState())).toBe(
        "var(--theme-surface-canvas)"
      );
    });

    it("honors previewSchemeId when selecting the wrapper background", () => {
      const dracula = getSchemeById("dracula");
      expect(dracula).toBeDefined();
      useTerminalColorSchemeStore.getState().setPreviewSchemeId("dracula");

      expect(selectWrapperBackground(useTerminalColorSchemeStore.getState())).toBe(
        dracula!.colors.background
      );
    });

    it("falls back to the committed selection when previewSchemeId is cleared", () => {
      const store = useTerminalColorSchemeStore.getState();
      store.setSelectedSchemeId("dracula");
      store.setPreviewSchemeId("solarized-dark");

      const solarized = getSchemeById("solarized-dark");
      expect(selectWrapperBackground(useTerminalColorSchemeStore.getState())).toBe(
        solarized!.colors.background
      );

      useTerminalColorSchemeStore.getState().setPreviewSchemeId(null);
      const dracula = getSchemeById("dracula");
      expect(selectWrapperBackground(useTerminalColorSchemeStore.getState())).toBe(
        dracula!.colors.background
      );
    });

    it("falls back to the canvas variable when a custom scheme has no background", () => {
      const noBackground: TerminalColorScheme = {
        ...CUSTOM_SCHEME,
        id: "no-bg",
        colors: { ...CUSTOM_SCHEME.colors, background: undefined },
      };
      useTerminalColorSchemeStore.getState().addCustomScheme(noBackground);
      useTerminalColorSchemeStore.getState().setSelectedSchemeId("no-bg");

      expect(selectWrapperBackground(useTerminalColorSchemeStore.getState())).toBe(
        "var(--theme-surface-canvas)"
      );
    });
  });
});
