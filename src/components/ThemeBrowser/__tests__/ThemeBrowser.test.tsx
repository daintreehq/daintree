// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BUILT_IN_APP_SCHEMES, DEFAULT_APP_SCHEME_ID } from "@/config/appColorSchemes";
import { getAppThemeCssVariables } from "@shared/theme";
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

import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeBrowser } from "../ThemeBrowser";

function Harness() {
  useGlobalEscapeDispatcher();
  // The app mounts the browser under App's TooltipProvider.
  return (
    <TooltipProvider>
      <ThemeBrowser />
    </TooltipProvider>
  );
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

  // VoiceOver drops live-region updates from outside the focused aria-modal
  // subtree (Chromium 354736464), so a co-located announcer is required here.
  it("co-locates non-focusable announcer live regions inside the aria-modal subtree", () => {
    const { container } = render(<Harness />);
    const modal = container.querySelector('[aria-modal="true"]');
    expect(modal).not.toBeNull();

    // AccessibilityAnnouncer contributes the only assertive region; the
    // existing preview region is polite-only.
    expect(modal!.querySelectorAll('[aria-live="assertive"]').length).toBe(1);
    // Preview region (polite) + AccessibilityAnnouncer's polite region.
    expect(modal!.querySelectorAll('[aria-live="polite"]').length).toBe(2);

    for (const region of modal!.querySelectorAll("[aria-live]")) {
      const tabindex = region.getAttribute("tabindex");
      expect(tabindex === null || Number(tabindex) < 0).toBe(true);
    }
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

  it("ArrowDown on the list previews the specific next theme row", () => {
    render(<Harness />);

    const darkSchemes = BUILT_IN_APP_SCHEMES.filter((s) => s.type !== "light");
    const initialIndex = darkSchemes.findIndex((s) => s.id === DEFAULT_APP_SCHEME_ID);
    const expectedNext = darkSchemes[initialIndex + 1];

    const list = screen.getByRole("listbox", { name: "Theme list" });
    fireEvent.keyDown(list, { key: "ArrowDown" });

    expect(useAppThemeStore.getState().previewSchemeId).toBe(expectedNext?.id);
  });

  it("holds the arrows at the list's ends and jumps with Home/End, leaving the field's Home/End to the caret", () => {
    render(<Harness />);

    const list = screen.getByRole("listbox", { name: "Theme list" });
    const search = screen.getByLabelText("Filter themes");
    const rows = screen.getAllByRole("option");
    const first = rows[0]!.id;
    const last = rows[rows.length - 1]!.id;
    expect(first).not.toBe(last);
    const active = () => search.getAttribute("aria-activedescendant");

    fireEvent.keyDown(list, { key: "End" });
    expect(active()).toBe(last);
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(active()).toBe(last);

    fireEvent.keyDown(list, { key: "Home" });
    expect(active()).toBe(first);
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(active()).toBe(first);

    expect(fireEvent.keyDown(list, { key: "End", shiftKey: true })).toBe(true);
    expect(active()).toBe(first);

    expect(fireEvent.keyDown(search, { key: "End" })).toBe(true);
    expect(active()).toBe(first);
    fireEvent.keyDown(list, { key: "End" });
    expect(fireEvent.keyDown(search, { key: "Home" })).toBe(true);
    expect(active()).toBe(last);
  });

  it("switching the type filter reverts an active preview", () => {
    const target = otherDarkScheme();
    render(<Harness />);

    fireEvent.click(findRowByName(target.name));
    expect(useAppThemeStore.getState().previewSchemeId).toBe(target.id);

    fireEvent.click(screen.getByRole("radio", { name: "Light" }));

    expect(useAppThemeStore.getState().previewSchemeId).toBeNull();
  });

  it("filtering away the previewed theme reverts the preview, keeping it when still matched", () => {
    const target = otherDarkScheme();
    render(<Harness />);
    const searchInput = screen.getByLabelText("Filter themes") as HTMLInputElement;

    fireEvent.click(findRowByName(target.name));
    expect(useAppThemeStore.getState().previewSchemeId).toBe(target.id);

    fireEvent.change(searchInput, { target: { value: target.name.slice(0, 3) } });
    expect(useAppThemeStore.getState().previewSchemeId).toBe(target.id);

    fireEvent.change(searchInput, { target: { value: "zzz-no-such-theme" } });
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

  it("releases the 'theme-browser' overlay claim on unmount", () => {
    const { unmount } = render(<Harness />);
    expect(useUIStore.getState().overlayStack.includes("theme-browser")).toBe(true);

    unmount();

    expect(useUIStore.getState().overlayStack.includes("theme-browser")).toBe(false);
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
      // A colour swatch stands in for the missing thumbnail. Asserted by the
      // inline background the fallback paints, not by its class name — the
      // class is styling and may change; "something renders in its place" is
      // the contract.
      const fallbackDivs = [...document.querySelectorAll<HTMLElement>("div[style]")].filter(
        (d) => d.style.backgroundColor !== ""
      );
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

// These pin the CONTRACT the surface owes, not the styling that currently
// expresses it. A theme, a token or a glyph may change freely; what may not
// change is that navigating never strands the filter, that a click and the
// arrow keys share one cursor which hover never moves, and that "saved" and
// "being tried" stay two separate facts.
describe("ThemeBrowser navigation contract", () => {
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
  });

  it("keeps DOM focus on the filter field while arrowing the list", () => {
    render(<Harness />);
    const input = screen.getByLabelText("Filter themes");
    act(() => input.focus());

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });

    // The rule: the list is navigated virtually. If focus ever lands on a row,
    // the user's next keystroke stops reaching the filter.
    expect(document.activeElement).toBe(input);
  });

  it("keeps 'what is saved' and 'what is being tried' separately addressable", () => {
    render(<Harness />);
    const other = otherDarkScheme();
    fireEvent.click(findRowByName(other.name));

    const rows = screen.getAllByRole("option");
    const saved = rows.filter((o) => o.getAttribute("aria-current") === "true");
    const cursor = rows.filter((o) => o.getAttribute("aria-selected") === "true");

    // The rule: previewing must never move the marker for what is committed.
    // Which ARIA attribute carries which is the app's convention (aria-current
    // = saved, aria-selected = cursor); what may not change is that they are
    // two distinct markers landing on two different rows while previewing.
    expect(saved).toHaveLength(1);
    expect(cursor).toHaveLength(1);
    expect(saved[0]).not.toBe(cursor[0]);
    expect(saved[0]!.textContent).toContain(
      BUILT_IN_APP_SCHEMES.find((s) => s.id === DEFAULT_APP_SCHEME_ID)!.name
    );
    expect(cursor[0]!.textContent).toContain(other.name);
    expect(useAppThemeStore.getState().previewSchemeId).toBe(other.id);
  });

  it("resumes arrow navigation from a row chosen with the pointer", () => {
    render(<Harness />);
    const input = screen.getByLabelText("Filter themes");
    act(() => input.focus());

    const third = darkSchemeAt(2)!;
    const row = findRowByName(third.name);
    // Rows are not focusable, so a click must not be allowed to take focus off
    // the field. Drive the real sequence — pointerdown then click — rather than
    // restoring focus by hand, which is what previously hid this regression.
    fireEvent.pointerDown(row);
    fireEvent.click(row);

    // The rule: clicking never costs the user their keyboard.
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: "ArrowDown" });

    // The rule: one cursor, shared by both input devices. After clicking row N,
    // ArrowDown must land on N+1 — not wherever the keyboard cursor was left.
    expect(useAppThemeStore.getState().previewSchemeId).toBe(darkSchemeAt(3)!.id);
  });

  // An IME confirms its candidate with Enter and pages candidates with Page
  // keys; those keystrokes belong to the composition, not to the list.
  describe("while an IME is composing", () => {
    it.each([
      ["isComposing", { isComposing: true }],
      ["keyCode 229", { keyCode: 229 }],
    ])("leaves Enter to the composition (%s)", async (_label, composing) => {
      const { appThemeClient } = await import("@/clients/appThemeClient");
      vi.mocked(appThemeClient.setColorScheme).mockClear();
      render(<Harness />);
      const input = screen.getByLabelText("Filter themes");
      const target = otherDarkScheme();
      fireEvent.click(findRowByName(target.name));

      fireEvent.keyDown(input, { key: "Enter", ...composing });

      expect(useThemeBrowserStore.getState().isOpen).toBe(true);
      expect(useAppThemeStore.getState().selectedSchemeId).toBe(DEFAULT_APP_SCHEME_ID);
      expect(useAppThemeStore.getState().previewSchemeId).toBe(target.id);
      expect(appThemeClient.setColorScheme).not.toHaveBeenCalled();
    });

    it.each([
      ["PageDown", { isComposing: true }],
      ["PageUp", { isComposing: true }],
      ["PageDown", { keyCode: 229 }],
      ["PageUp", { keyCode: 229 }],
    ])("leaves %s to the composition (%o)", (key, composing) => {
      render(<Harness />);
      const input = screen.getByLabelText("Filter themes");
      const target = darkSchemeAt(2)!;
      fireEvent.click(findRowByName(target.name));

      const notCancelled = fireEvent.keyDown(input, { key, ...composing });

      expect(notCancelled).toBe(true);
      expect(useAppThemeStore.getState().previewSchemeId).toBe(target.id);
    });
  });

  // The cursor is the highlighted row, not a number that outlives the list it
  // was counted in. Every case below changes the list under a cursor and then
  // arrows, and each one used to step from an index the new list never offered.
  describe("arrowing after the list changes (#16655)", () => {
    const schemesOf = (type: "dark" | "light") =>
      BUILT_IN_APP_SCHEMES.filter((s) =>
        type === "light" ? s.type === "light" : s.type !== "light"
      );
    const matching = (query: string, type: "dark" | "light" = "dark") =>
      schemesOf(type).filter((s) => s.name.toLowerCase().includes(query));
    const previewId = () => useAppThemeStore.getState().previewSchemeId;
    const typeFilter = (value: string) => {
      const input = screen.getByLabelText<HTMLInputElement>("Filter themes");
      fireEvent.change(input, { target: { value } });
      return input;
    };
    const press = (key: string) => {
      fireEvent.keyDown(screen.getByLabelText("Filter themes"), { key });
    };
    const clickRow = (name: string) => {
      const row = findRowByName(name);
      fireEvent.pointerDown(row);
      fireEvent.click(row);
    };

    it("previews the first match on ArrowDown when the filter hides every highlighted row", () => {
      render(<Harness />);
      const matches = matching("o");
      expect(matches.length).toBeGreaterThan(2);
      expect(matches.some((s) => s.id === DEFAULT_APP_SCHEME_ID)).toBe(false);

      const input = typeFilter("o");

      expect(input.getAttribute("aria-activedescendant")).toBeNull();
      expect(previewId()).toBeNull();
      press("ArrowDown");
      expect(previewId()).toBe(matches[0]!.id);
    });

    it("previews the last match on ArrowUp when nothing is highlighted", () => {
      render(<Harness />);
      const matches = matching("o");

      typeFilter("o");
      press("ArrowUp");

      expect(previewId()).toBe(matches[matches.length - 1]!.id);
    });

    it("enters at the first match, not the end, when the current theme sat low in the list", () => {
      const lowest = schemesOf("dark").at(-1)!;
      useAppThemeStore.setState({ selectedSchemeId: lowest.id });
      render(<Harness />);
      const matches = matching("an");
      expect(matches.length).toBeGreaterThan(1);
      expect(matches.some((s) => s.id === lowest.id)).toBe(false);

      typeFilter("an");
      press("ArrowDown");

      expect(previewId()).toBe(matches[0]!.id);
    });

    it("steps to the row below a previewed row that survives a narrower query", () => {
      const previewed = darkSchemeAt(4)!;
      render(<Harness />);
      clickRow(previewed.name);
      const matches = matching("i");
      const at = matches.findIndex((s) => s.id === previewed.id);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).not.toBe(4);

      typeFilter("i");
      expect(previewId()).toBe(previewed.id);

      press("ArrowDown");
      expect(previewId()).toBe(matches[at + 1]!.id);
      press("ArrowUp");
      expect(previewId()).toBe(previewed.id);
    });

    it("keeps a click and the arrow after it in step inside a filtered list", () => {
      render(<Harness />);
      const matches = matching("o");
      typeFilter("o");

      clickRow(matches[1]!.name);
      press("ArrowDown");

      expect(previewId()).toBe(matches[2]!.id);
    });

    it.each([
      [
        "Escape in the field",
        () => fireEvent.keyDown(screen.getByLabelText("Filter themes"), { key: "Escape" }),
      ],
      [
        "Escape outside the field",
        () => {
          act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          });
        },
      ],
      [
        "the clear button",
        () => fireEvent.click(screen.getByRole("button", { name: "Clear filter" })),
      ],
    ])("steps on from the highlighted row after %s clears the query", (_label, clear) => {
      render(<Harness />);
      const dark = schemesOf("dark");
      const previewed = dark[6]!;
      clickRow(previewed.name);
      typeFilter(previewed.name.slice(2).toLowerCase());
      expect(previewId()).toBe(previewed.id);

      clear();
      expect(screen.getByLabelText<HTMLInputElement>("Filter themes").value).toBe("");
      press("ArrowDown");

      expect(previewId()).toBe(dark[7]!.id);
    });

    it("starts from the first row after switching to Light, and from the current theme on the way back", () => {
      render(<Harness />);
      const light = schemesOf("light");
      const dark = schemesOf("dark");
      clickRow(dark[2]!.name);

      fireEvent.click(screen.getByRole("radio", { name: "Light" }));
      expect(previewId()).toBeNull();
      expect(
        screen.getByLabelText("Filter themes").getAttribute("aria-activedescendant")
      ).toBeNull();
      press("ArrowDown");
      expect(previewId()).toBe(light[0]!.id);

      fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
      expect(previewId()).toBeNull();
      press("ArrowDown");
      expect(previewId()).toBe(dark[1]!.id);
    });

    it("applies nothing on Enter while no row is highlighted", async () => {
      const { appThemeClient } = await import("@/clients/appThemeClient");
      vi.mocked(appThemeClient.setColorScheme).mockClear();
      render(<Harness />);
      typeFilter("o");
      expect(previewId()).toBeNull();

      press("Enter");

      expect(useAppThemeStore.getState().selectedSchemeId).toBe(DEFAULT_APP_SCHEME_ID);
      expect(previewId()).toBeNull();
      expect(vi.mocked(appThemeClient.setColorScheme)).not.toHaveBeenCalled();
      expect(useThemeBrowserStore.getState().isOpen).toBe(true);
    });

    // jsdom measures nothing, so the page size falls back to 10 and every page
    // lands on an end of these short lists. Measuring two rows a page makes the
    // starting row matter.
    const withPagesOfTwo = (run: () => void) => {
      const list = screen.getByRole("listbox", { name: "Theme list" });
      Object.defineProperty(list, "clientHeight", { configurable: true, value: 80 });
      const rect = vi
        .spyOn(Element.prototype, "getBoundingClientRect")
        .mockReturnValue(new DOMRect(0, 0, 0, 40));
      try {
        run();
      } finally {
        rect.mockRestore();
      }
    };

    it("pages from a previewed row that survives a narrower query", () => {
      const previewed = darkSchemeAt(4)!;
      render(<Harness />);
      clickRow(previewed.name);
      const matches = matching("i");
      const at = matches.findIndex((s) => s.id === previewed.id);
      typeFilter("i");

      withPagesOfTwo(() => {
        press("PageUp");
        expect(previewId()).toBe(matches[at - 2]!.id);
        press("PageDown");
        expect(previewId()).toBe(matches[at]!.id);
      });
    });

    it.each([
      ["PageDown", 0],
      ["PageUp", -1],
    ])("%s enters at the same row as its arrow when nothing is highlighted", (key, at) => {
      render(<Harness />);
      const matches = matching("o");
      typeFilter("o");

      withPagesOfTwo(() => press(key));

      expect(previewId()).toBe(matches.at(at)!.id);
    });

    describe("in a project that has its own theme", () => {
      afterEach(() => {
        useAppThemeStore.setState({ projectSchemeId: null, projectSnapshotScheme: null });
      });

      // Set theme saves the global theme (#13833), so the window goes back to
      // the project's after it; the dialog's description says so up front.
      it("says Set theme changes the global theme while this project keeps its own", () => {
        const project = schemesOf("dark")[1]!;
        useAppThemeStore.setState({ projectSchemeId: project.id });
        render(<Harness />);

        const dialog = screen.getByRole("dialog", { name: "Theme browser" });
        const description = document.getElementById(dialog.getAttribute("aria-describedby")!)!;
        expect(description.textContent).toBe(
          `This project shows its own theme, ${project.name}. Set theme changes the global theme.`
        );
      });

      // The project's theme is already on screen, but its row must still take the
      // highlight when the cursor lands on it, or the arrows, which step from the
      // highlight, would stall one row short.
      it("lets the arrows step past the row of the theme already on screen", () => {
        const dark = schemesOf("dark");
        useAppThemeStore.setState({ projectSchemeId: dark[1]!.id });
        render(<Harness />);

        press("ArrowDown");
        expect(previewId()).toBe(dark[1]!.id);
        expect(findRowByName(dark[1]!.name).getAttribute("aria-selected")).toBe("true");

        press("ArrowDown");
        expect(previewId()).toBe(dark[2]!.id);
      });

      // An older deferred paint holds a valid claim on the screen until a newer
      // write supersedes it, so landing on the row has to write, even though the
      // theme it paints is the one already showing.
      it("paints the project's theme when the cursor lands on its row", async () => {
        const [globalScheme, project] = schemesOf("dark");
        useAppThemeStore.setState({ projectSchemeId: project!.id });
        render(<Harness />);
        const projectVars = getAppThemeCssVariables(project!);
        const globalVars = getAppThemeCssVariables(globalScheme!);
        const probe = Object.keys(projectVars).find(
          (name) => projectVars[name] !== globalVars[name]
        )!;
        document.documentElement.style.removeProperty(probe);

        clickRow(project!.name);
        await act(async () => {
          await new Promise((resolve) => requestAnimationFrame(resolve));
        });

        expect(document.documentElement.style.getPropertyValue(probe)).toBe(projectVars[probe]);
      });

      it("continues from that row after it is clicked", () => {
        const dark = schemesOf("dark");
        useAppThemeStore.setState({ projectSchemeId: dark[1]!.id });
        render(<Harness />);

        clickRow(dark[1]!.name);
        expect(previewId()).toBe(dark[1]!.id);
        expect(findRowByName(dark[1]!.name).getAttribute("aria-selected")).toBe("true");

        press("ArrowDown");
        expect(previewId()).toBe(dark[2]!.id);
      });
    });
  });

  it("saves the clicked theme even when the pointer crosses other rows on the way to Set theme", async () => {
    const { appThemeClient } = await import("@/clients/appThemeClient");
    vi.mocked(appThemeClient.setColorScheme).mockClear();
    render(<Harness />);
    const input = screen.getByLabelText("Filter themes");

    const clicked = darkSchemeAt(1)!;
    const clickedRow = findRowByName(clicked.name);
    fireEvent.pointerDown(clickedRow);
    fireEvent.click(clickedRow);

    // The rule: hover never moves the cursor, so it never retargets the save.
    for (const crossed of [darkSchemeAt(2)!, darkSchemeAt(3)!]) {
      const row = findRowByName(crossed.name);
      fireEvent.pointerOver(row);
      fireEvent.pointerMove(row);
    }

    expect(useAppThemeStore.getState().previewSchemeId).toBe(clicked.id);
    expect(input.getAttribute("aria-activedescendant")).toBe(`theme-option-${clicked.id}`);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Set theme" }));
    });

    expect(useAppThemeStore.getState().selectedSchemeId).toBe(clicked.id);
    expect(vi.mocked(appThemeClient.setColorScheme)).toHaveBeenCalledWith(clicked.id);
  });

  it("never previews a row the pointer merely moves over", () => {
    render(<Harness />);
    const input = screen.getByLabelText("Filter themes");
    const activeBefore = input.getAttribute("aria-activedescendant");

    const row = findRowByName(darkSchemeAt(2)!.name);
    fireEvent.pointerOver(row);
    fireEvent.pointerMove(row);

    expect(useAppThemeStore.getState().previewSchemeId).toBeNull();
    expect(useAppThemeStore.getState().selectedSchemeId).toBe(DEFAULT_APP_SCHEME_ID);
    expect(input.getAttribute("aria-activedescendant")).toBe(activeBefore);
    expect(row.getAttribute("aria-selected")).toBe("false");
  });

  it("lets Enter save the arrowed theme even after the pointer wanders", () => {
    render(<Harness />);
    const input = screen.getByLabelText("Filter themes");
    act(() => input.focus());

    const clickedRow = findRowByName(darkSchemeAt(1)!.name);
    fireEvent.pointerDown(clickedRow);
    fireEvent.click(clickedRow);
    fireEvent.keyDown(input, { key: "ArrowDown" });

    const arrowed = darkSchemeAt(2)!;
    expect(useAppThemeStore.getState().previewSchemeId).toBe(arrowed.id);

    fireEvent.pointerMove(findRowByName(darkSchemeAt(4)!.name));
    fireEvent.keyDown(input, { key: "Enter" });

    expect(useAppThemeStore.getState().selectedSchemeId).toBe(arrowed.id);
    expect(useThemeBrowserStore.getState().isOpen).toBe(false);
  });

  it("clears a non-empty query on Escape instead of closing the dialog", () => {
    render(<Harness />);
    const input = screen.getByLabelText("Filter themes");
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "fio" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });

    // Escape after arrowing must still be understood as "undo my filter".
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.getByLabelText<HTMLInputElement>("Filter themes").value).toBe("");
    expect(useThemeBrowserStore.getState().isOpen).toBe(true);
  });

  const nextFrame = () =>
    act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

  it("hands focus back to whatever opened it", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();

    const view = render(<Harness />);
    // Take focus into the dialog the way opening it does (the open-time focus
    // lands in a rAF that jsdom will not run for us here).
    act(() => screen.getByLabelText("Filter themes").focus());
    expect(document.activeElement).not.toBe(opener);

    view.unmount();
    await nextFrame();

    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  // Opened from Settings, closing reopens Settings on the theme section, which
  // takes focus before the browser's exit animation ends and it unmounts. The
  // opener it recorded then is no longer where the user is.
  it("leaves focus where the next surface put it by the time it unmounts", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const view = render(<Harness />);
    act(() => screen.getByLabelText("Filter themes").focus());

    const reopened = document.createElement("button");
    document.body.appendChild(reopened);
    act(() => reopened.focus());
    view.unmount();
    await nextFrame();

    expect(document.activeElement).toBe(reopened);
    opener.remove();
    reopened.remove();
  });

  describe("plugin themes (#13832)", () => {
    const base = BUILT_IN_APP_SCHEMES.find((s) => s.type !== "light")!;
    const pluginTheme = (pluginId: string, pluginName: string, themeId: string, name: string) => ({
      ...base,
      id: `plugin:${pluginId}:${themeId}`,
      name,
      builtin: false,
      plugin: { id: pluginId, name: pluginName },
    });

    afterEach(() => {
      useAppThemeStore.setState({ pluginSchemes: [] });
    });

    it("lists each plugin's themes after the built-ins, under the plugin's name", () => {
      useAppThemeStore.setState({
        pluginSchemes: [
          pluginTheme("zeta.themes", "Zeta Themes", "noir", "Noir"),
          pluginTheme("acme.themes", "Acme Themes", "midnight", "Midnight"),
          pluginTheme("zeta.themes", "Zeta Themes", "dusk", "Dusk"),
        ],
      });
      render(<Harness />);

      const labels = screen
        .getAllByRole("option")
        .map((o) => o.getAttribute("aria-label") ?? o.textContent ?? "");
      const tail = labels.slice(labels.findIndex((label) => label === "From Acme Themes"));
      expect(tail.map((label) => label.replace(/Current|Trying/, "").trim())).toEqual([
        "From Acme Themes",
        expect.stringContaining("Midnight"),
        "From Zeta Themes",
        expect.stringContaining("Noir"),
        expect.stringContaining("Dusk"),
      ]);
      const headings = screen
        .getAllByRole("option")
        .filter((o) => o.getAttribute("aria-disabled") === "true");
      expect(headings.map((o) => o.getAttribute("aria-label"))).toEqual([
        "From Acme Themes",
        "From Zeta Themes",
      ]);
    });
  });
});
