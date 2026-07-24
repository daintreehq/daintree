import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { WorktreeRatioEntry } from "../twoPaneSplitStore";

/**
 * Cross-view write-merge coverage for the shared localStorage partition
 * (issue #11351). `ratioByWorktreeId` is keyed by worktree id, so a stale view
 * writing one worktree's ratio must not wipe a sibling worktree's ratio; the
 * `config` scalars defer to a sibling unless this writer changed them.
 */
describe("twoPaneSplitStore cross-view write merge (#11351)", () => {
  const STORAGE_KEY = "daintree-two-pane-split";
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

  type PersistedBlob = {
    version: number;
    state: {
      config: { enabled: boolean; defaultRatio: number; preferPreview: boolean };
      ratioByWorktreeId: Record<string, WorktreeRatioEntry>;
    };
  };

  const siblingRatio: WorktreeRatioEntry = { ratio: 0.7, panels: [null, null] };

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

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    restoreLocalStorage();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("a fresh view's ratio write preserves a sibling worktree's ratio and non-default config", async () => {
    const backing = installLocalStorage({});
    const { useTwoPaneSplitStore: store } = await import("../twoPaneSplitStore");

    backing.set(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: {
          config: { enabled: false, defaultRatio: 0.3, preferPreview: true },
          ratioByWorktreeId: { "wt-b": siblingRatio },
        },
      })
    );

    store.getState().setWorktreeRatio("wt-a", 0.6, ["p1", "p2"]);

    const written = readBlob(backing);
    expect(Object.keys(written.state.ratioByWorktreeId).sort()).toEqual(["wt-a", "wt-b"]);
    expect(written.state.ratioByWorktreeId["wt-b"]).toEqual(siblingRatio);
    expect(written.state.config).toEqual({
      enabled: false,
      defaultRatio: 0.3,
      preferPreview: true,
    });
  });

  it("independent config and ratio changes from two views both survive", async () => {
    const backing = installLocalStorage({});
    const { useTwoPaneSplitStore: store } = await import("../twoPaneSplitStore");

    store.getState().setWorktreeRatio("wt-a", 0.6, ["p1", "p2"]);

    // Sibling adds a worktree ratio and disables the split on disk.
    const disk = readBlob(backing);
    disk.state.ratioByWorktreeId["wt-b"] = siblingRatio;
    disk.state.config.enabled = false;
    backing.set(STORAGE_KEY, JSON.stringify(disk));

    // This stale view changes a different config field.
    store.getState().setPreferPreview(true);

    const written = readBlob(backing);
    expect(written.state.config.enabled).toBe(false); // sibling's change survived
    expect(written.state.config.preferPreview).toBe(true); // this view's change survived
    expect(Object.keys(written.state.ratioByWorktreeId).sort()).toEqual(["wt-a", "wt-b"]);
    expect(written.state.ratioByWorktreeId["wt-b"]).toEqual(siblingRatio);
  });

  it("does not resurrect a worktree ratio this view reset, and keeps a sibling's", async () => {
    const backing = installLocalStorage({});
    const { useTwoPaneSplitStore: store } = await import("../twoPaneSplitStore");

    store.getState().setWorktreeRatio("wt-a", 0.6, ["p1", "p2"]);

    const disk = readBlob(backing);
    disk.state.ratioByWorktreeId["wt-b"] = siblingRatio;
    backing.set(STORAGE_KEY, JSON.stringify(disk));

    store.getState().resetWorktreeRatio("wt-a");

    const written = readBlob(backing);
    expect(written.state.ratioByWorktreeId["wt-a"]).toBeUndefined();
    expect(written.state.ratioByWorktreeId["wt-b"]).toEqual(siblingRatio);
  });
});
