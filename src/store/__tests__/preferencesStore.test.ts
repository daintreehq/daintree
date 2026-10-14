// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetPersistedStoreRegistryForTests } from "../persistence/persistedStoreRegistry";

const STORAGE_KEY = "daintree-preferences";

let storage: Record<string, string> = {};

const storageMock = {
  getItem: (key: string) => storage[key] ?? null,
  setItem: (key: string, value: string) => {
    storage[key] = value;
  },
  removeItem: (key: string) => {
    delete storage[key];
  },
  clear: () => {
    storage = {};
  },
  get length() {
    return Object.keys(storage).length;
  },
  key: (index: number) => Object.keys(storage)[index] ?? null,
};

function installStorageMock() {
  Object.defineProperty(globalThis, "localStorage", {
    value: storageMock,
    configurable: true,
    writable: true,
  });
}

function setStoredState(state: Record<string, unknown>, version: number) {
  storageMock.setItem(STORAGE_KEY, JSON.stringify({ state, version }));
}

async function loadStore() {
  const mod = await import("../preferencesStore");
  const store = mod.usePreferencesStore;
  await vi.waitFor(() => {
    expect(store.getState().dockDensity).toBeDefined();
  });
  return store;
}

describe("preferencesStore migration", () => {
  beforeEach(() => {
    vi.resetModules();
    storage = {};
    installStorageMock();
    _resetPersistedStoreRegistryForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("remembers the new-worktree agent per project and drops malformed entries on hydration", async () => {
    setStoredState(
      {
        lastSelectedWorktreeAgentIdByProject: { "proj-1": "claude", "proj-2": null, bad: 42 },
      },
      20
    );
    const store = await loadStore();
    expect(store.getState().lastSelectedWorktreeAgentIdByProject).toEqual({
      "proj-1": "claude",
      "proj-2": null,
    });

    store.getState().setLastSelectedWorktreeAgentIdByProject("proj-3", "codex");
    expect(store.getState().lastSelectedWorktreeAgentIdByProject["proj-3"]).toBe("codex");
    expect(store.getState().lastSelectedWorktreeAgentIdByProject["proj-1"]).toBe("claude");
  });

  it("removes lastSelectedWorktreeRecipeId and initializes the per-project map during v0 migration", async () => {
    setStoredState(
      {
        showProjectPulse: false,
        showDeveloperTools: true,
        lastSelectedWorktreeRecipeId: "recipe-legacy",
      },
      0
    );
    const store = await loadStore();
    const state = store.getState() as unknown as Record<string, unknown>;
    expect(state.showProjectPulse).toBe(false);
    expect(state.showDeveloperTools).toBe(true);
    expect(state.lastSelectedWorktreeRecipeId).toBeUndefined();
    expect(state.lastSelectedWorktreeRecipeIdByProject).toEqual({});
  });

  it("adds agent highlight flags during v<2 migration without overwriting existing values", async () => {
    setStoredState(
      {
        lastSelectedWorktreeRecipeIdByProject: { "proj-1": "r1" },
        showGridAgentHighlights: true,
      },
      1
    );
    const store = await loadStore();
    const state = store.getState();
    expect(state.showGridAgentHighlights).toBe(true);
    expect(state.showDockAgentHighlights).toBe(false);
    expect(state.lastSelectedWorktreeRecipeIdByProject).toEqual({ "proj-1": "r1" });
  });

  it("adds dockDensity='normal' during v<3 migration without overwriting an explicit value", async () => {
    setStoredState(
      {
        lastSelectedWorktreeRecipeIdByProject: {},
        showGridAgentHighlights: false,
        showDockAgentHighlights: false,
        dockDensity: "compact",
      },
      2
    );
    const store = await loadStore();
    expect(store.getState().dockDensity).toBe("compact");
  });

  it("defaults dockDensity to 'normal' during v<3 migration when missing", async () => {
    setStoredState(
      {
        lastSelectedWorktreeRecipeIdByProject: {},
        showGridAgentHighlights: false,
        showDockAgentHighlights: false,
      },
      2
    );
    const store = await loadStore();
    expect(store.getState().dockDensity).toBe("normal");
  });

  it("runs all three migration branches cumulatively from v0 to v3", async () => {
    setStoredState(
      {
        showProjectPulse: false,
        lastSelectedWorktreeRecipeId: "legacy",
      },
      0
    );
    const store = await loadStore();
    const state = store.getState() as unknown as Record<string, unknown>;
    expect(state.showProjectPulse).toBe(false);
    expect(state.lastSelectedWorktreeRecipeId).toBeUndefined();
    expect(state.lastSelectedWorktreeRecipeIdByProject).toEqual({});
    expect(state.showGridAgentHighlights).toBe(false);
    expect(state.showDockAgentHighlights).toBe(false);
    expect(state.dockDensity).toBe("normal");
  });

  it("leaves current v3 state unchanged", async () => {
    setStoredState(
      {
        showProjectPulse: false,
        showDeveloperTools: true,
        showGridAgentHighlights: true,
        showDockAgentHighlights: true,
        dockDensity: "comfortable",
        assignWorktreeToSelf: true,
        lastSelectedWorktreeRecipeIdByProject: { "proj-1": "r1" },
      },
      3
    );
    const store = await loadStore();
    const state = store.getState();
    expect(state.showProjectPulse).toBe(false);
    expect(state.showDeveloperTools).toBe(true);
    expect(state.showGridAgentHighlights).toBe(true);
    expect(state.showDockAgentHighlights).toBe(true);
    expect(state.dockDensity).toBe("comfortable");
    expect(state.assignWorktreeToSelf).toBe(true);
    expect(state.lastSelectedWorktreeRecipeIdByProject).toEqual({ "proj-1": "r1" });
  });

  describe("reduceAnimations", () => {
    it("persists the value to localStorage", async () => {
      const store = await loadStore();
      store.getState().setReduceAnimations(true);
      await vi.waitFor(() => {
        const persisted = storageMock.getItem(STORAGE_KEY);
        expect(persisted).not.toBeNull();
        const parsed = JSON.parse(persisted!);
        expect(parsed.state.reduceAnimations).toBe(true);
      });
    });

    it("migrates v3 state (pre-reduceAnimations) to v4 with default false", async () => {
      setStoredState(
        {
          showProjectPulse: true,
          showDeveloperTools: false,
          showGridAgentHighlights: true,
          showDockAgentHighlights: false,
          dockDensity: "comfortable",
          assignWorktreeToSelf: false,
          lastSelectedWorktreeRecipeIdByProject: {},
        },
        3
      );

      const store = await loadStore();
      const state = store.getState();
      expect(state.reduceAnimations).toBe(false);
      expect(state.dockDensity).toBe("comfortable");
      expect(state.showGridAgentHighlights).toBe(true);
    });

    it("preserves an explicitly persisted true value across v4 migrations", async () => {
      setStoredState(
        {
          reduceAnimations: true,
          showProjectPulse: true,
          showDeveloperTools: false,
          showGridAgentHighlights: false,
          showDockAgentHighlights: false,
          dockDensity: "normal",
          assignWorktreeToSelf: false,
          lastSelectedWorktreeRecipeIdByProject: {},
        },
        3
      );

      const store = await loadStore();
      expect(store.getState().reduceAnimations).toBe(true);
    });
  });

  describe("skipWorkingCloseConfirm retirement (v6 migration)", () => {
    it("drops a persisted skipWorkingCloseConfirm field when migrating from v5", async () => {
      setStoredState(
        {
          skipWorkingCloseConfirm: true,
          showProjectPulse: true,
          showDeveloperTools: false,
          showGridAgentHighlights: false,
          showDockAgentHighlights: false,
          dockDensity: "normal",
          assignWorktreeToSelf: false,
          reduceAnimations: false,
          lastSelectedWorktreeRecipeIdByProject: {},
        },
        5
      );

      const store = await loadStore();
      const state = store.getState() as unknown as Record<string, unknown>;
      expect(state.skipWorkingCloseConfirm).toBeUndefined();
      expect(state.showProjectPulse).toBe(true);
      expect(state.dockDensity).toBe("normal");
      expect(state.reduceAnimations).toBe(false);
    });
  });

  describe("diffViewType (v7 migration)", () => {
    it("persists diffViewType to localStorage", async () => {
      const store = await loadStore();
      store.getState().setDiffViewType("unified");
      await vi.waitFor(() => {
        const persisted = storageMock.getItem(STORAGE_KEY);
        expect(persisted).not.toBeNull();
        const parsed = JSON.parse(persisted!);
        expect(parsed.state.diffViewType).toBe("unified");
      });
    });

    it("migrates v6 state (pre-diffViewType) to v7 with default 'split'", async () => {
      setStoredState(
        {
          showProjectPulse: true,
          showDeveloperTools: false,
          showGridAgentHighlights: false,
          showDockAgentHighlights: false,
          dockDensity: "normal",
          assignWorktreeToSelf: false,
          reduceAnimations: false,
          lastSelectedWorktreeRecipeIdByProject: {},
        },
        6
      );

      const store = await loadStore();
      expect(store.getState().diffViewType).toBe("split");
    });

    it("preserves an explicitly persisted 'unified' value across v7 migration", async () => {
      setStoredState(
        {
          diffViewType: "unified",
          showProjectPulse: true,
          showDeveloperTools: false,
          showGridAgentHighlights: false,
          showDockAgentHighlights: false,
          dockDensity: "normal",
          assignWorktreeToSelf: false,
          reduceAnimations: false,
          lastSelectedWorktreeRecipeIdByProject: {},
        },
        6
      );

      const store = await loadStore();
      expect(store.getState().diffViewType).toBe("unified");
    });

    it("normalises a corrupt persisted diffViewType to 'split'", async () => {
      setStoredState(
        {
          diffViewType: "side-by-side",
          showProjectPulse: true,
          showDeveloperTools: false,
          showGridAgentHighlights: false,
          showDockAgentHighlights: false,
          dockDensity: "normal",
          assignWorktreeToSelf: false,
          reduceAnimations: false,
          lastSelectedWorktreeRecipeIdByProject: {},
        },
        6
      );

      const store = await loadStore();
      expect(store.getState().diffViewType).toBe("split");
    });
  });

  // Issue #7979 — dockDensity is now visible in the dock context menu's
  // radio group, so a corrupt persisted value would leave the radio
  // unchecked. Validate the v8 migration normalises the value.
  describe("dockDensity validation (v8 migration)", () => {
    it("preserves a valid persisted dockDensity across v8 migration", async () => {
      setStoredState(
        {
          diffViewType: "split",
          showProjectPulse: true,
          showDeveloperTools: false,
          showGridAgentHighlights: false,
          showDockAgentHighlights: false,
          dockDensity: "comfortable",
          assignWorktreeToSelf: false,
          reduceAnimations: false,
          lastSelectedWorktreeRecipeIdByProject: {},
        },
        7
      );

      const store = await loadStore();
      expect(store.getState().dockDensity).toBe("comfortable");
    });

    it("normalises a corrupt persisted dockDensity to 'normal'", async () => {
      setStoredState(
        {
          diffViewType: "split",
          showProjectPulse: true,
          showDeveloperTools: false,
          showGridAgentHighlights: false,
          showDockAgentHighlights: false,
          dockDensity: "dense",
          assignWorktreeToSelf: false,
          reduceAnimations: false,
          lastSelectedWorktreeRecipeIdByProject: {},
        },
        7
      );

      const store = await loadStore();
      expect(store.getState().dockDensity).toBe("normal");
    });
  });

  // Issue #8025 — every remote push now opens a confirm dialog, gated by a
  // per-worktree opt-out. The persisted store gains a new keyed record.
  describe("skipPushConfirmByWorktreePath (v9 migration)", () => {
    it("setSkipPushConfirmForWorktree stores true entries and drops keys on false", async () => {
      const store = await loadStore();
      store.getState().setSkipPushConfirmForWorktree("/repo/a", true);
      store.getState().setSkipPushConfirmForWorktree("/repo/b", true);
      expect(store.getState().skipPushConfirmByWorktreePath).toEqual({
        "/repo/a": true,
        "/repo/b": true,
      });
      // Setting false clears the existing entry rather than persisting `false`.
      store.getState().setSkipPushConfirmForWorktree("/repo/a", false);
      expect(store.getState().skipPushConfirmByWorktreePath).toEqual({ "/repo/b": true });
      // Setting false on a key that's not present is a no-op.
      store.getState().setSkipPushConfirmForWorktree("/repo/c", false);
      expect(store.getState().skipPushConfirmByWorktreePath).toEqual({ "/repo/b": true });
    });

    it("persists the record to localStorage", async () => {
      const store = await loadStore();
      store.getState().setSkipPushConfirmForWorktree("/repo/a", true);
      await vi.waitFor(() => {
        const persisted = storageMock.getItem(STORAGE_KEY);
        expect(persisted).not.toBeNull();
        const parsed = JSON.parse(persisted!);
        expect(parsed.state.skipPushConfirmByWorktreePath).toEqual({ "/repo/a": true });
      });
    });

    it("migrates v8 state (pre-skipPushConfirm) to v9 with an empty record", async () => {
      setStoredState(
        {
          diffViewType: "split",
          showProjectPulse: true,
          showDeveloperTools: false,
          showGridAgentHighlights: false,
          showDockAgentHighlights: false,
          dockDensity: "normal",
          assignWorktreeToSelf: false,
          reduceAnimations: false,
          lastSelectedWorktreeRecipeIdByProject: {},
        },
        8
      );

      const store = await loadStore();
      expect(store.getState().skipPushConfirmByWorktreePath).toEqual({});
    });

    it("preserves an explicitly persisted record across v9 migration", async () => {
      setStoredState(
        {
          diffViewType: "split",
          showProjectPulse: true,
          showDeveloperTools: false,
          showGridAgentHighlights: false,
          showDockAgentHighlights: false,
          dockDensity: "normal",
          assignWorktreeToSelf: false,
          reduceAnimations: false,
          lastSelectedWorktreeRecipeIdByProject: {},
          skipPushConfirmByWorktreePath: { "/repo/x": true },
        },
        8
      );

      const store = await loadStore();
      expect(store.getState().skipPushConfirmByWorktreePath).toEqual({ "/repo/x": true });
    });

    it("normalises a corrupt persisted value (string instead of object) to {}", async () => {
      setStoredState(
        {
          diffViewType: "split",
          showProjectPulse: true,
          showDeveloperTools: false,
          showGridAgentHighlights: false,
          showDockAgentHighlights: false,
          dockDensity: "normal",
          assignWorktreeToSelf: false,
          reduceAnimations: false,
          lastSelectedWorktreeRecipeIdByProject: {},
          skipPushConfirmByWorktreePath: "yes",
        },
        8
      );

      const store = await loadStore();
      expect(store.getState().skipPushConfirmByWorktreePath).toEqual({});
    });

    it("strips non-boolean entries from a partially corrupt persisted record", async () => {
      setStoredState(
        {
          diffViewType: "split",
          showProjectPulse: true,
          showDeveloperTools: false,
          showGridAgentHighlights: false,
          showDockAgentHighlights: false,
          dockDensity: "normal",
          assignWorktreeToSelf: false,
          reduceAnimations: false,
          lastSelectedWorktreeRecipeIdByProject: {},
          skipPushConfirmByWorktreePath: { "/repo/a": true, "/repo/b": "yes", "/repo/c": 1 },
        },
        8
      );

      const store = await loadStore();
      expect(store.getState().skipPushConfirmByWorktreePath).toEqual({ "/repo/a": true });
    });

    it("normalises an array value to {}", async () => {
      setStoredState(
        {
          diffViewType: "split",
          showProjectPulse: true,
          showDeveloperTools: false,
          showGridAgentHighlights: false,
          showDockAgentHighlights: false,
          dockDensity: "normal",
          assignWorktreeToSelf: false,
          reduceAnimations: false,
          lastSelectedWorktreeRecipeIdByProject: {},
          skipPushConfirmByWorktreePath: ["/repo/a"],
        },
        8
      );

      const store = await loadStore();
      expect(store.getState().skipPushConfirmByWorktreePath).toEqual({});
    });

    it("migrates cumulatively from v3 through v9", async () => {
      setStoredState(
        {
          skipWorkingCloseConfirm: true,
          showProjectPulse: true,
          showDeveloperTools: false,
          showGridAgentHighlights: false,
          showDockAgentHighlights: false,
          dockDensity: "normal",
          assignWorktreeToSelf: false,
          lastSelectedWorktreeRecipeIdByProject: {},
        },
        3
      );

      const store = await loadStore();
      const state = store.getState();
      expect(state.reduceAnimations).toBe(false);
      expect(state.diffViewType).toBe("split");
      expect(state.skipPushConfirmByWorktreePath).toEqual({});
    });
  });

  describe("markdownWrapLines", () => {
    it("defaults to true when hydrating current-version state persisted before the key existed", async () => {
      setStoredState(
        {
          diffViewType: "split",
          showProjectPulse: true,
          showDeveloperTools: false,
          showGridAgentHighlights: false,
          showDockAgentHighlights: false,
          dockDensity: "normal",
          assignWorktreeToSelf: false,
          reduceAnimations: false,
          lastSelectedWorktreeRecipeIdByProject: {},
          skipPushConfirmByWorktreePath: {},
        },
        11
      );

      const store = await loadStore();
      expect(store.getState().markdownWrapLines).toBe(true);
    });

    it("normalises a corrupt persisted value to the default without disturbing an explicit false", async () => {
      setStoredState(
        {
          diffViewType: "split",
          dockDensity: "normal",
          markdownWrapLines: "yes",
        },
        11
      );
      let store = await loadStore();
      expect(store.getState().markdownWrapLines).toBe(true);

      vi.resetModules();
      _resetPersistedStoreRegistryForTests();
      setStoredState(
        {
          diffViewType: "split",
          dockDensity: "normal",
          markdownWrapLines: false,
        },
        11
      );
      store = await loadStore();
      expect(store.getState().markdownWrapLines).toBe(false);
    });

    it("persists toggled values to localStorage", async () => {
      const store = await loadStore();
      store.getState().setMarkdownWrapLines(false);
      await vi.waitFor(() => {
        const persisted = storageMock.getItem(STORAGE_KEY);
        expect(persisted).not.toBeNull();
        const parsed = JSON.parse(persisted!);
        expect(parsed.state.markdownWrapLines).toBe(false);
      });
    });
  });

  describe("markdownFontSize (#12134)", () => {
    it("migrates pre-v18 state to the default rather than leaving it undefined", async () => {
      // Drive `migrate` directly: hydration's sanitizer would supply the same
      // default, so a store-level assertion passes with the v18 branch deleted.
      const store = await loadStore();
      const migrated = store.persist.getOptions().migrate?.({ dockDensity: "compact" }, 17);

      expect(migrated).toMatchObject({ markdownFontSize: "sm", dockDensity: "compact" });
      // Pin the bump too: `migrate` only runs for a blob below the configured
      // version, so leaving it at 17 would skip the branch above entirely and
      // hydration's sanitizer would quietly supply the same default.
      expect(store.persist.getOptions().version).toBe(20);
    });

    it("leaves an already-valid rung alone when migrating", async () => {
      const store = await loadStore();
      const migrated = store.persist.getOptions().migrate?.({ markdownFontSize: "2xl" }, 17);

      expect(migrated).toMatchObject({ markdownFontSize: "2xl" });
    });

    it("replaces a value that is not a rung, including a plausible pixel number", async () => {
      // The persisted value names a step of the type scale, never a size. A
      // blob carrying 18 came from somewhere else and must not reach the
      // token lookup, which would resolve to `var(--text-18)`.
      for (const corrupt of [18, "18px", "huge", null]) {
        vi.resetModules();
        _resetPersistedStoreRegistryForTests();
        setStoredState({ diffViewType: "split", markdownFontSize: corrupt }, 18);
        const store = await loadStore();
        expect(store.getState().markdownFontSize).toBe("sm");
      }
    });

    it("keeps an explicit rung across a reload and persists it", async () => {
      let store = await loadStore();
      store.getState().setMarkdownFontSize("lg");
      await vi.waitFor(() => {
        const persisted = storageMock.getItem(STORAGE_KEY);
        expect(persisted).not.toBeNull();
        expect(JSON.parse(persisted!).state.markdownFontSize).toBe("lg");
      });

      vi.resetModules();
      _resetPersistedStoreRegistryForTests();
      store = await loadStore();
      expect(store.getState().markdownFontSize).toBe("lg");
    });
  });

  describe("fileBrowserAlwaysHiddenPatterns", () => {
    it("setter trims, de-duplicates in order, and drops empty or path-separator entries", async () => {
      const store = await loadStore();

      store
        .getState()
        .setFileBrowserAlwaysHiddenPatterns([
          "  .DS_Store  ",
          ".DS_Store",
          "",
          "   ",
          "a/b",
          "c\\d",
          "*.log",
        ]);

      expect(store.getState().fileBrowserAlwaysHiddenPatterns).toEqual([".DS_Store", "*.log"]);
    });

    it("preserves an explicitly empty list — hide-nothing is a real choice, not corruption", async () => {
      const store = await loadStore();
      store.getState().setFileBrowserAlwaysHiddenPatterns([]);
      expect(store.getState().fileBrowserAlwaysHiddenPatterns).toEqual([]);
    });

    it("caps the list length and drops an over-long pattern", async () => {
      const store = await loadStore();
      const many = Array.from({ length: 250 }, (_, i) => `p${i}`);
      store.getState().setFileBrowserAlwaysHiddenPatterns([...many, "x".repeat(500)]);

      const result = store.getState().fileBrowserAlwaysHiddenPatterns;
      expect(result.length).toBeLessThanOrEqual(100);
      expect(result).not.toContain("x".repeat(500));
    });

    it("reset restores the fresh-install defaults after edits", async () => {
      const store = await loadStore();
      const fresh = [...store.getState().fileBrowserAlwaysHiddenPatterns];

      store.getState().setFileBrowserAlwaysHiddenPatterns(["custom-only"]);
      expect(store.getState().fileBrowserAlwaysHiddenPatterns).toEqual(["custom-only"]);

      store.getState().resetFileBrowserAlwaysHiddenPatterns();
      expect(store.getState().fileBrowserAlwaysHiddenPatterns).toEqual(fresh);
    });

    it("falls back to defaults when the persisted value is not an array", async () => {
      setStoredState({ fileBrowserAlwaysHiddenPatterns: "nope" }, 13);
      const store = await loadStore();

      // A corrupt scalar can't survive hydration — same shape as fresh install.
      expect(Array.isArray(store.getState().fileBrowserAlwaysHiddenPatterns)).toBe(true);
      expect(store.getState().fileBrowserAlwaysHiddenPatterns.length).toBeGreaterThan(0);
    });

    it("preserves a valid persisted array across hydration", async () => {
      setStoredState({ fileBrowserAlwaysHiddenPatterns: ["*.tmp", "cache"] }, 13);
      const store = await loadStore();
      expect(store.getState().fileBrowserAlwaysHiddenPatterns).toEqual(["*.tmp", "cache"]);
    });

    it("sanitizes a partially-corrupt persisted array on hydration", async () => {
      setStoredState({ fileBrowserAlwaysHiddenPatterns: ["ok", 5, "a/b", "  ok  "] }, 13);
      const store = await loadStore();
      expect(store.getState().fileBrowserAlwaysHiddenPatterns).toEqual(["ok"]);
    });
  });

  describe("projectSwitcherOtherSortMode (v14 migration)", () => {
    it("survives a reload rather than resetting to the default", async () => {
      const first = await loadStore();
      first.getState().setProjectSwitcherOtherSortMode("recent");

      vi.resetModules();
      _resetPersistedStoreRegistryForTests();
      const reloaded = await loadStore();
      expect(reloaded.getState().projectSwitcherOtherSortMode).toBe("recent");
    });

    it("supplies the field in the migration itself, not only in the sanitizer", async () => {
      // Hydration sanitizes too, so a blob-in/state-out test passes even with
      // the migration branch deleted. Drive `migrate` directly to pin it.
      const store = await loadStore();
      const options = store.persist.getOptions();
      const migrated = options.migrate?.({ dockDensity: "compact" }, 13) as Record<string, unknown>;

      expect(migrated.projectSwitcherOtherSortMode).toBe("mostUsed");
      expect(migrated.dockDensity).toBe("compact");
    });

    it("leaves an explicit choice alone when migrating", async () => {
      const store = await loadStore();
      const migrated = store.persist
        .getOptions()
        .migrate?.({ projectSwitcherOtherSortMode: "recent" }, 13) as Record<string, unknown>;

      expect(migrated.projectSwitcherOtherSortMode).toBe("recent");
    });

    it("defaults a pre-v14 blob that predates the field", async () => {
      setStoredState({ dockDensity: "compact" }, 13);
      const store = await loadStore();

      expect(store.getState().projectSwitcherOtherSortMode).toBe("mostUsed");
      // The migration must not trample the state it is migrating past.
      expect(store.getState().dockDensity).toBe("compact");
    });

    it("normalises a value outside the closed set", async () => {
      // Hand-edited, written by a newer build, or — as here — a mode id this
      // app renamed. An unknown mode would leave the radio group with no
      // checked item and fall through every branch of the comparator; letting
      // it sanitize instead is what lets the rename ship without a migration,
      // since the retired id resolves to the same mode's new name.
      setStoredState({ projectSwitcherOtherSortMode: "hottest" }, 14);
      const store = await loadStore();
      expect(store.getState().projectSwitcherOtherSortMode).toBe("mostUsed");
    });
  });

  describe("projectSwitcherCollapsedBands (v17 migration, issue #11943)", () => {
    it("keeps each band's fold independent of the others", async () => {
      const store = await loadStore();
      store.getState().setProjectSwitcherBandCollapsed("other", true);
      store.getState().setProjectSwitcherBandCollapsed("running", true);
      store.getState().setProjectSwitcherBandCollapsed("other", false);

      expect(store.getState().projectSwitcherCollapsedBands).toEqual({
        other: false,
        running: true,
      });
    });

    it("records an unfolded band rather than dropping its key", async () => {
      // The whole reason this map keeps `false` entries: Scratch's default is
      // "folded while empty", so an absent key would re-fold a section the user
      // deliberately opened. Dropping the key on `false` is what the
      // neighbouring skip-confirm map does, and it would be wrong here.
      const store = await loadStore();
      store.getState().setProjectSwitcherBandCollapsed("scratch", false);

      const persisted = JSON.parse(storage[STORAGE_KEY]!) as { state: Record<string, unknown> };
      expect(persisted.state.projectSwitcherCollapsedBands).toEqual({ scratch: false });
    });

    it("survives a reload rather than unfolding on restart", async () => {
      const first = await loadStore();
      first.getState().setProjectSwitcherBandCollapsed("other", true);

      vi.resetModules();
      _resetPersistedStoreRegistryForTests();
      const reloaded = await loadStore();
      expect(reloaded.getState().projectSwitcherCollapsedBands).toEqual({ other: true });
    });

    it("no-ops when the band is already in the requested state", async () => {
      const store = await loadStore();
      store.getState().setProjectSwitcherBandCollapsed("other", true);
      const before = store.getState().projectSwitcherCollapsedBands;
      store.getState().setProjectSwitcherBandCollapsed("other", true);

      expect(store.getState().projectSwitcherCollapsedBands).toBe(before);
    });

    it("supplies the field in the migration itself, not only in the sanitizer", async () => {
      const store = await loadStore();
      const migrated = store.persist
        .getOptions()
        .migrate?.({ dockDensity: "compact" }, 16) as Record<string, unknown>;

      expect(migrated.projectSwitcherCollapsedBands).toEqual({});
      expect(migrated.dockDensity).toBe("compact");
    });

    it("carries an existing map through the v17 migration untouched", async () => {
      setStoredState({ projectSwitcherCollapsedBands: { other: true } }, 16);
      const store = await loadStore();
      expect(store.getState().projectSwitcherCollapsedBands).toEqual({ other: true });
    });

    it("discards a non-record blob instead of reading it as folded", async () => {
      // A hand-edited string is truthy for every key it is asked about, which
      // would open the switcher with nothing on screen and no way back.
      setStoredState({ projectSwitcherCollapsedBands: "all" }, 17);
      const store = await loadStore();
      expect(store.getState().projectSwitcherCollapsedBands).toEqual({});
    });

    it("keeps the boolean entries of a partly corrupt map and drops the rest", async () => {
      setStoredState(
        { projectSwitcherCollapsedBands: { other: true, running: "yes", pinned: false } },
        17
      );
      const store = await loadStore();
      expect(store.getState().projectSwitcherCollapsedBands).toEqual({
        other: true,
        pinned: false,
      });
    });

    it("keeps a key it does not recognise rather than dropping the user's fold", async () => {
      // Keys are free-form on purpose. A band renamed by a newer build leaves an
      // inert entry, which costs nothing — where validating against today's
      // closed set would silently discard a fold that build still honours.
      setStoredState({ projectSwitcherCollapsedBands: { somethingNew: true } }, 17);
      const store = await loadStore();
      expect(store.getState().projectSwitcherCollapsedBands).toEqual({ somethingNew: true });
    });
  });

  describe("keyboardLayoutConfirmationsByBinding (v16 migration, issue #11704)", () => {
    const KEY = "nav.toggleSidebar@Cmd+B";

    it("counts each confirmation up to the limit and then holds", async () => {
      const mod = await import("../preferencesStore");
      const store = mod.usePreferencesStore;
      const limit = mod.KEYBOARD_LAYOUT_CONFIRMATION_LIMIT;

      for (let i = 0; i < limit + 2; i++) {
        store.getState().recordKeyboardLayoutConfirmation("nav.toggleSidebar", "Cmd+B");
      }

      expect(store.getState().keyboardLayoutConfirmationsByBinding[KEY]).toBe(limit);
    });

    it("keeps one entry per action so rebinding cannot accumulate stale tallies", async () => {
      const store = await loadStore();
      store.getState().recordKeyboardLayoutConfirmation("nav.toggleSidebar", "Cmd+B");
      store.getState().recordKeyboardLayoutConfirmation("nav.toggleSidebar", "Cmd+Shift+S");

      expect(Object.keys(store.getState().keyboardLayoutConfirmationsByBinding)).toEqual([
        "nav.toggleSidebar@Cmd+Shift+S",
      ]);
    });

    it("clearing one action leaves other actions' tallies alone", async () => {
      const store = await loadStore();
      store.getState().recordKeyboardLayoutConfirmation("nav.toggleSidebar", "Cmd+B");
      store.getState().recordKeyboardLayoutConfirmation("nav.toggleFocusMode", "Cmd+K");

      store.getState().clearKeyboardLayoutConfirmations("nav.toggleSidebar");

      expect(store.getState().keyboardLayoutConfirmationsByBinding).toEqual({
        "nav.toggleFocusMode@Cmd+K": 1,
      });
    });

    it("survives a reload, or the toast returns on every app start", async () => {
      const first = await loadStore();
      first.getState().recordKeyboardLayoutConfirmation("nav.toggleSidebar", "Cmd+B");

      vi.resetModules();
      _resetPersistedStoreRegistryForTests();
      const reloaded = await loadStore();

      expect(reloaded.getState().keyboardLayoutConfirmationsByBinding[KEY]).toBe(1);
    });

    it("supplies the field in the migration itself, not only in the sanitizer", async () => {
      const store = await loadStore();
      const migrated = await store.persist.getOptions().migrate?.({ dockDensity: "compact" }, 15);

      expect(migrated?.keyboardLayoutConfirmationsByBinding).toEqual({});
      expect(migrated?.dockDensity).toBe("compact");
    });

    it("drops corrupt counts rather than silencing a binding the user never confirmed", async () => {
      // Clamping an oversized value would land it on exactly the limit, which
      // retires the notice for someone who never saw it. Dropping the entry
      // costs one extra toast instead — the recoverable direction.
      setStoredState(
        {
          keyboardLayoutConfirmationsByBinding: {
            [KEY]: 999,
            "nav.toggleFocusMode@Cmd+K": "yes",
            "nav.quickSwitcher@Cmd+P": 0,
            "nav.focusRegion.next@Cmd+1": -2,
            "nav.focusRegion.prev@Cmd+2": 1.5,
          },
        },
        16
      );
      const store = await loadStore();

      await vi.waitFor(() => {
        expect(store.getState().keyboardLayoutConfirmationsByBinding).toEqual({});
      });
    });

    it("keeps a hydrated in-range count, so the sanitizer isn't just wiping the field", async () => {
      setStoredState({ keyboardLayoutConfirmationsByBinding: { [KEY]: 2 } }, 16);
      const store = await loadStore();

      expect(store.getState().keyboardLayoutConfirmationsByBinding).toEqual({ [KEY]: 2 });
    });

    it("hydrates a v15 blob and rewrites it at the current version", async () => {
      setStoredState({ dockDensity: "compact" }, 15);
      const store = await loadStore();
      expect(store.getState().keyboardLayoutConfirmationsByBinding).toEqual({});

      store.getState().recordKeyboardLayoutConfirmation("nav.toggleSidebar", "Cmd+B");

      const written: { version?: number; state?: Record<string, unknown> } = JSON.parse(
        storage[STORAGE_KEY]!
      );
      // Greater-than, not equality against the configured version: comparing a
      // written value to the same option that wrote it passes at any version.
      expect(written.version).toBeGreaterThan(15);
      expect(written.state?.keyboardLayoutConfirmationsByBinding).toEqual({ [KEY]: 1 });
    });

    it("replaces a non-record blob rather than letting it reach live state", async () => {
      setStoredState({ keyboardLayoutConfirmationsByBinding: "corrupt" }, 16);
      const store = await loadStore();

      expect(store.getState().keyboardLayoutConfirmationsByBinding).toEqual({});
    });
  });

  describe("hasSeenActionPalettePrefixHint (v15 migration)", () => {
    it("survives a reload, or the hint would return on every app start", async () => {
      const first = await loadStore();
      first.getState().markActionPalettePrefixHintSeen();

      vi.resetModules();
      _resetPersistedStoreRegistryForTests();
      const reloaded = await loadStore();
      expect(reloaded.getState().hasSeenActionPalettePrefixHint).toBe(true);
    });

    it("supplies the field in the migration itself, not only in the sanitizer", async () => {
      // Hydration sanitizes too, so a blob-in/state-out test passes even with
      // the migration branch deleted. Drive `migrate` directly to pin it.
      const store = await loadStore();
      // Awaited rather than asserted: `migrate` is typed `S | Promise<S>`, and
      // awaiting narrows it without an unsafe cast.
      const migrated = await store.persist.getOptions().migrate?.({ dockDensity: "compact" }, 14);

      expect(migrated?.hasSeenActionPalettePrefixHint).toBe(false);
      expect(migrated?.dockDensity).toBe("compact");
    });

    it("does not re-teach a user who already dismissed it before the upgrade", async () => {
      const store = await loadStore();
      const migrated = await store.persist
        .getOptions()
        .migrate?.({ hasSeenActionPalettePrefixHint: true }, 14);

      expect(migrated?.hasSeenActionPalettePrefixHint).toBe(true);
    });

    it("treats a corrupt value as unseen rather than as truthy", async () => {
      // A hand-edited string is truthy, which would silently retire the hint
      // for someone who never saw it.
      setStoredState({ hasSeenActionPalettePrefixHint: "yes" }, 15);
      const store = await loadStore();
      expect(store.getState().hasSeenActionPalettePrefixHint).toBe(false);
    });
  });

  describe("diffWrapLines auto mode (#12170)", () => {
    it("migrates a pre-v19 explicit `true` through untouched", async () => {
      // `true` could only ever have come from a deliberate toggle, since `false`
      // was the old default — so it is the one legacy value worth preserving.
      const store = await loadStore();
      const migrated = store.persist.getOptions().migrate?.({ diffWrapLines: true }, 18);

      expect(migrated).toMatchObject({ diffWrapLines: true });
    });

    it("migrates a pre-v19 `false` to auto", async () => {
      // Ambiguous on disk: the store persists the whole default snapshot with no
      // per-field provenance, so "never touched it" and "on, then off again" are
      // the same bytes. Auto reads that in favour of shipping the prose default.
      const store = await loadStore();
      const migrated = store.persist.getOptions().migrate?.({ diffWrapLines: false }, 18);

      expect(migrated).toMatchObject({ diffWrapLines: null });
    });

    it("migrates an absent or corrupt pre-v19 value to auto", async () => {
      const store = await loadStore();
      for (const legacy of [{}, { diffWrapLines: "yes" }, { diffWrapLines: 1 }]) {
        expect(store.persist.getOptions().migrate?.(legacy, 18)).toMatchObject({
          diffWrapLines: null,
        });
      }
    });

    it("keeps an explicit `false` set at the current version", async () => {
      // The migration only reinterprets pre-v19 blobs. A `false` written since
      // is a real override and must survive a reload, or turning wrap off on a
      // markdown diff would not stick.
      setStoredState({ diffWrapLines: false }, 20);
      const store = await loadStore();
      expect(store.getState().diffWrapLines).toBe(false);
    });

    it("sanitises a corrupt current-version value to auto, not to off", async () => {
      setStoredState({ diffWrapLines: "yes" }, 20);
      const store = await loadStore();
      expect(store.getState().diffWrapLines).toBeNull();
    });

    it("persists both explicit states to localStorage", async () => {
      const store = await loadStore();
      store.getState().setDiffWrapLines(true);
      await vi.waitFor(() => {
        expect(JSON.parse(storageMock.getItem(STORAGE_KEY)!).state.diffWrapLines).toBe(true);
      });

      store.getState().setDiffWrapLines(false);
      await vi.waitFor(() => {
        expect(JSON.parse(storageMock.getItem(STORAGE_KEY)!).state.diffWrapLines).toBe(false);
      });
    });
  });
});

describe("diffMarkdownRendered (v20 migration, #12171)", () => {
  it("gives a pre-v20 blob the default rather than leaving it undefined", async () => {
    const store = await loadStore();
    const migrated = store.persist.getOptions().migrate?.({ dockDensity: "compact" }, 19);

    expect(migrated).toMatchObject({ diffMarkdownRendered: false, dockDensity: "compact" });
    // Same pin the v18 branch carries: `migrate` only runs for a blob below the
    // configured version, so a version that fell back to 18 would skip the
    // branch above and hydration's sanitizer would quietly supply the default.
    expect(store.persist.getOptions().version).toBeGreaterThan(18);
  });

  it("keeps an existing choice through the migration", async () => {
    const store = await loadStore();
    const migrated = store.persist.getOptions().migrate?.({ diffMarkdownRendered: true }, 19);

    expect(migrated).toMatchObject({ diffMarkdownRendered: true });
  });
});

describe("doubleShiftOpensCanopy", () => {
  it("follows another view's change from the shared storage, as it stands now", async () => {
    const store = await loadStore();
    store.setState({ doubleShiftOpensCanopy: true });
    // Another view wrote it off, then on again; the first event arrives late.
    const written = (enabled: boolean) =>
      JSON.stringify({ state: { doubleShiftOpensCanopy: enabled }, version: 20 });
    storage[STORAGE_KEY] = written(false);
    window.dispatchEvent(
      new StorageEvent("storage", { key: STORAGE_KEY, newValue: written(false) })
    );
    expect(store.getState().doubleShiftOpensCanopy).toBe(false);
    storage[STORAGE_KEY] = written(true);
    window.dispatchEvent(
      new StorageEvent("storage", { key: STORAGE_KEY, newValue: written(false) })
    );
    expect(store.getState().doubleShiftOpensCanopy).toBe(true);
    storage[STORAGE_KEY] = "{not json";
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    expect(store.getState().doubleShiftOpensCanopy).toBe(true);
  });

  it("hydrates a saved choice, and a missing or malformed one as on", async () => {
    const store = await loadStore();
    const merge = store.persist.getOptions().merge!;
    const current = store.getState();
    expect(merge({ doubleShiftOpensCanopy: false }, current).doubleShiftOpensCanopy).toBe(false);
    expect(merge({ dockDensity: "compact" }, current).doubleShiftOpensCanopy).toBe(true);
    expect(merge({ doubleShiftOpensCanopy: null }, current).doubleShiftOpensCanopy).toBe(true);
    expect(merge({ doubleShiftOpensCanopy: "false" }, current).doubleShiftOpensCanopy).toBe(true);
  });
});

/**
 * Cross-view write-merge coverage for the shared localStorage partition
 * (issue #11351). The two id-keyed maps are the primary victims —
 * `lastSelectedWorktreeRecipeIdByProject` (per project) and
 * `skipPushConfirmByWorktreePath` (per worktree path). A stale view must not wipe
 * a sibling's map entries, and every scalar defers to a sibling unless changed.
 */
describe("preferencesStore cross-view write merge (#11351)", () => {
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
