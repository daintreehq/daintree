import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Cross-view write-merge coverage for the shared localStorage partition
 * (issue #11351). The two id-keyed maps are the primary victims —
 * `lastSelectedWorktreeRecipeIdByProject` (per project) and
 * `skipPushConfirmByWorktreePath` (per worktree path). A stale view must not wipe
 * a sibling's map entries, and every scalar defers to a sibling unless changed.
 */
describe("preferencesStore cross-view write merge (#11351)", () => {
  const STORAGE_KEY = "daintree-preferences";
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

  type PersistedBlob = {
    version: number;
    state: {
      lastSelectedWorktreeRecipeIdByProject?: Record<string, string | null | undefined>;
      skipPushConfirmByWorktreePath?: Record<string, boolean>;
      showProjectPulse?: boolean;
      reduceAnimations?: boolean;
      dockDensity?: string;
      hasSeenActionPalettePrefixHint?: boolean;
      keyboardLayoutConfirmationsByBinding?: Record<string, number>;
      [key: string]: unknown;
    };
  };

  function installLocalStorage(initial: Record<string, string>): Map<string, string> {
    const backing = new Map<string, string>(Object.entries(initial));
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (key: string) => backing.get(key) ?? null,
        setItem: (key: string, value: string) => {
          backing.set(key, value);
        },
        removeItem: (key: string) => {
          backing.delete(key);
        },
      },
      configurable: true,
      writable: true,
    });
    return backing;
  }

  function restoreLocalStorage(): void {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, "localStorage", originalDescriptor);
      return;
    }
    delete (globalThis as Partial<typeof globalThis>).localStorage;
  }

  function readBlob(backing: Map<string, string>): PersistedBlob {
    const blob: PersistedBlob = JSON.parse(backing.get(STORAGE_KEY)!);
    return blob;
  }

  function recipeMap(blob: PersistedBlob): Record<string, string | null | undefined> {
    return blob.state.lastSelectedWorktreeRecipeIdByProject ?? {};
  }

  function skipMap(blob: PersistedBlob): Record<string, boolean> {
    return blob.state.skipPushConfirmByWorktreePath ?? {};
  }

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    restoreLocalStorage();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("a fresh view's recipe write preserves a sibling project's recipe and non-default scalar", async () => {
    const backing = installLocalStorage({});
    const { usePreferencesStore: store } = await import("../preferencesStore");

    // Read from the store rather than pinning a literal: the merge SKIPS
    // reconciliation when the on-disk version differs, so a stale fixture
    // silently stops testing the merge instead of failing loudly.
    backing.set(
      STORAGE_KEY,
      JSON.stringify({
        version: store.persist.getOptions().version,
        state: {
          lastSelectedWorktreeRecipeIdByProject: { "proj-b": "recipe-b" },
          showProjectPulse: false,
        },
      })
    );

    store.getState().setLastSelectedWorktreeRecipeIdByProject("proj-a", "recipe-a");

    const written = readBlob(backing);
    expect(recipeMap(written)).toEqual({ "proj-a": "recipe-a", "proj-b": "recipe-b" });
    expect(written.state.showProjectPulse).toBe(false);
  });

  it("a sibling's explicit wrap `false` survives a write from a view still on auto", async () => {
    // `diffWrapLines` is the one tri-state scalar here (#12170). `null` is a
    // real value, not an absent one, so the merge has to tell "this view never
    // touched it" from "this view set it to false" — a falsy-coercing or
    // null-skipping comparison would resurrect auto and re-wrap every prose
    // diff the sibling had deliberately unwrapped.
    const backing = installLocalStorage({});
    const { usePreferencesStore: store } = await import("../preferencesStore");
    expect(store.getState().diffWrapLines).toBeNull();

    backing.set(
      STORAGE_KEY,
      JSON.stringify({
        version: store.persist.getOptions().version,
        state: { diffWrapLines: false },
      })
    );

    // This view changes something unrelated while its own baseline is auto.
    store.getState().setDockDensity("compact");

    const written = readBlob(backing);
    expect(written.state.diffWrapLines).toBe(false);
    expect(written.state.dockDensity).toBe("compact");
  });

  it("this view's explicit wrap choice beats a sibling's on-disk value", async () => {
    const backing = installLocalStorage({});
    const { usePreferencesStore: store } = await import("../preferencesStore");

    backing.set(
      STORAGE_KEY,
      JSON.stringify({
        version: store.persist.getOptions().version,
        state: { diffWrapLines: true },
      })
    );

    store.getState().setDiffWrapLines(false);

    expect(readBlob(backing).state.diffWrapLines).toBe(false);
  });

  it("independent map and scalar changes from two views both survive", async () => {
    const backing = installLocalStorage({});
    const { usePreferencesStore: store } = await import("../preferencesStore");

    store.getState().setSkipPushConfirmForWorktree("/path-a", true);

    // Sibling opts out of push-confirm for another worktree and enables reduce-motion.
    const disk = readBlob(backing);
    const skip = disk.state.skipPushConfirmByWorktreePath ?? {};
    skip["/path-b"] = true;
    disk.state.skipPushConfirmByWorktreePath = skip;
    disk.state.reduceAnimations = true;
    backing.set(STORAGE_KEY, JSON.stringify(disk));

    // This stale view changes a different scalar.
    store.getState().setDockDensity("compact");

    const written = readBlob(backing);
    expect(skipMap(written)).toEqual({ "/path-a": true, "/path-b": true });
    expect(written.state.dockDensity).toBe("compact"); // this view's change survived
    expect(written.state.reduceAnimations).toBe(true); // sibling's change survived
  });

  // Dropping this field from the merge would let a stale view resurrect a
  // tally the user just cleared with Undo, silencing the notice they were
  // still relying on (#11704).
  it("keeps a sibling's shortcut confirmation and carries an Undo deletion through", async () => {
    const backing = installLocalStorage({});
    const { usePreferencesStore: store } = await import("../preferencesStore");

    store.getState().recordKeyboardLayoutConfirmation("nav.toggleSidebar", "Cmd+B");

    // Sibling view confirms a different shortcut.
    const disk = readBlob(backing);
    const confirmations = disk.state.keyboardLayoutConfirmationsByBinding ?? {};
    confirmations["nav.toggleFocusMode@Cmd+K"] = 2;
    disk.state.keyboardLayoutConfirmationsByBinding = confirmations;
    backing.set(STORAGE_KEY, JSON.stringify(disk));

    // This view's user reaches for Undo, which clears only its own entry.
    store.getState().clearKeyboardLayoutConfirmations("nav.toggleSidebar");

    const written = readBlob(backing);
    expect(written.state.keyboardLayoutConfirmationsByBinding).toEqual({
      "nav.toggleFocusMode@Cmd+K": 2,
    });
  });

  // A stale view incrementing the SAME binding is the case last-writer-wins
  // gets wrong: writing its own 2 over a sibling's 3 would hand back an
  // allowance the user already spent, and the notice would return (#11704).
  it("never lowers a sibling's confirmation count for the same binding", async () => {
    const backing = installLocalStorage({});
    const { usePreferencesStore: store } = await import("../preferencesStore");

    // This view hydrated at 1.
    store.getState().recordKeyboardLayoutConfirmation("nav.toggleSidebar", "Cmd+B");

    // A sibling view raced ahead to the limit.
    const disk = readBlob(backing);
    disk.state.keyboardLayoutConfirmationsByBinding = { "nav.toggleSidebar@Cmd+B": 3 };
    backing.set(STORAGE_KEY, JSON.stringify(disk));

    // This view, still holding 1, records again.
    store.getState().recordKeyboardLayoutConfirmation("nav.toggleSidebar", "Cmd+B");

    const written = readBlob(backing);
    expect(written.state.keyboardLayoutConfirmationsByBinding).toEqual({
      "nav.toggleSidebar@Cmd+B": 3,
    });
  });

  // Taking the higher count unconditionally would resurrect a tally another
  // view had just cleared, permanently silencing a notice the user asked for.
  it("does not resurrect a sibling's Undo when writing an unrelated preference", async () => {
    const backing = installLocalStorage({});
    const { usePreferencesStore: store } = await import("../preferencesStore");

    store.getState().recordKeyboardLayoutConfirmation("nav.toggleSidebar", "Cmd+B");

    // A sibling view's user clicked Undo, clearing the key on disk.
    const disk = readBlob(backing);
    disk.state.keyboardLayoutConfirmationsByBinding = {};
    backing.set(STORAGE_KEY, JSON.stringify(disk));

    // This view still holds the tally, and writes something else entirely.
    store.getState().setDockDensity("compact");

    const written = readBlob(backing);
    expect(written.state.keyboardLayoutConfirmationsByBinding).toEqual({});
  });

  it("lets Undo clear a binding even when a sibling raced its count higher", async () => {
    const backing = installLocalStorage({});
    const { usePreferencesStore: store } = await import("../preferencesStore");

    store.getState().recordKeyboardLayoutConfirmation("nav.toggleSidebar", "Cmd+B");

    const disk = readBlob(backing);
    disk.state.keyboardLayoutConfirmationsByBinding = { "nav.toggleSidebar@Cmd+B": 3 };
    backing.set(STORAGE_KEY, JSON.stringify(disk));

    // The user here was surprised, so the notice must come back for them.
    store.getState().clearKeyboardLayoutConfirmations("nav.toggleSidebar");

    const written = readBlob(backing);
    expect(written.state.keyboardLayoutConfirmationsByBinding).toEqual({});
  });

  // The generic scalar tests above pass even if this specific field is dropped
  // from the merge, which would silently make the sort mode the one preference
  // a stale sibling view can clobber (#11455).
  it("keeps a sibling's sort mode when this view changes an unrelated scalar", async () => {
    const backing = installLocalStorage({});
    const { usePreferencesStore: store } = await import("../preferencesStore");

    store.getState().setDockDensity("normal");

    const disk = readBlob(backing);
    disk.state.projectSwitcherOtherSortMode = "recent";
    backing.set(STORAGE_KEY, JSON.stringify(disk));

    store.getState().setDockDensity("compact");

    const written = readBlob(backing);
    expect(written.state.projectSwitcherOtherSortMode).toBe("recent");
    expect(written.state.dockDensity).toBe("compact");
  });

  it("keeps a sibling's folded band when this view folds a different one", async () => {
    // Per-key, not whole-field: two project views each fold the bands they read
    // past, and a whole-map write from either would take the other's fold with
    // it. This is the failure `mergeRecordByWriterDelta` exists to prevent.
    const backing = installLocalStorage({});
    const { usePreferencesStore: store } = await import("../preferencesStore");

    store.getState().setDockDensity("normal");

    const disk = readBlob(backing);
    disk.state.projectSwitcherCollapsedBands = { running: true };
    backing.set(STORAGE_KEY, JSON.stringify(disk));

    store.getState().setProjectSwitcherBandCollapsed("other", true);

    const written = readBlob(backing);
    expect(written.state.projectSwitcherCollapsedBands).toEqual({ running: true, other: true });
  });

  it("does not resurrect a band this view unfolded, and keeps a sibling's", async () => {
    // An unfolded band is stored as `false`, not deleted, so "this view unfolded
    // it" and "this view never touched it" stay distinguishable to the merge.
    const backing = installLocalStorage({});
    const { usePreferencesStore: store } = await import("../preferencesStore");

    store.getState().setProjectSwitcherBandCollapsed("other", true);

    const disk = readBlob(backing);
    disk.state.projectSwitcherCollapsedBands = { other: true, pinned: true };
    backing.set(STORAGE_KEY, JSON.stringify(disk));

    store.getState().setProjectSwitcherBandCollapsed("other", false);

    const written = readBlob(backing);
    expect(written.state.projectSwitcherCollapsedBands).toEqual({ other: false, pinned: true });
  });

  it("does not write a stale copy of a band a sibling has since unfolded", async () => {
    // The one a two-way `{ ...onDisk, ...incoming }` merge would fail: this
    // view still holds `running: true` from hydration, so folding an unrelated
    // band carries that stale value along and would undo the sibling's unfold.
    const backing = installLocalStorage({});
    const { usePreferencesStore: store } = await import("../preferencesStore");

    store.getState().setProjectSwitcherBandCollapsed("running", true);

    const disk = readBlob(backing);
    disk.state.projectSwitcherCollapsedBands = { running: false };
    backing.set(STORAGE_KEY, JSON.stringify(disk));

    store.getState().setProjectSwitcherBandCollapsed("other", true);

    const written = readBlob(backing);
    expect(written.state.projectSwitcherCollapsedBands).toEqual({ running: false, other: true });
  });

  it("keeps a sibling's fold through an unrelated preference write", async () => {
    const backing = installLocalStorage({});
    const { usePreferencesStore: store } = await import("../preferencesStore");

    store.getState().setDockDensity("normal");

    const disk = readBlob(backing);
    disk.state.projectSwitcherCollapsedBands = { scratch: false };
    backing.set(STORAGE_KEY, JSON.stringify(disk));

    store.getState().setReduceAnimations(true);

    const written = readBlob(backing);
    expect(written.state.projectSwitcherCollapsedBands).toEqual({ scratch: false });
    expect(written.state.reduceAnimations).toBe(true);
  });

  it("keeps this view's sort mode when a sibling changes an unrelated scalar", async () => {
    const backing = installLocalStorage({});
    const { usePreferencesStore: store } = await import("../preferencesStore");

    store.getState().setDockDensity("normal");

    const disk = readBlob(backing);
    disk.state.reduceAnimations = true;
    backing.set(STORAGE_KEY, JSON.stringify(disk));

    store.getState().setProjectSwitcherOtherSortMode("alphabetical");

    const written = readBlob(backing);
    expect(written.state.projectSwitcherOtherSortMode).toBe("alphabetical");
    expect(written.state.reduceAnimations).toBe(true);
  });

  // Disk convergence only. Like every other field here, a sibling's live state
  // is not pushed across views — an already-hydrated view can still show the
  // hint once before it reloads. What must not happen is that view's write
  // erasing the record, sending the hint back to every view on next launch.
  // The reading size is one global value shared by every project view, so a
  // stale view writing any other preference must not hand it back (#12134).
  it("keeps a sibling's reading size through an unrelated preference write", async () => {
    const backing = installLocalStorage({});
    const { usePreferencesStore: store } = await import("../preferencesStore");

    store.getState().setDockDensity("compact");

    const disk = readBlob(backing);
    disk.state.markdownFontSize = "2xl";
    backing.set(STORAGE_KEY, JSON.stringify(disk));

    store.getState().setShowProjectPulse(false);

    const written = readBlob(backing);
    expect(written.state.markdownFontSize).toBe("2xl");
    expect(written.state.showProjectPulse).toBe(false);
  });

  it("carries this view's reading size while keeping a sibling's unrelated scalar", async () => {
    const backing = installLocalStorage({});
    const { usePreferencesStore: store } = await import("../preferencesStore");

    store.getState().setDockDensity("compact");

    const disk = readBlob(backing);
    disk.state.reduceAnimations = true;
    backing.set(STORAGE_KEY, JSON.stringify(disk));

    store.getState().setMarkdownFontSize("lg");

    const written = readBlob(backing);
    expect(written.state.markdownFontSize).toBe("lg");
    expect(written.state.reduceAnimations).toBe(true);
  });

  it("keeps a sibling's spent prefix hint on disk through an unrelated write", async () => {
    const backing = installLocalStorage({});
    const { usePreferencesStore: store } = await import("../preferencesStore");

    store.getState().setDockDensity("normal");

    // Another project view showed the hint and retired it.
    const disk = readBlob(backing);
    disk.state.hasSeenActionPalettePrefixHint = true;
    backing.set(STORAGE_KEY, JSON.stringify(disk));

    // This view still holds the pre-hydration `false`. Without the writer-delta
    // guard its unrelated write would hand the user the hint a second time.
    store.getState().setDockDensity("compact");

    const written = readBlob(backing);
    expect(written.state.hasSeenActionPalettePrefixHint).toBe(true);
    expect(written.state.dockDensity).toBe("compact");
  });

  it("does not resurrect a recipe entry this view cleared, and keeps a sibling's", async () => {
    const backing = installLocalStorage({});
    const { usePreferencesStore: store } = await import("../preferencesStore");

    store.getState().setLastSelectedWorktreeRecipeIdByProject("proj-a", "recipe-a");

    const disk = readBlob(backing);
    const recipes = disk.state.lastSelectedWorktreeRecipeIdByProject ?? {};
    recipes["proj-b"] = "recipe-b";
    disk.state.lastSelectedWorktreeRecipeIdByProject = recipes;
    backing.set(STORAGE_KEY, JSON.stringify(disk));

    // Clearing proj-a (undefined) is a deletion — it must not resurrect on merge.
    store.getState().setLastSelectedWorktreeRecipeIdByProject("proj-a", undefined);

    const written = readBlob(backing);
    expect("proj-a" in recipeMap(written)).toBe(false);
    expect(recipeMap(written)["proj-b"]).toBe("recipe-b");
  });
});
