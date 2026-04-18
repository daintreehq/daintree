// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BUILT_IN_APP_SCHEMES, DEFAULT_APP_SCHEME_ID } from "@/config/appColorSchemes";
import { useAppThemeStore } from "@/store/appThemeStore";
import { _resetForTests } from "@/lib/escapeStack";
import { useGlobalEscapeDispatcher } from "@/hooks/useGlobalEscapeDispatcher";

vi.mock("@/clients/appThemeClient", () => ({
  appThemeClient: {
    setColorScheme: vi.fn().mockResolvedValue(undefined),
    setFollowSystem: vi.fn().mockResolvedValue(undefined),
    setCustomSchemes: vi.fn().mockResolvedValue(undefined),
    setRecentSchemeIds: vi.fn().mockResolvedValue(undefined),
    setAccentColorOverride: vi.fn().mockResolvedValue(undefined),
    importTheme: vi.fn().mockResolvedValue({ ok: false, errors: ["Import cancelled"] }),
    exportTheme: vi.fn().mockResolvedValue(undefined),
  },
}));

import { AppThemePicker } from "../AppThemePicker";

let pendingRaf: Array<{ handle: number; cb: FrameRequestCallback }> = [];
let nextHandle = 0;
const flushRaf = () => {
  act(() => {
    const pending = pendingRaf;
    pendingRaf = [];
    for (const entry of pending) entry.cb(0);
  });
};

function Harness() {
  useGlobalEscapeDispatcher();
  return <AppThemePicker />;
}

function otherDarkScheme() {
  return BUILT_IN_APP_SCHEMES.find((s) => s.type !== "light" && s.id !== DEFAULT_APP_SCHEME_ID)!;
}

function findRowByName(name: string) {
  return screen
    .getAllByRole("option")
    .find((o) => o.textContent?.toLowerCase().includes(name.toLowerCase()))!;
}

