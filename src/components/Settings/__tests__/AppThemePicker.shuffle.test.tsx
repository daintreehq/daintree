// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@/clients/appThemeClient", () => ({
  appThemeClient: {
    setColorScheme: vi.fn().mockResolvedValue(undefined),
    setFollowSystem: vi.fn().mockResolvedValue(undefined),
    setCustomSchemes: vi.fn().mockResolvedValue(undefined),
    setRecentSchemeIds: vi.fn().mockResolvedValue(undefined),
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
  injectSchemeToDOM: vi.fn(),
}));

vi.mock("@shared/theme", () => ({
  APP_THEME_PREVIEW_KEYS: {
    accent: "--daintree-accent",
    success: "--daintree-success",
    warning: "--daintree-warning",
    danger: "--daintree-danger",
    text: "--daintree-text",
    border: "--daintree-border",
    panel: "--daintree-panel",
    sidebar: "--daintree-sidebar",
    background: "--daintree-bg",
  },
  getAppThemeWarnings: () => [],
  applyAccentOverrideToScheme: (scheme: unknown) => scheme,
  resolveAppTheme: (id: string, customSchemes: { id: string }[]) => {
    const map: Record<string, { id: string; name: string; type: string; tokens: object }> = {
      "theme-a": { id: "theme-a", name: "Theme A", type: "dark", tokens: {} },
      "theme-b": { id: "theme-b", name: "Theme B", type: "dark", tokens: {} },
      "theme-c": { id: "theme-c", name: "Theme C", type: "dark", tokens: {} },
    };
    return map[id] ?? customSchemes.find((s) => s.id === id);
  },
}));

vi.mock("@/config/appColorSchemes", () => {
  const mkTheme = (id: string, name: string, accent: string) => ({
    id,
    name,
    type: "dark" as const,
    tokens: {
      "--daintree-accent": accent,
      "--daintree-success": "#0f0",
      "--daintree-warning": "#ff0",
      "--daintree-danger": "#f00",
      "--daintree-text": "#fff",
      "--daintree-border": "#333",
      "--daintree-panel": "#111",
      "--daintree-sidebar": "#222",
      "--daintree-bg": "#000",
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

vi.mock("@/hooks/useEscapeStack", () => ({
  useEscapeStack: vi.fn(),
}));

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: vi.fn(() => ({ isVisible: false, shouldRender: false })),
}));

vi.mock("@/hooks", () => ({
  useOverlayState: vi.fn(),
  useEscapeStack: vi.fn(),
}));

vi.mock("@/store", () => ({
  usePortalStore: vi.fn(() => ({ isOpen: false, width: 0 })),
}));

import { AppThemePicker } from "../AppThemePicker";

describe("AppThemePicker shuffle button", () => {
  beforeEach(() => {
    Object.assign(storeState, {
      selectedSchemeId: "theme-a",
      customSchemes: [],
      recentSchemeIds: [],
      followSystem: false,
      preferredDarkSchemeId: "theme-a",
      preferredLightSchemeId: "theme-a",
      setSelectedSchemeId: vi.fn(),
      commitSchemeSelection: vi.fn(),
      setSelectedSchemeIdSilent: vi.fn(),
      injectTheme: vi.fn(),
      setFollowSystem: vi.fn(),
      setPreferredDarkSchemeId: vi.fn(),
      setPreferredLightSchemeId: vi.fn(),
      setRecentSchemeIds: vi.fn(),
      addCustomScheme: vi.fn(),
      accentColorOverride: null,
      setAccentColorOverride: vi.fn(),
    });
  });

  it("renders the shuffle button when multiple themes are available", () => {
    render(<AppThemePicker />);
    expect(screen.getByText("Random theme")).toBeTruthy();
  });

  it("calls commitSchemeSelection with a different theme on shuffle click", () => {
    const commitSchemeSelection = vi.fn();
    storeState.commitSchemeSelection = commitSchemeSelection;

    render(<AppThemePicker />);
    const shuffleBtn = screen.getByText("Random theme");
    fireEvent.click(shuffleBtn);

    expect(commitSchemeSelection).toHaveBeenCalledTimes(1);
    const selectedId = commitSchemeSelection.mock.calls[0][0];
    expect(selectedId).not.toBe("theme-a");
    expect(["theme-b", "theme-c"]).toContain(selectedId);
  });

  it("invokes document.startViewTransition when shuffling with motion enabled", () => {
    const startViewTransition = vi.fn((cb: () => void) => {
      cb();
      return { ready: Promise.resolve(), finished: Promise.resolve() };
    });
    (
      document as unknown as { startViewTransition: typeof startViewTransition }
    ).startViewTransition = startViewTransition;

    // Force motion allowed + visible
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    render(<AppThemePicker />);
    fireEvent.click(screen.getByText("Random theme"));

    expect(startViewTransition).toHaveBeenCalledTimes(1);

    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
  });

  it("cycles through all other themes before reshuffling", () => {
    const commitSchemeSelection = vi.fn();
    storeState.commitSchemeSelection = commitSchemeSelection;

    render(<AppThemePicker />);
    const shuffleBtn = screen.getByText("Random theme");

    // With 3 schemes and current being "theme-a", the queue has 2 items
    fireEvent.click(shuffleBtn);
    fireEvent.click(shuffleBtn);

    expect(commitSchemeSelection).toHaveBeenCalledTimes(2);
    const ids = commitSchemeSelection.mock.calls.map((call: unknown[]) => call[0] as string);
    // Both should be from the other themes
    expect(ids.every((id) => id !== "theme-a")).toBe(true);
    // Both IDs in the first cycle should be unique (both b and c)
    expect(new Set(ids).size).toBe(2);
  });
});
