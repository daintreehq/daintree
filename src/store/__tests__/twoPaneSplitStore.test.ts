import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTwoPaneSplitStore, resolveEffectiveRatio } from "../twoPaneSplitStore";
import type { WorktreeRatioEntry } from "../twoPaneSplitStore";

function entry(
  ratio: number,
  panels: [string | null, string | null] = [null, null]
): WorktreeRatioEntry {
  return { ratio, panels };
}

describe("twoPaneSplitStore", () => {
  beforeEach(() => {
    useTwoPaneSplitStore.setState({
      config: { enabled: true, defaultRatio: 0.5, preferPreview: false },
      ratioByWorktreeId: {},
    });
  });

  describe("commitRatioIfChanged", () => {
    it("does not update store when ratio and panels are unchanged", () => {
      useTwoPaneSplitStore.setState({ ratioByWorktreeId: { wt1: entry(0.7, ["a", "b"]) } });
      const before = useTwoPaneSplitStore.getState().ratioByWorktreeId;
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.7, ["a", "b"]);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId).toBe(before);
    });

    it("updates when panels change even if ratio is the same", () => {
      useTwoPaneSplitStore.setState({ ratioByWorktreeId: { wt1: entry(0.7, ["a", "b"]) } });
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.7, ["b", "a"]);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toEqual(
        entry(0.7, ["b", "a"])
      );
    });

    it("no-ops when pendingRatio is null", () => {
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", null, ["a", "b"]);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toBeUndefined();
    });

    it("clamps ratio to [0.2, 0.8]", () => {
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.95, ["a", "b"]);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toEqual(
        entry(0.8, ["a", "b"])
      );

      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.05, ["a", "b"]);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toEqual(
        entry(0.2, ["a", "b"])
      );
    });

    it("no-ops when out-of-range value clamps to the already-stored value", () => {
      useTwoPaneSplitStore.setState({ ratioByWorktreeId: { wt1: entry(0.8, ["a", "b"]) } });
      const before = useTwoPaneSplitStore.getState().ratioByWorktreeId;
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.95, ["a", "b"]);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId).toBe(before);
    });
  });

  describe("no-op persistence invariants (relevant to issue #2638 transition)", () => {
    it("a non-null commit overwrites the previous stored ratio", () => {
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.5, ["a", "b"]);
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.7, ["a", "b"]);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toEqual(
        entry(0.7, ["a", "b"])
      );

      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", null, ["a", "b"]);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toEqual(
        entry(0.7, ["a", "b"])
      );
    });

    it("does not affect other worktrees when one worktree commits null", () => {
      useTwoPaneSplitStore.setState({
        ratioByWorktreeId: { wt1: entry(0.65, ["a", "b"]), wt2: entry(0.4, ["c", "d"]) },
      });

      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", null, ["a", "b"]);

      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt2"]).toEqual(
        entry(0.4, ["c", "d"])
      );
    });
  });

  describe("setWorktreeRatio", () => {
    it("always writes the clamped value with panels", () => {
      useTwoPaneSplitStore.setState({ ratioByWorktreeId: { wt1: entry(0.7, ["a", "b"]) } });
      const before = useTwoPaneSplitStore.getState().ratioByWorktreeId;

      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt1", 0.7, ["a", "b"]);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId).toBe(before);

      useTwoPaneSplitStore.getState().setWorktreeRatio("wt1", 0.7, ["a", "b"]);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId).not.toBe(before);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toEqual(
        entry(0.7, ["a", "b"])
      );
    });

    it("clamps the value to [0.2, 0.8]", () => {
      useTwoPaneSplitStore.getState().setWorktreeRatio("wt1", 0.1, ["a", "b"]);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]?.ratio).toBe(0.2);

      useTwoPaneSplitStore.getState().setWorktreeRatio("wt1", 0.9, ["a", "b"]);
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]?.ratio).toBe(0.8);
    });
  });

  describe("resetWorktreeRatio", () => {
    it("removes the ratio for a specific worktree", () => {
      useTwoPaneSplitStore.setState({
        ratioByWorktreeId: { wt1: entry(0.65, ["a", "b"]), wt2: entry(0.4, ["c", "d"]) },
      });

      useTwoPaneSplitStore.getState().resetWorktreeRatio("wt1");

      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt1"]).toBeUndefined();
      expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt2"]).toEqual(
        entry(0.4, ["c", "d"])
      );
    });
  });

  describe("getWorktreeRatio", () => {
    it("returns stored ratio when available", () => {
      useTwoPaneSplitStore.setState({ ratioByWorktreeId: { wt1: entry(0.65, ["a", "b"]) } });
      expect(useTwoPaneSplitStore.getState().getWorktreeRatio("wt1")).toBe(0.65);
    });

    it("returns defaultRatio when no stored ratio", () => {
      expect(useTwoPaneSplitStore.getState().getWorktreeRatio("wt-unknown")).toBe(0.5);
    });

    it("returns defaultRatio for null worktreeId", () => {
      expect(useTwoPaneSplitStore.getState().getWorktreeRatio(null)).toBe(0.5);
    });
  });
});

describe("resolveEffectiveRatio", () => {
  it("returns undefined when entry is undefined", () => {
    expect(resolveEffectiveRatio(undefined, "a", "b")).toBeUndefined();
  });

  it("returns raw ratio when stored panels match current order", () => {
    expect(resolveEffectiveRatio(entry(0.35, ["a", "b"]), "a", "b")).toBe(0.35);
  });

  it("inverts ratio when stored panels are exact reverse of current", () => {
    expect(resolveEffectiveRatio(entry(0.35, ["a", "b"]), "b", "a")).toBe(0.65);
  });

  it("returns raw ratio when stored panels are null (legacy migration)", () => {
    expect(resolveEffectiveRatio(entry(0.35, [null, null]), "b", "a")).toBe(0.35);
  });

  it("returns undefined when only left panel is null (partial-null)", () => {
    expect(resolveEffectiveRatio(entry(0.35, [null, "b"]), "b", "a")).toBeUndefined();
  });

  it("returns undefined when panels are completely different (stale IDs)", () => {
    expect(resolveEffectiveRatio(entry(0.35, ["x", "y"]), "a", "b")).toBeUndefined();
  });

  it("returns undefined when only one panel matches (partial match)", () => {
    expect(resolveEffectiveRatio(entry(0.35, ["a", "x"]), "b", "a")).toBeUndefined();
  });

  it("returns undefined when one panel is replaced (partial ID reuse)", () => {
    expect(resolveEffectiveRatio(entry(0.6, ["a", "b"]), "a", "c")).toBeUndefined();
  });
});

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
