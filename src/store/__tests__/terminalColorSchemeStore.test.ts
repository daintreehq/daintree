import { describe, it, expect, beforeEach } from "vitest";
import { useTerminalColorSchemeStore } from "../terminalColorSchemeStore";
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
  });

  it("defaults to canopy scheme", () => {
    const { selectedSchemeId } = useTerminalColorSchemeStore.getState();
    expect(selectedSchemeId).toBe(DEFAULT_SCHEME_ID);
  });

  it("switching scheme updates selectedSchemeId", () => {
    useTerminalColorSchemeStore.getState().setSelectedSchemeId("dracula");
    expect(useTerminalColorSchemeStore.getState().selectedSchemeId).toBe("dracula");
  });

  it("getEffectiveTheme returns canopy theme for default", () => {
    const theme = useTerminalColorSchemeStore.getState().getEffectiveTheme();
    expect(theme.background).toBe("#19191a");
    expect(theme.cursor).toBe("#3F9366");
    expect(theme.selectionBackground).toBe("#1a2c22");
    expect(theme.green).toBe("#10b981");
  });

  it("getEffectiveTheme returns correct theme after switching", () => {
    useTerminalColorSchemeStore.getState().setSelectedSchemeId("dracula");
    const theme = useTerminalColorSchemeStore.getState().getEffectiveTheme();
    expect(theme.background).toBe("#282a36");
    expect(theme.foreground).toBe("#f8f8f2");
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

  it("getEffectiveTheme adds scrollbar defaults for non-canopy schemes", () => {
    useTerminalColorSchemeStore.getState().setSelectedSchemeId("dracula");
    const theme = useTerminalColorSchemeStore.getState().getEffectiveTheme();
    expect(theme.scrollbarSliderBackground).toBe("rgba(82, 82, 91, 0.4)");
  });
});
