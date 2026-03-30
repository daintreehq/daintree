// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@/clients/appThemeClient", () => ({
  appThemeClient: {
    setColorScheme: vi.fn().mockResolvedValue(undefined),
    setFollowSystem: vi.fn().mockResolvedValue(undefined),
    setCustomSchemes: vi.fn().mockResolvedValue(undefined),
    importTheme: vi.fn().mockResolvedValue({ ok: false, errors: ["Import cancelled"] }),
  },
}));

const storeState: Record<string, unknown> = {};

vi.mock("@/store/appThemeStore", () => ({
  useAppThemeStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(storeState),
    {
      getState: () => storeState,
    }
  ),
}));

vi.mock("@/config/appColorSchemes", () => {
  const mkTheme = (id: string, name: string, accent: string, type: string = "dark") => ({
    id,
    name,
    type,
    tokens: {
      "--canopy-accent": accent,
      "--canopy-success": "#0f0",
      "--canopy-warning": "#ff0",
      "--canopy-danger": "#f00",
      "--canopy-text": "#fff",
      "--canopy-border": "#333",
      "--canopy-panel": "#111",
      "--canopy-sidebar": "#222",
      "--canopy-bg": "#000",
    },
  });
  return {
    BUILT_IN_APP_SCHEMES: [
      mkTheme("midnight", "Midnight", "#f00"),
      mkTheme("ocean", "Ocean Blue", "#00f"),
      mkTheme("forest", "Forest", "#0a0"),
      mkTheme("sunrise", "Sunrise", "#ff0", "light"),
    ],
  };
});

vi.mock("@shared/theme", () => ({
  APP_THEME_PREVIEW_KEYS: {
    accent: "--canopy-accent",
    success: "--canopy-success",
    warning: "--canopy-warning",
    danger: "--canopy-danger",
    text: "--canopy-text",
    border: "--canopy-border",
    panel: "--canopy-panel",
    sidebar: "--canopy-sidebar",
    background: "--canopy-bg",
  },
  getAppThemeWarnings: () => [],
}));

vi.mock("@/hooks/useEscapeStack", () => ({
  useEscapeStack: vi.fn(),
}));

import { AppThemePicker } from "../AppThemePicker";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

function openDropdown() {
  // Before the dropdown is open, only the trigger button has role="combobox"
  const trigger = screen.getByRole("combobox");
  fireEvent.click(trigger);
}

describe("AppThemePicker search filter", () => {
  beforeEach(() => {
    Object.assign(storeState, {
      selectedSchemeId: "midnight",
      customSchemes: [],
      followSystem: false,
      preferredDarkSchemeId: "midnight",
      preferredLightSchemeId: "sunrise",
      setSelectedSchemeId: vi.fn(),
      setFollowSystem: vi.fn(),
      setPreferredDarkSchemeId: vi.fn(),
      setPreferredLightSchemeId: vi.fn(),
      addCustomScheme: vi.fn(),
    });
  });

  it("renders a search input when dropdown is open", () => {
    render(<AppThemePicker />);
    openDropdown();
    expect(screen.getByPlaceholderText("Filter themes…")).toBeTruthy();
  });

  it("filters themes by name when typing", () => {
    render(<AppThemePicker />);
    openDropdown();
    const input = screen.getByPlaceholderText("Filter themes…");
    fireEvent.change(input, { target: { value: "ocean" } });

    expect(screen.getByText("Ocean Blue")).toBeTruthy();
    expect(screen.queryByText("Forest")).toBeNull();
    expect(screen.queryByText("Sunrise")).toBeNull();
  });

  it("shows empty state when no themes match", () => {
    render(<AppThemePicker />);
    openDropdown();
    const input = screen.getByPlaceholderText("Filter themes…");
    fireEvent.change(input, { target: { value: "nonexistent" } });

    expect(screen.getByText(/No themes match/)).toBeTruthy();
  });

  it("hides section headers when all items in that section are filtered out", () => {
    render(<AppThemePicker />);
    openDropdown();
    const input = screen.getByPlaceholderText("Filter themes…");

    // Filter to only the light theme
    fireEvent.change(input, { target: { value: "sunrise" } });
    expect(screen.queryByText("Dark")).toBeNull();
    expect(screen.getByText("Light")).toBeTruthy();
  });

  it("is case-insensitive", () => {
    render(<AppThemePicker />);
    openDropdown();
    const input = screen.getByPlaceholderText("Filter themes…");
    fireEvent.change(input, { target: { value: "OCEAN" } });

    expect(screen.getByText("Ocean Blue")).toBeTruthy();
  });
});
