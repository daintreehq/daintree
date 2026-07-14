// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_APP_SCHEMES, DEFAULT_APP_SCHEME_ID } from "@/config/appColorSchemes";
import { flushPendingTheme, injectSchemeToDOM, useAppThemeStore } from "../appThemeStore";

describe("appThemeStore.recentSchemeIds LRU", () => {
  beforeEach(() => {
    useAppThemeStore.setState({
      selectedSchemeId: DEFAULT_APP_SCHEME_ID,
      customSchemes: [],
      colorVisionMode: "default",
      followSystem: false,
      preferredDarkSchemeId: "daintree",
      preferredLightSchemeId: "bondi",
      recentSchemeIds: [],
      accentColorOverride: null,
    });
  });

  it("starts empty", () => {
    expect(useAppThemeStore.getState().recentSchemeIds).toEqual([]);
  });

  it("setSelectedSchemeId prepends the id to recentSchemeIds", () => {
    useAppThemeStore.getState().setSelectedSchemeId("svalbard");
    expect(useAppThemeStore.getState().recentSchemeIds[0]).toBe("svalbard");

    useAppThemeStore.getState().setSelectedSchemeId("bondi");
    const recent = useAppThemeStore.getState().recentSchemeIds;
    expect(recent[0]).toBe("bondi");
    expect(recent[1]).toBe("svalbard");
  });

  it("deduplicates when re-selecting an existing id (moves to front)", () => {
    const store = useAppThemeStore.getState();
    store.setSelectedSchemeId("daintree");
    store.setSelectedSchemeId("bondi");
    store.setSelectedSchemeId("serengeti");
    store.setSelectedSchemeId("daintree");

    const recent = useAppThemeStore.getState().recentSchemeIds;
    expect(recent[0]).toBe("daintree");
    expect(recent.filter((id) => id === "daintree")).toHaveLength(1);
    expect(recent).toHaveLength(3);
  });

  it("caps the list at 5 entries, evicting the oldest", () => {
    const store = useAppThemeStore.getState();
    const ids = ["daintree", "bondi", "serengeti", "hokkaido", "namib", "arashiyama", "atacama"];
    for (const id of ids) store.setSelectedSchemeId(id);

    const recent = useAppThemeStore.getState().recentSchemeIds;
    expect(recent).toHaveLength(5);
    // Newest first, oldest two evicted
    expect(recent[0]).toBe("atacama");
    expect(recent).not.toContain("daintree");
    expect(recent).not.toContain("bondi");
  });

  it("setSelectedSchemeIdSilent does NOT mutate recentSchemeIds", () => {
    useAppThemeStore.getState().setSelectedSchemeId("svalbard");
    expect(useAppThemeStore.getState().recentSchemeIds).toEqual(["svalbard"]);

    useAppThemeStore.getState().setSelectedSchemeIdSilent("bondi");
    expect(useAppThemeStore.getState().selectedSchemeId).toBe("bondi");
    // recentSchemeIds unchanged — silent path does not record usage
    expect(useAppThemeStore.getState().recentSchemeIds).toEqual(["svalbard"]);
  });

  it("injectTheme does NOT mutate recentSchemeIds (hover preview)", () => {
    useAppThemeStore.getState().setSelectedSchemeId("daintree");
    const before = useAppThemeStore.getState().recentSchemeIds;

    const someScheme = { id: "hover-target", tokens: {} } as unknown as Parameters<
      ReturnType<typeof useAppThemeStore.getState>["injectTheme"]
    >[0];
    try {
      useAppThemeStore.getState().injectTheme(someScheme);
    } catch {
      // jsdom may throw on unknown tokens — irrelevant to this assertion
    }

    expect(useAppThemeStore.getState().recentSchemeIds).toEqual(before);
  });

  it("setRecentSchemeIds replaces the list and caps at 5", () => {
    useAppThemeStore.getState().setRecentSchemeIds(["a", "b", "c", "d", "e", "f", "g"]);
    expect(useAppThemeStore.getState().recentSchemeIds).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("setRecentSchemeIds deduplicates incoming entries", () => {
    useAppThemeStore.getState().setRecentSchemeIds(["a", "b", "a", "c", "b", "d"]);
    expect(useAppThemeStore.getState().recentSchemeIds).toEqual(["a", "b", "c", "d"]);
  });

  it("setAccentColorOverride patches the CSS variables on :root", () => {
    // Start from a known dark built-in so base accent is a predictable hex.
    useAppThemeStore.getState().setSelectedSchemeIdSilent("daintree");
    flushPendingTheme();
    const baseAccent = document.documentElement.style.getPropertyValue("--theme-accent-primary");
    expect(baseAccent).toBeTruthy();

    useAppThemeStore.getState().setAccentColorOverride("#ff00aa");
    flushPendingTheme();
    expect(useAppThemeStore.getState().accentColorOverride).toBe("#ff00aa");
    const overridden = document.documentElement.style.getPropertyValue("--theme-accent-primary");
    expect(overridden).toBe("#ff00aa");
    expect(document.documentElement.style.getPropertyValue("--theme-accent-rgb")).toBe(
      "255, 0, 170"
    );
    // Non-accent tokens should be unchanged from the base theme.
    const daintree = BUILT_IN_APP_SCHEMES.find((s) => s.id === "daintree")!;
    expect(document.documentElement.style.getPropertyValue("--theme-surface-canvas")).toBe(
      daintree.tokens["surface-canvas"]
    );
  });

  it("setAccentColorOverride(null) clears the override and restores theme accent", () => {
    useAppThemeStore.getState().setSelectedSchemeIdSilent("daintree");
    flushPendingTheme();
    const daintree = BUILT_IN_APP_SCHEMES.find((s) => s.id === "daintree")!;

    useAppThemeStore.getState().setAccentColorOverride("#112233");
    flushPendingTheme();
    expect(document.documentElement.style.getPropertyValue("--theme-accent-primary")).toBe(
      "#112233"
    );

    useAppThemeStore.getState().setAccentColorOverride(null);
    flushPendingTheme();
    expect(useAppThemeStore.getState().accentColorOverride).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--theme-accent-primary")).toBe(
      daintree.tokens["accent-primary"]
    );
  });

  it("override survives a subsequent setSelectedSchemeId (theme switch)", () => {
    useAppThemeStore.getState().setAccentColorOverride("#abcdef");
    flushPendingTheme();
    // Switch to a different theme — the override must still be applied.
    useAppThemeStore.getState().setSelectedSchemeId("bondi");
    flushPendingTheme();
    expect(useAppThemeStore.getState().accentColorOverride).toBe("#abcdef");
    expect(document.documentElement.style.getPropertyValue("--theme-accent-primary")).toBe(
      "#abcdef"
    );
    // And setSelectedSchemeIdSilent (follow-system, hydration) path too.
    useAppThemeStore.getState().setSelectedSchemeIdSilent("daintree");
    flushPendingTheme();
    expect(document.documentElement.style.getPropertyValue("--theme-accent-primary")).toBe(
      "#abcdef"
    );
  });

  it("removeCustomScheme strips the removed id from recentSchemeIds", () => {
    const customScheme = {
      id: "custom-app-theme",
      name: "Custom",
      type: "dark" as const,
      builtin: false,
      tokens: {} as never,
    };
    useAppThemeStore.getState().addCustomScheme(customScheme);
    useAppThemeStore.getState().setSelectedSchemeId("custom-app-theme");
    useAppThemeStore.getState().setSelectedSchemeId("svalbard");
    expect(useAppThemeStore.getState().recentSchemeIds).toContain("custom-app-theme");

    useAppThemeStore.getState().removeCustomScheme("custom-app-theme");
    expect(useAppThemeStore.getState().recentSchemeIds).not.toContain("custom-app-theme");
  });
});

describe("injectSchemeToDOM RAF coalescing", () => {
  beforeEach(() => {
    useAppThemeStore.setState({
      selectedSchemeId: DEFAULT_APP_SCHEME_ID,
      customSchemes: [],
      colorVisionMode: "default",
      followSystem: false,
      accentColorOverride: null,
      recentSchemeIds: [],
    });
  });

  it("coalesces multiple injectSchemeToDOM calls in the same frame into one DOM write", () => {
    const daintree = BUILT_IN_APP_SCHEMES.find((s) => s.id === "daintree")!;
    const bondi = BUILT_IN_APP_SCHEMES.find((s) => s.id === "bondi")!;

    // Apply daintree first
    injectSchemeToDOM(daintree);
    // Immediately apply bondi — should overwrite pendingScheme
    injectSchemeToDOM(bondi);

    // DOM should still be unchanged (RAF hasn't fired in jsdom without fake timers)
    // Flush and check that only bondi tokens are present.
    flushPendingTheme();

    const canvas = document.documentElement.style.getPropertyValue("--theme-surface-canvas");
    expect(canvas).toBe(bondi.tokens["surface-canvas"]);
    expect(canvas).not.toBe(daintree.tokens["surface-canvas"]);
  });

  it("Zustand state updates synchronously even when DOM is deferred", () => {
    useAppThemeStore.getState().setAccentColorOverride("#aabbcc");
    // Zustand state must be immediately available — no flush needed
    expect(useAppThemeStore.getState().accentColorOverride).toBe("#aabbcc");
    // DOM is deferred — flush for the assertion
    flushPendingTheme();
    expect(document.documentElement.style.getPropertyValue("--theme-accent-primary")).toBe(
      "#aabbcc"
    );
  });

  it("immediate mode applies synchronously and cancels any pending RAF scheme", () => {
    const daintree = BUILT_IN_APP_SCHEMES.find((s) => s.id === "daintree")!;
    const bondi = BUILT_IN_APP_SCHEMES.find((s) => s.id === "bondi")!;

    // Queue daintree via RAF
    injectSchemeToDOM(daintree);
    // Immediate call should cancel the pending daintree write
    injectSchemeToDOM(bondi, { immediate: true });

    // DOM should already have bondi tokens applied synchronously
    expect(document.documentElement.style.getPropertyValue("--theme-surface-canvas")).toBe(
      bondi.tokens["surface-canvas"]
    );

    // Flush should be a no-op (pending was cleared by immediate)
    flushPendingTheme();
    expect(document.documentElement.style.getPropertyValue("--theme-surface-canvas")).toBe(
      bondi.tokens["surface-canvas"]
    );
  });

  it("flushPendingTheme is a no-op when nothing is pending", () => {
    const daintree = BUILT_IN_APP_SCHEMES.find((s) => s.id === "daintree")!;
    injectSchemeToDOM(daintree, { immediate: true });

    const before = document.documentElement.style.getPropertyValue("--theme-surface-canvas");
    // Second flush should not change anything
    flushPendingTheme();
    expect(document.documentElement.style.getPropertyValue("--theme-surface-canvas")).toBe(before);
  });
});

describe("setSelectedSchemeIdSilent crossfade option", () => {
  const daintree = BUILT_IN_APP_SCHEMES.find((s) => s.id === "daintree")!;
  const bondi = BUILT_IN_APP_SCHEMES.find((s) => s.id === "bondi")!;

  type FakeTransition = { ready: Promise<void>; finished: Promise<void> };

  /** Cast-free — `document as unknown as {...}` trips the no-unsafe-type-assertion ratchet. */
  function stubStartViewTransition(start: (callback: () => void) => FakeTransition) {
    Object.assign(document, { startViewTransition: start });
  }

  /** Stubs the API and hands back the update callback the store deferred to it. */
  function captureTransitionCallback(): () => () => void {
    let captured: (() => void) | null = null;
    stubStartViewTransition((callback) => {
      captured = callback;
      return { ready: Promise.resolve(), finished: Promise.resolve() };
    });
    return () => {
      if (!captured) throw new Error("startViewTransition was never called");
      return captured;
    };
  }

  beforeEach(() => {
    flushPendingTheme();
    // jsdom ships no matchMedia, and prefersReducedMotion() treats its absence as
    // "reduce" — without this the crossfade would always take the fallback path.
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    document.body.dataset.reduceAnimations = "false";
    document.body.dataset.performanceMode = "false";

    useAppThemeStore.setState({
      selectedSchemeId: DEFAULT_APP_SCHEME_ID,
      customSchemes: [],
      colorVisionMode: "default",
      followSystem: false,
      accentColorOverride: null,
      recentSchemeIds: [],
    });
    injectSchemeToDOM(daintree, { immediate: true });
  });

  afterEach(() => {
    Reflect.deleteProperty(document, "startViewTransition");
    delete document.body.dataset.reduceAnimations;
    delete document.body.dataset.performanceMode;
    flushPendingTheme();
    vi.restoreAllMocks();
  });

  const canvasToken = () =>
    document.documentElement.style.getPropertyValue("--theme-surface-canvas");

  it("defers the DOM write to the next frame when crossfade is not requested", () => {
    useAppThemeStore.getState().setSelectedSchemeIdSilent("bondi");

    // State is synchronous, the DOM write is RAF-coalesced — hydration keeps this path.
    expect(useAppThemeStore.getState().selectedSchemeId).toBe("bondi");
    expect(canvasToken()).toBe(daintree.tokens["surface-canvas"]);

    flushPendingTheme();
    expect(canvasToken()).toBe(bondi.tokens["surface-canvas"]);
  });

  it("writes the DOM synchronously when crossfade falls back (no View Transition API)", () => {
    // jsdom exposes no startViewTransition, so the crossfade guard degrades to a
    // direct mutate — which must still apply immediately, not land a frame later.
    useAppThemeStore.getState().setSelectedSchemeIdSilent("bondi", { crossfade: true });

    expect(canvasToken()).toBe(bondi.tokens["surface-canvas"]);
  });

  it("routes the DOM write through the transition callback and applies it without a flush", () => {
    const transitionCallback = captureTransitionCallback();

    useAppThemeStore.getState().setSelectedSchemeIdSilent("bondi", { crossfade: true });

    // The mutation belongs to the transition — it must not have run yet.
    expect(useAppThemeStore.getState().selectedSchemeId).toBe("bondi");
    expect(canvasToken()).toBe(daintree.tokens["surface-canvas"]);

    transitionCallback()();

    // Applied synchronously inside the callback ({ immediate: true }); a RAF-coalesced
    // write here would be snapshotted by the API before it landed.
    expect(canvasToken()).toBe(bondi.tokens["surface-canvas"]);
    flushPendingTheme();
    expect(canvasToken()).toBe(bondi.tokens["surface-canvas"]);
  });

  it("does not record the crossfaded scheme in recentSchemeIds", () => {
    useAppThemeStore.getState().setSelectedSchemeId("svalbard");
    useAppThemeStore.getState().setSelectedSchemeIdSilent("bondi", { crossfade: true });

    // Crossfading is still a silent path — OS-driven changes are not user picks.
    expect(useAppThemeStore.getState().recentSchemeIds).toEqual(["svalbard"]);
  });

  it("does not start a transition when the scheme is already selected", () => {
    const startViewTransition = vi.fn(() => ({
      ready: Promise.resolve(),
      finished: Promise.resolve(),
    }));
    stubStartViewTransition(startViewTransition);

    // Desync the DOM from state (state is daintree) so a skipped injection is visible —
    // otherwise the DOM already holds the expected tokens and the test proves nothing.
    injectSchemeToDOM(bondi, { immediate: true });

    // The OS can re-announce the appearance it already reported. Fading between two
    // identical snapshots would be pointless — and would abort any in-flight transition.
    useAppThemeStore.getState().setSelectedSchemeIdSilent("daintree", { crossfade: true });

    expect(startViewTransition).not.toHaveBeenCalled();
    // Still reconciles, via the plain coalesced path rather than a transition.
    expect(canvasToken()).toBe(bondi.tokens["surface-canvas"]);
    flushPendingTheme();
    expect(canvasToken()).toBe(daintree.tokens["surface-canvas"]);
  });

  it("drops a crossfade superseded by a hover preview", () => {
    const transitionCallback = captureTransitionCallback();
    const svalbard = BUILT_IN_APP_SCHEMES.find((s) => s.id === "svalbard")!;

    // An OS change starts a crossfade, then the user hovers a theme card to preview it.
    useAppThemeStore.getState().setSelectedSchemeIdSilent("bondi", { crossfade: true });
    useAppThemeStore.getState().injectTheme(svalbard);

    transitionCallback()();

    // A preview never moves selectedSchemeId, so an identity check on it would miss this —
    // the stale fade would cancel the preview's RAF and repaint bondi over it.
    flushPendingTheme();
    expect(canvasToken()).toBe(svalbard.tokens["surface-canvas"]);
  });

  it("drops a superseded crossfade rather than clobbering the newer scheme", () => {
    const transitionCallback = captureTransitionCallback();

    // An OS appearance change starts a crossfade to bondi...
    useAppThemeStore.getState().setSelectedSchemeIdSilent("bondi", { crossfade: true });
    // ...but the user deliberately picks svalbard before the transition callback runs.
    useAppThemeStore.getState().setSelectedSchemeId("svalbard");

    transitionCallback()();

    // The stale callback must bail entirely: its `immediate` write would otherwise
    // cancel svalbard's pending RAF and leave the DOM on bondi while state says svalbard.
    const svalbard = BUILT_IN_APP_SCHEMES.find((s) => s.id === "svalbard")!;
    expect(useAppThemeStore.getState().selectedSchemeId).toBe("svalbard");
    flushPendingTheme();
    expect(canvasToken()).toBe(svalbard.tokens["surface-canvas"]);
  });
});
