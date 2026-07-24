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
  const VERSION = 11;
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
    return JSON.parse(backing.get(STORAGE_KEY)!) as PersistedBlob;
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
