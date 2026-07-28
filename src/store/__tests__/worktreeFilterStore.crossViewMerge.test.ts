import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Cross-view write-merge coverage for the shared localStorage partition
 * (issue #11351). Only the GLOBAL prefs sub-store (`daintree-worktree-filters`)
 * needs the merge: its five fields share one literal key across views. The
 * per-project sub-store (`daintree-worktree-filters:{projectId}`) is exempt — its
 * key already embeds the project id — and must stay untouched by a global write.
 */
describe("worktreeFilterStore cross-view write merge (#11351)", () => {
  const GLOBAL_KEY = "daintree-worktree-filters";
  // jsdom resolves no projectId → the per-project store keys off "default".
  const PROJECT_KEY = "daintree-worktree-filters:default";
  const VERSION = 1;
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

  function readGlobal(backing: Map<string, string>): PersistedBlob {
    const blob: PersistedBlob = JSON.parse(backing.get(GLOBAL_KEY)!);
    return blob;
  }

  beforeEach(() => {
    vi.resetModules();
    // The per-project sub-store is debounced; the global sub-store is synchronous
    // and unaffected by fake timers.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreLocalStorage();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("a fresh view's orderBy change preserves a sibling's non-default global pref", async () => {
    const backing = installLocalStorage({});
    const { useWorktreeFilterStore: store } = await import("../worktreeFilterStore");

    backing.set(
      GLOBAL_KEY,
      JSON.stringify({
        version: VERSION,
        state: {
          orderBy: "created",
          groupByType: false,
          alwaysShowActive: false,
          alwaysShowWaiting: true,
          hideMainWorktree: false,
        },
      })
    );

    store.getState().setOrderBy("alpha");

    const written = readGlobal(backing);
    expect(written.state.orderBy).toBe("alpha"); // this view's change
    expect(written.state.alwaysShowActive).toBe(false); // sibling's non-default survived
  });

  it("independent global pref changes both survive and the project key stays untouched", async () => {
    const backing = installLocalStorage({});
    const { useWorktreeFilterStore: store } = await import("../worktreeFilterStore");

    store.getState().setAlwaysShowActive(false);

    // Sibling hides the main worktree on disk.
    const disk = readGlobal(backing);
    disk.state.hideMainWorktree = true;
    backing.set(GLOBAL_KEY, JSON.stringify(disk));

    const projectKeyBefore = backing.get(PROJECT_KEY) ?? null;

    store.getState().setAlwaysShowWaiting(false);

    const written = readGlobal(backing);
    expect(written.state.alwaysShowWaiting).toBe(false); // this view's change
    expect(written.state.hideMainWorktree).toBe(true); // sibling's change survived
    expect(written.state.alwaysShowActive).toBe(false);
    // The per-project store keys off its own project-scoped key — a global write
    // must not touch it.
    expect(backing.get(PROJECT_KEY) ?? null).toBe(projectKeyBefore);
  });

  it("normalizes an invalid manual + groupByType combination produced by a merge", async () => {
    const backing = installLocalStorage({});
    const { useWorktreeFilterStore: store } = await import("../worktreeFilterStore");

    // A sibling left `manual` ordering (valid while not grouping) plus a
    // non-default `alwaysShowActive` on disk.
    backing.set(
      GLOBAL_KEY,
      JSON.stringify({
        version: VERSION,
        state: {
          orderBy: "manual",
          groupByType: false,
          alwaysShowActive: false,
          alwaysShowWaiting: true,
          hideMainWorktree: false,
        },
      })
    );

    // This view enables grouping (its own orderBy is the default "created"). The
    // merge pulls in the sibling's `manual` order, recombining it with grouping —
    // an invalid pair the reconciler must normalize back to "created".
    store.getState().setGroupByType(true);

    const written = readGlobal(backing);
    expect(written.state.groupByType).toBe(true);
    expect(written.state.orderBy).toBe("created");
    // Proves the merge ran (without it, this view would rewrite the default true).
    expect(written.state.alwaysShowActive).toBe(false);
  });

  it("a stale same-project window's filter write preserves a sibling window's pin", async () => {
    const backing = installLocalStorage({});
    const { useWorktreeFilterStore: store } = await import("../worktreeFilterStore");
    vi.advanceTimersByTime(400); // drain any hydration write on the debounced project store

    // A sibling window on the SAME project (which shares the per-project key)
    // pinned a worktree.
    backing.set(
      PROJECT_KEY,
      JSON.stringify({
        version: 2,
        state: {
          query: "",
          statusFilters: [],
          typeFilters: [],
          prIssueFilters: [],
          sessionFilters: [],
          activityFilters: [],
          pinnedWorktrees: ["wt-1"],
          collapsedWorktrees: [],
          manualOrder: [],
        },
      })
    );

    // This stale window (never saw the pin) changes its filter query.
    store.getState().setQuery("needle");
    vi.advanceTimersByTime(400);

    const projectBlob: { version: number; state: { pinnedWorktrees: string[]; query: string } } =
      JSON.parse(backing.get(PROJECT_KEY)!);
    expect(projectBlob.state.pinnedWorktrees).toEqual(["wt-1"]); // sibling's pin survived
    expect(projectBlob.state.query).toBe("needle"); // this window's change applied
  });
});
