// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
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
  const mkTheme = (id: string, name: string, accent: string) => ({
    id,
    name,
    type: "dark" as const,
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
      mkTheme("theme-a", "Theme A", "#f00"),
      mkTheme("theme-b", "Theme B", "#00f"),
      mkTheme("theme-c", "Theme C", "#0ff"),
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

describe("AppThemePicker shuffle button", () => {
  beforeEach(() => {
    Object.assign(storeState, {
      selectedSchemeId: "theme-a",
      customSchemes: [],
      followSystem: false,
      preferredDarkSchemeId: "theme-a",
      preferredLightSchemeId: "theme-a",
      setSelectedSchemeId: vi.fn(),
      setFollowSystem: vi.fn(),
      setPreferredDarkSchemeId: vi.fn(),
      setPreferredLightSchemeId: vi.fn(),
      addCustomScheme: vi.fn(),
    });
  });

  it("renders the shuffle button when multiple themes are available", () => {
    render(<AppThemePicker />);
    expect(screen.getByLabelText("Pick random theme")).toBeTruthy();
  });

  it("calls setSelectedSchemeId with a different theme on shuffle click", () => {
    const setSelectedSchemeId = vi.fn();
    storeState.setSelectedSchemeId = setSelectedSchemeId;

    render(<AppThemePicker />);
    const shuffleBtn = screen.getByLabelText("Pick random theme");
    fireEvent.click(shuffleBtn);

    expect(setSelectedSchemeId).toHaveBeenCalledTimes(1);
    const selectedId = setSelectedSchemeId.mock.calls[0][0];
    expect(selectedId).not.toBe("theme-a");
    expect(["theme-b", "theme-c"]).toContain(selectedId);
  });

  it("cycles through all other themes before reshuffling", () => {
    const setSelectedSchemeId = vi.fn();
    storeState.setSelectedSchemeId = setSelectedSchemeId;

    render(<AppThemePicker />);
    const shuffleBtn = screen.getByLabelText("Pick random theme");

    // With 3 schemes and current being "theme-a", the queue has 2 items
    fireEvent.click(shuffleBtn);
    fireEvent.click(shuffleBtn);

    expect(setSelectedSchemeId).toHaveBeenCalledTimes(2);
    const ids = setSelectedSchemeId.mock.calls.map((call: unknown[]) => call[0] as string);
    // Both should be from the other themes
    expect(ids.every((id) => id !== "theme-a")).toBe(true);
    // Both IDs in the first cycle should be unique (both b and c)
    expect(new Set(ids).size).toBe(2);
  });
});
