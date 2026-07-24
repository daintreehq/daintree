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
  const VERSION = 13;
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

  type PersistedBlob = { version: number; state: Record<string, unknown> };

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

  function recipeMap(blob: PersistedBlob): Record<string, unknown> {
    return blob.state.lastSelectedWorktreeRecipeIdByProject as Record<string, unknown>;
  }

  function skipMap(blob: PersistedBlob): Record<string, unknown> {
    return blob.state.skipPushConfirmByWorktreePath as Record<string, unknown>;
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

    backing.set(
      STORAGE_KEY,
      JSON.stringify({
        version: VERSION,
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

  it("independent map and scalar changes from two views both survive", async () => {
    const backing = installLocalStorage({});
    const { usePreferencesStore: store } = await import("../preferencesStore");

    store.getState().setSkipPushConfirmForWorktree("/path-a", true);

    // Sibling opts out of push-confirm for another worktree and enables reduce-motion.
    const disk = readBlob(backing);
    (disk.state.skipPushConfirmByWorktreePath as Record<string, boolean>)["/path-b"] = true;
    disk.state.reduceAnimations = true;
    backing.set(STORAGE_KEY, JSON.stringify(disk));

    // This stale view changes a different scalar.
    store.getState().setDockDensity("compact");

    const written = readBlob(backing);
    expect(skipMap(written)).toEqual({ "/path-a": true, "/path-b": true });
    expect(written.state.dockDensity).toBe("compact"); // this view's change survived
    expect(written.state.reduceAnimations).toBe(true); // sibling's change survived
  });

  it("does not resurrect a recipe entry this view cleared, and keeps a sibling's", async () => {
    const backing = installLocalStorage({});
    const { usePreferencesStore: store } = await import("../preferencesStore");

    store.getState().setLastSelectedWorktreeRecipeIdByProject("proj-a", "recipe-a");

    const disk = readBlob(backing);
    (disk.state.lastSelectedWorktreeRecipeIdByProject as Record<string, unknown>)["proj-b"] =
      "recipe-b";
    backing.set(STORAGE_KEY, JSON.stringify(disk));

    // Clearing proj-a (undefined) is a deletion — it must not resurrect on merge.
    store.getState().setLastSelectedWorktreeRecipeIdByProject("proj-a", undefined);

    const written = readBlob(backing);
    expect("proj-a" in recipeMap(written)).toBe(false);
    expect(recipeMap(written)["proj-b"]).toBe("recipe-b");
  });
});
