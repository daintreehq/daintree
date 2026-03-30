// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@/clients/terminalConfigClient", () => ({
  terminalConfigClient: {
    setColorScheme: vi.fn().mockResolvedValue(undefined),
    setCustomSchemes: vi.fn().mockResolvedValue(undefined),
    importColorScheme: vi.fn().mockResolvedValue({ ok: false }),
  },
}));

const terminalStoreState: Record<string, unknown> = {};

vi.mock("@/store/terminalColorSchemeStore", () => ({
  useTerminalColorSchemeStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(terminalStoreState),
    {
      getState: () => terminalStoreState,
    }
  ),
}));

const appStoreState: Record<string, unknown> = {};

vi.mock("@/store/appThemeStore", () => ({
  useAppThemeStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(appStoreState),
    {
      getState: () => appStoreState,
    }
  ),
}));

vi.mock("@/config/terminalColorSchemes", () => {
  const mkScheme = (id: string, name: string) => ({
    id,
    name,
    type: "dark",
    builtin: true,
    colors: {
      background: "#000",
      foreground: "#fff",
      black: "#000",
      red: "#f00",
      green: "#0f0",
      yellow: "#ff0",
      blue: "#00f",
      magenta: "#f0f",
      cyan: "#0ff",
      white: "#fff",
      brightBlack: "#888",
      brightRed: "#f88",
      brightGreen: "#8f8",
      brightYellow: "#ff8",
      brightBlue: "#88f",
      brightMagenta: "#f8f",
      brightCyan: "#8ff",
      brightWhite: "#fff",
    },
  });
  return {
    BUILT_IN_SCHEMES: [
      mkScheme("dracula", "Dracula"),
      mkScheme("monokai", "Monokai"),
      mkScheme("solarized", "Solarized Dark"),
      mkScheme("nord", "Nord"),
    ],
    DEFAULT_SCHEME_ID: "dracula",
    getMappedTerminalScheme: () => null,
  };
});

import { ColorSchemePicker } from "../ColorSchemePicker";

describe("ColorSchemePicker search filter", () => {
  beforeEach(() => {
    Object.assign(terminalStoreState, {
      selectedSchemeId: "dracula",
      customSchemes: [],
      setSelectedSchemeId: vi.fn(),
      addCustomScheme: vi.fn(),
    });
    Object.assign(appStoreState, {
      selectedSchemeId: "some-app-theme",
    });
  });

  it("renders a search input", () => {
    render(<ColorSchemePicker />);
    expect(screen.getByPlaceholderText("Filter schemes…")).toBeTruthy();
  });

  it("filters schemes by name when typing", () => {
    render(<ColorSchemePicker />);
    const input = screen.getByPlaceholderText("Filter schemes…");
    fireEvent.change(input, { target: { value: "mono" } });

    expect(screen.getByText("Monokai")).toBeTruthy();
    expect(screen.queryByText("Dracula")).toBeNull();
    expect(screen.queryByText("Nord")).toBeNull();
  });

  it("shows empty state when no schemes match", () => {
    render(<ColorSchemePicker />);
    const input = screen.getByPlaceholderText("Filter schemes…");
    fireEvent.change(input, { target: { value: "nonexistent" } });

    expect(screen.getByText(/No schemes match/)).toBeTruthy();
  });

  it("is case-insensitive", () => {
    render(<ColorSchemePicker />);
    const input = screen.getByPlaceholderText("Filter schemes…");
    fireEvent.change(input, { target: { value: "SOLAR" } });

    expect(screen.getByText("Solarized Dark")).toBeTruthy();
    expect(screen.queryByText("Dracula")).toBeNull();
  });

  it("shows all schemes when search is cleared", () => {
    render(<ColorSchemePicker />);
    const input = screen.getByPlaceholderText("Filter schemes…");

    fireEvent.change(input, { target: { value: "mono" } });
    expect(screen.queryByText("Dracula")).toBeNull();

    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByText("Dracula")).toBeTruthy();
    expect(screen.getByText("Monokai")).toBeTruthy();
    expect(screen.getByText("Nord")).toBeTruthy();
  });
});
