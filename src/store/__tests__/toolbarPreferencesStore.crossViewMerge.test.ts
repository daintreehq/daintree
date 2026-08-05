import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Cross-view write-merge coverage for the shared localStorage partition
 * (issue #11351). Focuses on the genuinely-mergeable persisted units: the
 * `pinnedButtons` map (per button id) and the launcher scalars. A stale project
 * view must not drop or resurrect a sibling view's plugin pin, nor revert a
 * sibling's launcher change.
 */
describe("toolbarPreferencesStore cross-view write merge (#11351)", () => {
  const STORAGE_KEY = "daintree-toolbar-preferences";
  const VERSION = 13;
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

  type Layout = {
    leftButtons: string[];
    rightButtons: string[];
    pinnedButtons: Record<string, boolean>;
  };
  type PersistedBlob = {
    version: number;
    state: {
      layout: Layout;
      launcher: { alwaysShowDevServer: boolean; defaultSelection?: string };
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

  function siblingBlob(overrides: Partial<PersistedBlob["state"]>): string {
    return JSON.stringify({
      version: VERSION,
      state: {
        layout: { leftButtons: [], rightButtons: [], pinnedButtons: {} },
        launcher: { alwaysShowDevServer: false, defaultSelection: undefined },
        ...overrides,
      },
    });
  }

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    restoreLocalStorage();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("a fresh view's pin toggle preserves a sibling's pin and non-default launcher", async () => {
    const backing = installLocalStorage({});
    const { useToolbarPreferencesStore: store } = await import("../toolbarPreferencesStore");

    // A sibling populated the shared blob before this fresh view writes.
    backing.set(
      STORAGE_KEY,
      siblingBlob({
        layout: { leftButtons: [], rightButtons: [], pinnedButtons: { "pluginX.btn": true } },
        launcher: { alwaysShowDevServer: true },
      })
    );

    store.getState().toggleButtonVisibility("voice-recording", "right");

    const written = readBlob(backing);
    expect(written.state.layout.pinnedButtons["voice-recording"]).toBe(false);
    expect(written.state.layout.pinnedButtons["pluginX.btn"]).toBe(true);
    expect(written.state.launcher.alwaysShowDevServer).toBe(true);
  });

  it("a stale view's pin write preserves a sibling's concurrent pin and launcher change", async () => {
    const backing = installLocalStorage({});
    const { useToolbarPreferencesStore: store } = await import("../toolbarPreferencesStore");

    // This view promotes plugin A.
    store.getState().setPluginButtonPromoted("pluginA.btn", true);

    // A sibling promotes plugin B and enables the dev-server launcher on disk.
    const disk = readBlob(backing);
    disk.state.layout.pinnedButtons["pluginB.btn"] = true;
    disk.state.launcher.alwaysShowDevServer = true;
    backing.set(STORAGE_KEY, JSON.stringify(disk));

    // This stale view — unaware of B — promotes plugin C.
    store.getState().setPluginButtonPromoted("pluginC.btn", true);

    const written = readBlob(backing);
    expect(written.state.layout.pinnedButtons).toMatchObject({
      "pluginA.btn": true,
      "pluginB.btn": true,
      "pluginC.btn": true,
    });
    expect(written.state.launcher.alwaysShowDevServer).toBe(true);
  });

  it("does not revert a sibling's file-browser opt-in from an untouched default (#11495, #11667)", async () => {
    // Originally this guarded the v12 seed: `file-browser` shipped hidden, so
    // every fresh view held a `false` nobody chose, and a null baseline
    // normalizing to `{}` made that untouched value read as this view's own edit.
    // v13 removed the seed, so a fresh view now holds no entry at all and there
    // is nothing to mistake for an edit — but the outcome the sibling depends on
    // is identical, so the case stays as the regression probe for it.
    const backing = installLocalStorage({});
    const { useToolbarPreferencesStore: store } = await import("../toolbarPreferencesStore");

    // The sibling made a real edit this view has never seen: an explicit hide.
    // Asserting against `{}` on both sides would pass even under a wholesale
    // overwrite, so the sibling has to hold something distinguishable.
    backing.set(
      STORAGE_KEY,
      siblingBlob({
        layout: { leftButtons: [], rightButtons: [], pinnedButtons: { "copy-tree": false } },
      })
    );

    // This view changes something unrelated and must not carry its own default over.
    store.getState().setAlwaysShowDevServer(true);

    const written = readBlob(backing);
    expect(written.state.layout.pinnedButtons["file-browser"]).toBeUndefined();
    // The sibling's untouched edit survives this view's unrelated write.
    expect(written.state.layout.pinnedButtons["copy-tree"]).toBe(false);
    expect(written.state.launcher.alwaysShowDevServer).toBe(true);
  });

  it("preserves a sibling's panel promotion when a stale view writes something unrelated (#11667)", async () => {
    // Array orderings reconcile last-writer-wins, so this view's write DOES
    // replace the sibling's side arrays and drop the promoted position. The
    // explicit `true` is what has to survive — `restorePromotedPanelButtons`
    // rebuilds the position from it on the next hydration. Without the pin entry
    // the promotion would be gone with nothing left to reconstruct it from.
    const backing = installLocalStorage({});
    const { useToolbarPreferencesStore: store } = await import("../toolbarPreferencesStore");

    backing.set(
      STORAGE_KEY,
      siblingBlob({
        layout: {
          leftButtons: ["terminal", "browser", "panel-tray"],
          rightButtons: [],
          pinnedButtons: { browser: true },
        },
      })
    );

    store.getState().setAlwaysShowDevServer(true);

    const written = readBlob(backing);
    expect(written.state.layout.pinnedButtons["browser"]).toBe(true);
    expect(written.state.launcher.alwaysShowDevServer).toBe(true);
  });

  it("still writes its own explicit file-browser hide over a sibling's opt-in", async () => {
    // The mirror of the case above: when the user in THIS view actually turns the
    // button off, that is a real edit and must win. Distinguishing the two is the
    // whole point of separating "no stored map" from "an explicitly empty one".
    const backing = installLocalStorage({});
    const { useToolbarPreferencesStore: store } = await import("../toolbarPreferencesStore");

    // Since v13 the store already starts in the shown state with no pin entry
    // (#11667), so the single toggle below IS the departure from it. Before v13
    // this needed a priming toggle first to clear the shipped `false` seed.
    expect(store.getState().layout.pinnedButtons["file-browser"]).toBeUndefined();

    backing.set(
      STORAGE_KEY,
      siblingBlob({ layout: { leftButtons: [], rightButtons: [], pinnedButtons: {} } })
    );

    store.getState().toggleButtonVisibility("file-browser", "left");

    expect(readBlob(backing).state.layout.pinnedButtons["file-browser"]).toBe(false);
  });

  it("does not resurrect a pin a sibling deleted that this view still holds unchanged", async () => {
    const backing = installLocalStorage({
      [STORAGE_KEY]: JSON.stringify({
        version: VERSION,
        state: {
          layout: {
            leftButtons: [],
            rightButtons: [],
            pinnedButtons: { "pluginA.btn": true, "pluginB.btn": true },
          },
          launcher: { alwaysShowDevServer: false },
        },
      }),
    });
    const { useToolbarPreferencesStore: store } = await import("../toolbarPreferencesStore");

    // A sibling demotes (deletes) plugin B on disk.
    const disk = readBlob(backing);
    delete disk.state.layout.pinnedButtons["pluginB.btn"];
    backing.set(STORAGE_KEY, JSON.stringify(disk));

    // An unrelated write from this (stale, still-holds-B) view must not resurrect B.
    store.getState().setAlwaysShowDevServer(true);

    const written = readBlob(backing);
    expect(written.state.layout.pinnedButtons["pluginA.btn"]).toBe(true);
    expect("pluginB.btn" in written.state.layout.pinnedButtons).toBe(false);
    expect(written.state.launcher.alwaysShowDevServer).toBe(true);
  });
});