describe("AppThemePicker hover preview", () => {
  beforeEach(() => {
    _resetForTests();
    vi.useFakeTimers();
    pendingRaf = [];
    nextHandle = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      nextHandle += 1;
      pendingRaf.push({ handle: nextHandle, cb });
      return nextHandle;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      pendingRaf = pendingRaf.filter((entry) => entry.handle !== handle);
    });

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
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    _resetForTests();
    useAppThemeStore.setState({ previewSchemeId: null });
  });

  it("does not preview before the 300ms debounce fires", () => {
    const target = otherDarkScheme();
    render(<Harness />);

    fireEvent.pointerEnter(findRowByName(target.name));
    act(() => {
      vi.advanceTimersByTime(299);
    });

    expect(useAppThemeStore.getState().previewSchemeId).toBeNull();
  });

  it("sets previewSchemeId after 300ms debounce on pointer enter", () => {
    const target = otherDarkScheme();
    render(<Harness />);

    fireEvent.pointerEnter(findRowByName(target.name));
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(useAppThemeStore.getState().previewSchemeId).toBe(target.id);
  });

  it("cancels the debounce when pointer leaves before 300ms", () => {
    const target = otherDarkScheme();
    render(<Harness />);

    const row = findRowByName(target.name);
    fireEvent.pointerEnter(row);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    fireEvent.pointerLeave(row);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    flushRaf();

    expect(useAppThemeStore.getState().previewSchemeId).toBeNull();
  });

  it("clears previewSchemeId on pointer leave after rAF flush", () => {
    const target = otherDarkScheme();
    render(<Harness />);

    const row = findRowByName(target.name);
    fireEvent.pointerEnter(row);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(useAppThemeStore.getState().previewSchemeId).toBe(target.id);

    fireEvent.pointerLeave(row);
    expect(useAppThemeStore.getState().previewSchemeId).toBe(target.id);
    flushRaf();
    expect(useAppThemeStore.getState().previewSchemeId).toBeNull();
  });

  it("keyboard focus previews immediately without debounce", () => {
    const target = otherDarkScheme();
    render(<Harness />);

    const row = findRowByName(target.name);
    fireEvent.focus(row);

    // No timer advance — focus preview should be synchronous.
    expect(useAppThemeStore.getState().previewSchemeId).toBe(target.id);

    fireEvent.blur(row);
    flushRaf();
    expect(useAppThemeStore.getState().previewSchemeId).toBeNull();
  });

  it("clears preview when the picker unmounts mid-preview", () => {
    const target = otherDarkScheme();
    const { unmount } = render(<Harness />);

    fireEvent.pointerEnter(findRowByName(target.name));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(useAppThemeStore.getState().previewSchemeId).toBe(target.id);

    unmount();
    expect(useAppThemeStore.getState().previewSchemeId).toBeNull();
  });

  it("Escape clears an active preview", () => {
    const target = otherDarkScheme();
    render(<Harness />);

    fireEvent.pointerEnter(findRowByName(target.name));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(useAppThemeStore.getState().previewSchemeId).toBe(target.id);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(useAppThemeStore.getState().previewSchemeId).toBeNull();
  });

  it("Escape in the search input only clears the query, not the preview", () => {
    const target = otherDarkScheme();
    render(<Harness />);

    // Establish an active preview first.
    fireEvent.pointerEnter(findRowByName(target.name));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(useAppThemeStore.getState().previewSchemeId).toBe(target.id);

    // Type in the search input, then press Escape inside it.
    const searchInput = screen.getByLabelText("Filter themes") as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: "dai" } });
    expect(searchInput.value).toBe("dai");

    fireEvent.keyDown(searchInput, { key: "Escape" });

    // Query cleared.
    expect(searchInput.value).toBe("");
    // Preview must still be active.
    expect(useAppThemeStore.getState().previewSchemeId).toBe(target.id);
  });

  it("Escape in the search input with an empty query clears the preview", () => {
    const target = otherDarkScheme();
    render(<Harness />);

    fireEvent.pointerEnter(findRowByName(target.name));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(useAppThemeStore.getState().previewSchemeId).toBe(target.id);

    const searchInput = screen.getByLabelText("Filter themes") as HTMLInputElement;
    expect(searchInput.value).toBe("");

    // Fire the synthetic keyDown AND dispatch the native event on window in
    // the same tick — the search input should NOT preventDefault (because
    // the query is already empty), so the global dispatcher runs and clears
    // the preview.
    act(() => {
      fireEvent.keyDown(searchInput, { key: "Escape" });
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(useAppThemeStore.getState().previewSchemeId).toBeNull();
  });

  it("click commits the hovered theme and clears the preview before the view transition", () => {
    const target = otherDarkScheme();
    // Capture the value of previewSchemeId at the moment startViewTransition's
    // callback fires — it must be null by then (per PR #5087 ordering rule).
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
    const row = findRowByName(target.name);
    fireEvent.pointerEnter(row);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(useAppThemeStore.getState().previewSchemeId).toBe(target.id);

    fireEvent.click(row);

    expect(useAppThemeStore.getState().selectedSchemeId).toBe(target.id);
    expect(useAppThemeStore.getState().previewSchemeId).toBeNull();
    expect(callbackObservations).toEqual([null]);

    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
  });

  it("aria-live announces the previewed theme on enter and clears on leave", () => {
    const target = otherDarkScheme();
    const { container } = render(<Harness />);

    fireEvent.pointerEnter(findRowByName(target.name));
    act(() => {
      vi.advanceTimersByTime(300);
    });

    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe(`Previewing: ${target.name}`);

    fireEvent.pointerLeave(findRowByName(target.name));
    flushRaf();
    expect(live?.textContent).toBe("");
  });

  it("rapid traversal across rows previews only the final row", () => {
    const a = BUILT_IN_APP_SCHEMES.find(
      (s) => s.type !== "light" && s.id !== DEFAULT_APP_SCHEME_ID
    )!;
    const b = BUILT_IN_APP_SCHEMES.find(
      (s) => s.type !== "light" && s.id !== DEFAULT_APP_SCHEME_ID && s.id !== a.id
    )!;
    render(<Harness />);

    const rowA = findRowByName(a.name);
    const rowB = findRowByName(b.name);

    fireEvent.pointerEnter(rowA);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    // Switch to B before A's debounce fires.
    fireEvent.pointerEnter(rowB);
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(useAppThemeStore.getState().previewSchemeId).toBe(b.id);
  });

  it("leave-then-re-enter cancels the pending rAF revert", () => {
    const a = BUILT_IN_APP_SCHEMES.find(
      (s) => s.type !== "light" && s.id !== DEFAULT_APP_SCHEME_ID
    )!;
    const b = BUILT_IN_APP_SCHEMES.find(
      (s) => s.type !== "light" && s.id !== DEFAULT_APP_SCHEME_ID && s.id !== a.id
    )!;
    render(<Harness />);

    // Establish preview on A.
    fireEvent.pointerEnter(findRowByName(a.name));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(useAppThemeStore.getState().previewSchemeId).toBe(a.id);

    // Leave A — this schedules a rAF revert.
    fireEvent.pointerLeave(findRowByName(a.name));
    // Enter B before rAF flushes — should cancel the revert and debounce B.
    fireEvent.pointerEnter(findRowByName(b.name));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    flushRaf(); // any stale rAF must be a no-op now

    expect(useAppThemeStore.getState().previewSchemeId).toBe(b.id);
  });

  it("setAccentColorOverride during an active preview targets the previewed scheme", () => {
    const target = otherDarkScheme();
    render(<Harness />);

    fireEvent.pointerEnter(findRowByName(target.name));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(useAppThemeStore.getState().previewSchemeId).toBe(target.id);

    act(() => {
      useAppThemeStore.getState().setAccentColorOverride("#ff00aa");
    });

    // After the override, the previewed scheme must still be the one on :root:
    // the accent-primary CSS var should reflect the override, and non-accent
    // tokens should reflect the PREVIEWED scheme (not the committed one).
    expect(document.documentElement.style.getPropertyValue("--theme-accent-primary")).toBe(
      "#ff00aa"
    );
    expect(document.documentElement.style.getPropertyValue("--theme-surface-canvas")).toBe(
      target.tokens["surface-canvas"]
    );
  });

  it("click commit calls setPreviewSchemeId(null) before startViewTransition", () => {
    const target = otherDarkScheme();
    const callOrder: string[] = [];

    const originalSet = useAppThemeStore.getState().setPreviewSchemeId;
    const originalCommit = useAppThemeStore.getState().commitSchemeSelection;
    useAppThemeStore.setState({
      setPreviewSchemeId: (id: string | null) => {
        if (id === null && callOrder[callOrder.length - 1] !== "clearPreview") {
          callOrder.push("clearPreview");
        }
        originalSet(id);
      },
      commitSchemeSelection: (id: string) => {
        callOrder.push("commit");
        originalCommit(id);
      },
    });

    const startViewTransition = vi.fn((cb: () => void) => {
      callOrder.push("startViewTransition");
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
    const row = findRowByName(target.name);
    fireEvent.pointerEnter(row);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.click(row);

    // Expect strict ordering: preview cleared → commit → view transition.
    const clearIdx = callOrder.indexOf("clearPreview");
    const commitIdx = callOrder.indexOf("commit");
    const transitionIdx = callOrder.indexOf("startViewTransition");
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThan(clearIdx);
    expect(transitionIdx).toBeGreaterThan(commitIdx);

    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
  });

  it("hero panel image reflects the previewed theme during preview", () => {
    const target = otherDarkScheme();
    if (!target.heroImage) return; // guard against data drift
    const { container } = render(<Harness />);

    fireEvent.pointerEnter(findRowByName(target.name));
    act(() => {
      vi.advanceTimersByTime(300);
    });

    // The hero image sits in a container sized 200px tall; select by class
    // sequence used in the component to narrow to the hero block.
    const heroImg = container.querySelector<HTMLImageElement>(
      `.h-\\[200px\\] img[src='${target.heroImage}']`
    );
    expect(heroImg).not.toBeNull();
  });
});
