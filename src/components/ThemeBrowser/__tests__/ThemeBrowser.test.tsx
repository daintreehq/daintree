// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BUILT_IN_APP_SCHEMES, DEFAULT_APP_SCHEME_ID } from "@/config/appColorSchemes";
import { useAppThemeStore } from "@/store/appThemeStore";
import { useThemeBrowserStore } from "@/store/themeBrowserStore";
import { useUIStore } from "@/store/uiStore";
import { usePortalStore } from "@/store/portalStore";
import { _resetForTests } from "@/lib/escapeStack";
import { useGlobalEscapeDispatcher } from "@/hooks/useGlobalEscapeDispatcher";

vi.mock("@/clients/appThemeClient", () => ({
  appThemeClient: {
    setColorScheme: vi.fn().mockResolvedValue(undefined),
    setFollowSystem: vi.fn().mockResolvedValue(undefined),
    setRecentSchemeIds: vi.fn().mockResolvedValue(undefined),
  },
}));

import { ThemeBrowser } from "../ThemeBrowser";

function Harness() {
  useGlobalEscapeDispatcher();
  return <ThemeBrowser />;
}

function otherDarkScheme() {
  return BUILT_IN_APP_SCHEMES.find((s) => s.type !== "light" && s.id !== DEFAULT_APP_SCHEME_ID)!;
}

function findRowByName(name: string) {
  return screen
    .getAllByRole("option")
    .find((o) => o.textContent?.toLowerCase().includes(name.toLowerCase()))!;
}

describe("ThemeBrowser", () => {
  beforeEach(() => {
    _resetForTests();
    useAppThemeStore.setState({
      selectedSchemeId: DEFAULT_APP_SCHEME_ID,
      customSchemes: [],
      colorVisionMode: "default",
      followSystem: false,
      preferredDarkSchemeId: "daintree",
      preferredLightSchemeId: "bondi",
      recentSchemeIds: [],
      accentColorOverride: null,
      previewSchemeId: null,
    });
    useThemeBrowserStore.setState({ isOpen: true });
    useUIStore.setState({ overlayClaims: new Set<string>() });
    usePortalStore.setState({ isOpen: false });
  });

  afterEach(() => {
    cleanup();
    _resetForTests();
    useAppThemeStore.setState({ previewSchemeId: null });
    useThemeBrowserStore.setState({ isOpen: false });
    useUIStore.setState({ overlayClaims: new Set<string>() });
  });

  it("clicking a theme row sets previewSchemeId instantly (no debounce)", () => {
    const target = otherDarkScheme();
    render(<Harness />);

    fireEvent.click(findRowByName(target.name));

    expect(useAppThemeStore.getState().previewSchemeId).toBe(target.id);
    expect(useAppThemeStore.getState().selectedSchemeId).toBe(DEFAULT_APP_SCHEME_ID);
  });

  it("'Set theme' commits the previewed theme and clears preview before view transition", () => {
    const target = otherDarkScheme();
    const callbackObservations: Array<string | null> = [];
    const startViewTransition = vi.fn((cb: () => void) => {
      callbackObservations.push(useAppThemeStore.getState().previewSchemeId);
      cb();
      return { ready: Promise.resolve(), finished: Promise.resolve() };
    });
    (
      document as unknown as { startViewTransition?: typeof startViewTransition }
    ).startViewTransition = startViewTransition;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    render(<Harness />);
    fireEvent.click(findRowByName(target.name));
    expect(useAppThemeStore.getState().previewSchemeId).toBe(target.id);

    fireEvent.click(screen.getByRole("button", { name: "Set theme" }));

    expect(useAppThemeStore.getState().selectedSchemeId).toBe(target.id);
    expect(useAppThemeStore.getState().previewSchemeId).toBeNull();
    expect(callbackObservations).toEqual([null]);
    expect(useThemeBrowserStore.getState().isOpen).toBe(false);

    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
  });

  it("'Cancel' reverts the active preview and closes the browser", () => {
    const target = otherDarkScheme();
    render(<Harness />);

    fireEvent.click(findRowByName(target.name));
    expect(useAppThemeStore.getState().previewSchemeId).toBe(target.id);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(useAppThemeStore.getState().previewSchemeId).toBeNull();
    expect(useAppThemeStore.getState().selectedSchemeId).toBe(DEFAULT_APP_SCHEME_ID);
    expect(useThemeBrowserStore.getState().isOpen).toBe(false);
  });

  it("Escape reverts preview and closes the browser", () => {
    const target = otherDarkScheme();
    render(<Harness />);

    fireEvent.click(findRowByName(target.name));
    expect(useAppThemeStore.getState().previewSchemeId).toBe(target.id);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(useAppThemeStore.getState().previewSchemeId).toBeNull();
    expect(useAppThemeStore.getState().selectedSchemeId).toBe(DEFAULT_APP_SCHEME_ID);
    expect(useThemeBrowserStore.getState().isOpen).toBe(false);
  });

  it("aria-live announces the previewed theme", () => {
    const target = otherDarkScheme();
    const { container } = render(<Harness />);

    fireEvent.click(findRowByName(target.name));

    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe(`Previewing: ${target.name}`);
  });

  it("ArrowDown on the list previews the specific next theme row", () => {
    render(<Harness />);

    const darkSchemes = BUILT_IN_APP_SCHEMES.filter((s) => s.type !== "light");
    const initialIndex = darkSchemes.findIndex((s) => s.id === DEFAULT_APP_SCHEME_ID);
    const expectedNext = darkSchemes[initialIndex + 1];

    const list = screen.getByRole("listbox", { name: "Theme list" });
    fireEvent.keyDown(list, { key: "ArrowDown" });

    expect(useAppThemeStore.getState().previewSchemeId).toBe(expectedNext?.id);
  });

  it("switching the type filter reverts an active preview", () => {
    const target = otherDarkScheme();
    render(<Harness />);

    fireEvent.click(findRowByName(target.name));
    expect(useAppThemeStore.getState().previewSchemeId).toBe(target.id);

    fireEvent.click(screen.getByRole("button", { name: "Light" }));

    expect(useAppThemeStore.getState().previewSchemeId).toBeNull();
  });

  it("unmounting while previewing reverts the DOM to the committed scheme", () => {
    const target = otherDarkScheme();
    const { unmount } = render(<Harness />);

    fireEvent.click(findRowByName(target.name));
    expect(useAppThemeStore.getState().previewSchemeId).toBe(target.id);

    unmount();

    expect(useAppThemeStore.getState().previewSchemeId).toBeNull();
  });

  it("search input filters themes by name", () => {
    const target = otherDarkScheme();
    render(<Harness />);

    const searchInput = screen.getByLabelText("Filter themes") as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: target.name } });

    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(option.textContent?.toLowerCase()).toContain(target.name.toLowerCase());
    }
  });

  it("registers a 'theme-browser' overlay claim while mounted", () => {
    render(<Harness />);
    expect(useUIStore.getState().overlayClaims.has("theme-browser")).toBe(true);
  });

  it("releases the 'theme-browser' overlay claim on unmount", () => {
    const { unmount } = render(<Harness />);
    expect(useUIStore.getState().overlayClaims.has("theme-browser")).toBe(true);

    unmount();

    expect(useUIStore.getState().overlayClaims.has("theme-browser")).toBe(false);
  });

  it("portal toggle is a no-op while the browser is mounted", () => {
    render(<Harness />);
    expect(usePortalStore.getState().isOpen).toBe(false);

    usePortalStore.getState().toggle();

    expect(usePortalStore.getState().isOpen).toBe(false);
  });
});
