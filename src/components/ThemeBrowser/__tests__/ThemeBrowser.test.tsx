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

function darkSchemeAt(index: number) {
  return BUILT_IN_APP_SCHEMES.filter((s) => s.type !== "light")[index];
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
    useUIStore.setState({ overlayStack: [] });
    usePortalStore.setState({ isOpen: false });
  });

  afterEach(() => {
    cleanup();
    _resetForTests();
    useAppThemeStore.setState({ previewSchemeId: null });
    useThemeBrowserStore.setState({ isOpen: false });
    useUIStore.setState({ overlayStack: [] });
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
    expect(useUIStore.getState().overlayStack.includes("theme-browser")).toBe(true);
  });

  it("releases the 'theme-browser' overlay claim on unmount", () => {
    const { unmount } = render(<Harness />);
    expect(useUIStore.getState().overlayStack.includes("theme-browser")).toBe(true);

    unmount();

    expect(useUIStore.getState().overlayStack.includes("theme-browser")).toBe(false);
  });

  it("renders with aria-modal='true' for native focus management", () => {
    render(<Harness />);
    expect(screen.getByRole("dialog").getAttribute("aria-modal")).toBe("true");
  });

  it("co-locates the shared announcer inside the aria-modal subtree", () => {
    // VoiceOver drops store-routed aria-live mutations that fire outside an
    // open aria-modal subtree (Chromium bug 354736464). The theme-preview
    // region is polite-only, so assert the assertive region — unique to the
    // shared <AccessibilityAnnouncer/> — to prove it is co-located here.
    render(<Harness />);
    const modal = screen.getByRole("dialog");
    expect(modal.getAttribute("aria-modal")).toBe("true");
    expect(modal.querySelector('[aria-live="assertive"]')).not.toBeNull();
  });

  it("portal toggle is a no-op while the browser is mounted", () => {
    render(<Harness />);
    expect(usePortalStore.getState().isOpen).toBe(false);

    usePortalStore.getState().toggle();

    expect(usePortalStore.getState().isOpen).toBe(false);
  });

  it("PaletteStrip color swatches are hidden from screen readers", () => {
    render(<Harness />);

    // PaletteStrip is used in ThemeRow buttons (the list) and in the hero
    // fallback. Every PaletteStrip container should carry aria-hidden="true"
    // so screen readers skip the eight decorative color swatches.
    const paletteStrips = document.querySelectorAll('[aria-hidden="true"]');
    // At least one PaletteStrip in each ThemeRow plus the hero fallback.
    // With default dark schemes (including Daintree which has a heroImage),
    // we only see them in the list rows. The minimum bound is len(darkSchemes).
    const darkCount = BUILT_IN_APP_SCHEMES.filter((s) => s.type !== "light").length;
    expect(paletteStrips.length).toBeGreaterThanOrEqual(darkCount);
  });

  describe("live region debounce", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("ArrowDown debounces live-region announcement by 300ms", () => {
      const { container } = render(<Harness />);
      const live = container.querySelector('[aria-live="polite"]')!;

      const list = screen.getByRole("listbox", { name: "Theme list" });
      fireEvent.keyDown(list, { key: "ArrowDown" });

      // Not announced immediately
      expect(live.textContent).toBe("");

      // Not announced before the debounce window
      act(() => {
        vi.advanceTimersByTime(299);
      });
      expect(live.textContent).toBe("");

      // Announced after 300ms
      act(() => {
        vi.advanceTimersByTime(1);
      });
      const darkSchemes = BUILT_IN_APP_SCHEMES.filter((s) => s.type !== "light");
      const initialIndex = darkSchemes.findIndex((s) => s.id === DEFAULT_APP_SCHEME_ID);
      const expectedNext = darkSchemes[initialIndex + 1];
      expect(live.textContent).toBe(`Previewing: ${expectedNext?.name}`);
    });

    it("rapid ArrowDown only announces the final settled theme", () => {
      const { container } = render(<Harness />);
      const live = container.querySelector('[aria-live="polite"]')!;

      const darkSchemes = BUILT_IN_APP_SCHEMES.filter((s) => s.type !== "light");
      const initialIndex = darkSchemes.findIndex((s) => s.id === DEFAULT_APP_SCHEME_ID);
      const expectedFinal = darkSchemes[initialIndex + 2];

      const list = screen.getByRole("listbox", { name: "Theme list" });
      fireEvent.keyDown(list, { key: "ArrowDown" });
      fireEvent.keyDown(list, { key: "ArrowDown" });

      // Not yet announced
      expect(live.textContent).toBe("");

      act(() => {
        vi.advanceTimersByTime(300);
      });

      // Only the final theme is announced
      expect(live.textContent).toBe(`Previewing: ${expectedFinal?.name}`);
    });

    it("commit before debounce fires clears the pending announcement", () => {
      const { container } = render(<Harness />);
      const live = container.querySelector('[aria-live="polite"]')!;

      const list = screen.getByRole("listbox", { name: "Theme list" });
      fireEvent.keyDown(list, { key: "ArrowDown" });

      // Click Set theme before the debounce fires
      fireEvent.click(screen.getByRole("button", { name: "Set theme" }));

      // Live region should be empty
      expect(live.textContent).toBe("");

      // Advancing timers should not produce a stale announcement
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(live.textContent).toBe("");
    });

    it("click during pending keyboard debounce announces immediately", () => {
      const { container } = render(<Harness />);
      const live = container.querySelector('[aria-live="polite"]')!;

      // ArrowDown from default selects darkSchemes[1]; click darkSchemes[2]
      // so the assertion actually catches a stale keyboard overwrite.
      const keyboardTarget = darkSchemeAt(1);
      const clickTarget = darkSchemeAt(2);

      const list = screen.getByRole("listbox", { name: "Theme list" });
      fireEvent.keyDown(list, { key: "ArrowDown" });
      expect(live.textContent).toBe("");
      expect(useAppThemeStore.getState().previewSchemeId).toBe(keyboardTarget?.id);

      // Click a different row before the debounce fires
      fireEvent.click(findRowByName(clickTarget!.name));

      expect(live.textContent).toBe(`Previewing: ${clickTarget!.name}`);

      // Pending keyboard debounce should not overwrite the click announcement
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(live.textContent).toBe(`Previewing: ${clickTarget!.name}`);
    });

    it("boundary-clamped ArrowDown produces no redundant announcement", () => {
      const { container } = render(<Harness />);
      const live = container.querySelector('[aria-live="polite"]')!;

      const darkSchemes = BUILT_IN_APP_SCHEMES.filter((s) => s.type !== "light");
      const lastIndex = darkSchemes.length - 1;

      const list = screen.getByRole("listbox", { name: "Theme list" });

      // Navigate to the last row
      for (let i = 0; i < lastIndex; i++) {
        fireEvent.keyDown(list, { key: "ArrowDown" });
      }

      // Let the final navigation announcement settle
      act(() => {
        vi.advanceTimersByTime(300);
      });
      const settledText = live.textContent;

      // Boundary press — ArrowDown when already at last row
      fireEvent.keyDown(list, { key: "ArrowDown" });
      act(() => {
        vi.advanceTimersByTime(300);
      });

      // No redundant re-announcement of the same theme
      expect(live.textContent).toBe(settledText);
    });

    it("Cancel before debounce fires clears the pending announcement", () => {
      const { container } = render(<Harness />);
      const live = container.querySelector('[aria-live="polite"]')!;

      const list = screen.getByRole("listbox", { name: "Theme list" });
      fireEvent.keyDown(list, { key: "ArrowDown" });

      // Press Cancel before the debounce fires
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(live.textContent).toBe("");

      // Advancing timers should not produce a stale announcement
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(live.textContent).toBe("");
    });
  });

  describe("autofocus", () => {
    let rafHandle: number;
    let rafCallback: FrameRequestCallback | null;

    beforeEach(() => {
      rafHandle = 1;
      rafCallback = null;
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
        rafCallback = cb;
        return rafHandle;
      });
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const flushRaf = () => {
      const cb = rafCallback;
      rafCallback = null;
      if (cb) cb(0);
    };

    it("auto-focuses the search input on mount after RAF", () => {
      render(<Harness />);

      const searchInput = screen.getByLabelText("Filter themes") as HTMLInputElement;
      expect(document.activeElement).not.toBe(searchInput);

      flushRaf();

      expect(document.activeElement).toBe(searchInput);
    });

    it("cancels the RAF on unmount so a detached input is never focused", () => {
      const { unmount } = render(<Harness />);

      unmount();

      expect(cancelAnimationFrame).toHaveBeenCalledWith(rafHandle);
    });
  });

  it("clicking the already-previewed row does not re-trigger preview injection or announcement", () => {
    const target = otherDarkScheme();
    const { container } = render(<Harness />);

    fireEvent.click(findRowByName(target.name));
    expect(useAppThemeStore.getState().previewSchemeId).toBe(target.id);

    const live = container.querySelector('[aria-live="polite"]');
    const firstAnnouncement = live?.textContent;

    // Click the same row again — should be a no-op
    fireEvent.click(findRowByName(target.name));
    expect(useAppThemeStore.getState().previewSchemeId).toBe(target.id);
    expect(live?.textContent).toBe(firstAnnouncement);
  });

  it("clicking the committed row when no preview is active does not re-inject or announce", () => {
    const { container } = render(<Harness />);

    // No preview is active; the committed scheme is already shown.
    expect(useAppThemeStore.getState().previewSchemeId).toBeNull();

    const committedName = BUILT_IN_APP_SCHEMES.find((s) => s.id === DEFAULT_APP_SCHEME_ID)?.name;
    const committedRow = findRowByName(committedName!);

    const live = container.querySelector('[aria-live="polite"]');
    const beforeText = live?.textContent;

    fireEvent.click(committedRow);

    // previewSchemeId should remain null — no preview was set because the
    // scheme is already active.
    expect(useAppThemeStore.getState().previewSchemeId).toBeNull();
    // Live region should not have changed.
    expect(live?.textContent).toBe(beforeText);
  });

  it("ArrowDown on the search input previews the next theme without a prior click into the panel", () => {
    render(<Harness />);

    const searchInput = screen.getByLabelText("Filter themes") as HTMLInputElement;

    const darkSchemes = BUILT_IN_APP_SCHEMES.filter((s) => s.type !== "light");
    const initialIndex = darkSchemes.findIndex((s) => s.id === DEFAULT_APP_SCHEME_ID);
    const expectedNext = darkSchemes[initialIndex + 1];

    fireEvent.keyDown(searchInput, { key: "ArrowDown" });

    expect(useAppThemeStore.getState().previewSchemeId).toBe(expectedNext?.id);
  });

  it("ArrowDown then ArrowUp on the search input restores preview to the original scheme", () => {
    render(<Harness />);

    const searchInput = screen.getByLabelText("Filter themes") as HTMLInputElement;

    fireEvent.keyDown(searchInput, { key: "ArrowDown" });

    const afterDown = useAppThemeStore.getState().previewSchemeId;
    expect(afterDown).not.toBeNull();

    fireEvent.keyDown(searchInput, { key: "ArrowUp" });

    const afterUp = useAppThemeStore.getState().previewSchemeId;
    expect(afterUp).toBe(DEFAULT_APP_SCHEME_ID);
  });

  describe("Page navigation", () => {
    it("PageDown advances by the computed page size and previews the new row", () => {
      render(<Harness />);

      const darkSchemes = BUILT_IN_APP_SCHEMES.filter((s) => s.type !== "light");
      const initialIndex = darkSchemes.findIndex((s) => s.id === DEFAULT_APP_SCHEME_ID);
      // jsdom returns 0 for clientHeight / getBoundingClientRect, so
      // computeListPageSize falls back to PAGE_SIZE_FALLBACK (10).
      const expected = darkSchemes[Math.min(initialIndex + 10, darkSchemes.length - 1)];

      const list = screen.getByRole("listbox", { name: "Theme list" });
      fireEvent.keyDown(list, { key: "PageDown" });

      expect(useAppThemeStore.getState().previewSchemeId).toBe(expected?.id);
    });

    it("PageUp at index 0 stays at index 0 (clamped, no preview change)", () => {
      render(<Harness />);

      const list = screen.getByRole("listbox", { name: "Theme list" });
      // We start at the committed scheme (index 0 of darkSchemes by default).
      // PageUp should not move beyond the first row.
      fireEvent.keyDown(list, { key: "PageUp" });

      // No preview was set because we're already at the first index.
      expect(useAppThemeStore.getState().previewSchemeId).toBeNull();
    });

    it("PageDown then PageUp returns preview to the original committed scheme", () => {
      render(<Harness />);

      const list = screen.getByRole("listbox", { name: "Theme list" });
      fireEvent.keyDown(list, { key: "PageDown" });
      expect(useAppThemeStore.getState().previewSchemeId).not.toBeNull();

      fireEvent.keyDown(list, { key: "PageUp" });
      expect(useAppThemeStore.getState().previewSchemeId).toBe(DEFAULT_APP_SCHEME_ID);
    });

    it("PageDown from the search input delegates to list navigation", () => {
      render(<Harness />);

      const searchInput = screen.getByLabelText("Filter themes") as HTMLInputElement;

      const darkSchemes = BUILT_IN_APP_SCHEMES.filter((s) => s.type !== "light");
      const initialIndex = darkSchemes.findIndex((s) => s.id === DEFAULT_APP_SCHEME_ID);
      const expected = darkSchemes[Math.min(initialIndex + 10, darkSchemes.length - 1)];

      fireEvent.keyDown(searchInput, { key: "PageDown" });

      expect(useAppThemeStore.getState().previewSchemeId).toBe(expected?.id);
    });
  });

  describe("image error fallback", () => {
    it("shows fallback background div instead of broken thumbnail image", () => {
      render(<Harness />);
      const thumbImgs = document.querySelectorAll<HTMLImageElement>("img[src*='/themes/thumb/']");
      expect(thumbImgs.length).toBeGreaterThan(0);

      const img = thumbImgs[0]!;
      fireEvent.error(img);

      // The errored img should be removed from the document
      expect(document.body.contains(img)).toBe(false);
      // The fallback div with border should be present
      const fallbackDivs = document.querySelectorAll(".border-daintree-border\\/50");
      expect(fallbackDivs.length).toBeGreaterThan(0);
    });

    it("shows fallback (token background + PaletteStrip) instead of broken hero image", () => {
      const { container } = render(<Harness />);
      const heroImg = container.querySelector<HTMLImageElement>(".h-\\[200px\\] img.object-cover");
      expect(heroImg).not.toBeNull();

      fireEvent.error(heroImg!);

      // The broken hero img should be gone
      expect(container.querySelector(".h-\\[200px\\] img.object-cover")).toBeNull();
      // PaletteStrip chips in the hero fallback (scoped to hero container only)
      const heroChips = container.querySelectorAll(".h-\\[200px\\] .w-3.h-3");
      expect(heroChips.length).toBe(8);
    });
  });
});
