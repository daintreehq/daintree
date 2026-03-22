import { beforeEach, describe, expect, it } from "vitest";
import { getTerminalScrollbarDefaults } from "@shared/theme";
import { CANOPY_TERMINAL_THEME } from "@/utils/terminalTheme";
import {
  DEFAULT_SCHEME_ID,
  getMappedTerminalScheme,
  getSchemeById,
  type TerminalColorScheme,
} from "@/config/terminalColorSchemes";
import { useAppThemeStore } from "../appThemeStore";
import { selectWrapperBackground, useTerminalColorSchemeStore } from "../terminalColorSchemeStore";

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
    });
    useAppThemeStore.setState({
      selectedSchemeId: "daintree",
      customSchemes: [],
      colorVisionMode: "default",
    });
  });

  it("defaults to canopy scheme", () => {
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
    expect(useTerminalColorSchemeStore.getState().customSchemes[0].name).toBe("Updated");
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

  it("falls back to the default CSS-backed terminal theme for an unmapped app theme", () => {
    useAppThemeStore.setState({ selectedSchemeId: "custom-unknown-theme" });

    const theme = useTerminalColorSchemeStore.getState().getEffectiveTheme();

    expect(theme).toEqual(CANOPY_TERMINAL_THEME);
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
