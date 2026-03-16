import { describe, it, expect, beforeEach } from "vitest";
import { useTerminalColorSchemeStore, selectWrapperBackground } from "../terminalColorSchemeStore";
import { useAppThemeStore } from "../appThemeStore";
import { DEFAULT_SCHEME_ID } from "@/config/terminalColorSchemes";
import type { TerminalColorScheme } from "@/config/terminalColorSchemes";

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
    const { selectedSchemeId } = useTerminalColorSchemeStore.getState();
    expect(selectedSchemeId).toBe(DEFAULT_SCHEME_ID);
  });

  it("switching scheme updates selectedSchemeId", () => {
    useTerminalColorSchemeStore.getState().setSelectedSchemeId("dracula");
    expect(useTerminalColorSchemeStore.getState().selectedSchemeId).toBe("dracula");
  });

  it("getEffectiveTheme returns daintree theme for default daintree", () => {
    const theme = useTerminalColorSchemeStore.getState().getEffectiveTheme();
    expect(theme.background).toBe("#19191a");
    expect(theme.cursor).toBe("#3F9366");
  });

  it("getEffectiveTheme returns fiordland theme for fiordland app theme", () => {
    useAppThemeStore.setState({ selectedSchemeId: "fiordland" });
    const theme = useTerminalColorSchemeStore.getState().getEffectiveTheme();
    expect(theme.background).toBe("#070D12");
    expect(theme.foreground).toBe("#B5C7D6");
  });

  it("getEffectiveTheme returns Highlands theme for highlands app theme", () => {
    useAppThemeStore.setState({ selectedSchemeId: "highlands" });
    const theme = useTerminalColorSchemeStore.getState().getEffectiveTheme();
    expect(theme.background).toBe("#1A1614");
    expect(theme.foreground).toBe("#C9D1D9");
  });

  it("getEffectiveTheme returns solarized-light for bondi app theme", () => {
    useAppThemeStore.setState({ selectedSchemeId: "bondi" });
    const theme = useTerminalColorSchemeStore.getState().getEffectiveTheme();
    expect(theme.background).toBe("#fdf6e3");
    expect(theme.foreground).toBe("#657b83");
  });

  it("getEffectiveTheme returns correct theme after switching to non-canopy scheme", () => {
    useTerminalColorSchemeStore.getState().setSelectedSchemeId("dracula");
    const theme = useTerminalColorSchemeStore.getState().getEffectiveTheme();
    expect(theme.background).toBe("#282a36");
    expect(theme.foreground).toBe("#f8f8f2");
  });

  it("explicit scheme is not affected by app theme change", () => {
    useTerminalColorSchemeStore.getState().setSelectedSchemeId("dracula");
    useAppThemeStore.setState({ selectedSchemeId: "bondi" });
    const theme = useTerminalColorSchemeStore.getState().getEffectiveTheme();
    expect(theme.background).toBe("#282a36");
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

  it("getEffectiveTheme returns custom scheme colors", () => {
    const store = useTerminalColorSchemeStore.getState();
    store.addCustomScheme(CUSTOM_SCHEME);
    store.setSelectedSchemeId("custom-test");
    const theme = useTerminalColorSchemeStore.getState().getEffectiveTheme();
    expect(theme.background).toBe("#111111");
    expect(theme.red).toBe("#ff0000");
  });

  it("getEffectiveTheme adds dark scrollbar defaults for dark schemes", () => {
    useTerminalColorSchemeStore.getState().setSelectedSchemeId("dracula");
    const theme = useTerminalColorSchemeStore.getState().getEffectiveTheme();
    expect(theme.scrollbarSliderBackground).toBe("rgba(255, 255, 255, 0.20)");
  });

  it("getEffectiveTheme adds light scrollbar defaults for light schemes", () => {
    useTerminalColorSchemeStore.getState().setSelectedSchemeId("solarized-light");
    const theme = useTerminalColorSchemeStore.getState().getEffectiveTheme();
    expect(theme.scrollbarSliderBackground).toBe("rgba(0, 0, 0, 0.20)");
  });

  it("getEffectiveTheme falls back to CSS for unmapped custom app theme", () => {
    useAppThemeStore.setState({ selectedSchemeId: "custom-unknown-theme" });
    const theme = useTerminalColorSchemeStore.getState().getEffectiveTheme();
    expect(theme).toBeDefined();
    expect(theme.background).toBeDefined();
  });

  it("getEffectiveTheme adds light scrollbar defaults for light mapped scheme", () => {
    useAppThemeStore.setState({ selectedSchemeId: "bondi" });
    const theme = useTerminalColorSchemeStore.getState().getEffectiveTheme();
    expect(theme.scrollbarSliderBackground).toBe("rgba(0, 0, 0, 0.20)");
  });

  describe("selectWrapperBackground", () => {
    it("returns mapped scheme background for default canopy scheme", () => {
      const bg = selectWrapperBackground(useTerminalColorSchemeStore.getState());
      expect(bg).toBe("#19191a");
    });

    it("returns mapped scheme background when app theme changes", () => {
      useAppThemeStore.setState({ selectedSchemeId: "fiordland" });
      const bg = selectWrapperBackground(useTerminalColorSchemeStore.getState());
      expect(bg).toBe("#282a36");
    });

    it("returns hex color for built-in non-default scheme", () => {
      useTerminalColorSchemeStore.getState().setSelectedSchemeId("dracula");
      const bg = selectWrapperBackground(useTerminalColorSchemeStore.getState());
      expect(bg).toBe("#282a36");
    });

    it("returns hex color for custom scheme", () => {
      useTerminalColorSchemeStore.getState().addCustomScheme(CUSTOM_SCHEME);
      useTerminalColorSchemeStore.getState().setSelectedSchemeId("custom-test");
      const bg = selectWrapperBackground(useTerminalColorSchemeStore.getState());
      expect(bg).toBe("#111111");
    });

    it("returns updated color when custom scheme is replaced", () => {
      const store = useTerminalColorSchemeStore.getState();
      store.addCustomScheme(CUSTOM_SCHEME);
      store.setSelectedSchemeId("custom-test");
      store.addCustomScheme({
        ...CUSTOM_SCHEME,
        colors: { ...CUSTOM_SCHEME.colors, background: "#222222" },
      });
      const bg = selectWrapperBackground(useTerminalColorSchemeStore.getState());
      expect(bg).toBe("#222222");
    });

    it("falls back to CSS variable for unmapped custom app theme", () => {
      useAppThemeStore.setState({ selectedSchemeId: "custom-unknown-theme" });
      const bg = selectWrapperBackground(useTerminalColorSchemeStore.getState());
      expect(bg).toBe("var(--theme-surface-canvas)");
    });

    it("falls back to CSS variable for unknown scheme id", () => {
      useTerminalColorSchemeStore.setState({ selectedSchemeId: "nonexistent" });
      const bg = selectWrapperBackground(useTerminalColorSchemeStore.getState());
      expect(bg).toBe("var(--theme-surface-canvas)");
    });

    it("falls back to CSS variable when custom scheme has no background", () => {
      const noBackground: TerminalColorScheme = {
        ...CUSTOM_SCHEME,
        id: "no-bg",
        colors: { ...CUSTOM_SCHEME.colors, background: undefined },
      };
      useTerminalColorSchemeStore.getState().addCustomScheme(noBackground);
      useTerminalColorSchemeStore.getState().setSelectedSchemeId("no-bg");
      const bg = selectWrapperBackground(useTerminalColorSchemeStore.getState());
      expect(bg).toBe("var(--theme-surface-canvas)");
    });
  });
});
