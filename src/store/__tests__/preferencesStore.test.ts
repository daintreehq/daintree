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

  it("uses defaults when storage is empty", async () => {
    const store = await loadStore();
    const state = store.getState();
    expect(state.showProjectPulse).toBe(true);
    expect(state.showDeveloperTools).toBe(false);
    expect(state.showGridAgentHighlights).toBe(false);
    expect(state.showDockAgentHighlights).toBe(false);
    expect(state.dockDensity).toBe("normal");
    expect(state.lastSelectedWorktreeRecipeIdByProject).toEqual({});
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
    it("defaults to false on a fresh install", async () => {
      const store = await loadStore();
      expect(store.getState().reduceAnimations).toBe(false);
    });

    it("setReduceAnimations updates the flag", async () => {
      const store = await loadStore();
      store.getState().setReduceAnimations(true);
      expect(store.getState().reduceAnimations).toBe(true);
      store.getState().setReduceAnimations(false);
      expect(store.getState().reduceAnimations).toBe(false);
    });

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

    it("migrates fresh v4 state (reduceAnimations absent) to default false", async () => {
      setStoredState(
        {
          showProjectPulse: true,
          dockDensity: "normal",
          assignWorktreeToSelf: false,
          lastSelectedWorktreeRecipeIdByProject: {},
        },
        4
      );

      const store = await loadStore();
      expect(store.getState().reduceAnimations).toBe(false);
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

    it("drops a persisted skipWorkingCloseConfirm field when migrating from v4 cumulatively", async () => {
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
        4
      );

      const store = await loadStore();
      const state = store.getState() as unknown as Record<string, unknown>;
      expect(state.skipWorkingCloseConfirm).toBeUndefined();
    });

    it("does not introduce skipWorkingCloseConfirm on a fresh install", async () => {
      const store = await loadStore();
      const state = store.getState() as unknown as Record<string, unknown>;
      expect(state.skipWorkingCloseConfirm).toBeUndefined();
      expect(state.setSkipWorkingCloseConfirm).toBeUndefined();
    });
  });

  describe("diffViewType (v7 migration)", () => {
    it("defaults to 'split' on a fresh install", async () => {
      const store = await loadStore();
      expect(store.getState().diffViewType).toBe("split");
    });

    it("setDiffViewType updates the value", async () => {
      const store = await loadStore();
      store.getState().setDiffViewType("unified");
      expect(store.getState().diffViewType).toBe("unified");
      store.getState().setDiffViewType("split");
      expect(store.getState().diffViewType).toBe("split");
    });

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

    it("migrates cumulatively from v3 through v7, dropping skipWorkingCloseConfirm and defaulting diffViewType", async () => {
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
      const state = store.getState() as unknown as Record<string, unknown>;
      expect(state.skipWorkingCloseConfirm).toBeUndefined();
      expect(state.reduceAnimations).toBe(false);
      expect(state.diffViewType).toBe("split");
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

    it("normalises a non-string dockDensity (null) to 'normal'", async () => {
      setStoredState(
        {
          diffViewType: "split",
          showProjectPulse: true,
          showDeveloperTools: false,
          showGridAgentHighlights: false,
          showDockAgentHighlights: false,
          dockDensity: null,
          assignWorktreeToSelf: false,
          reduceAnimations: false,
          lastSelectedWorktreeRecipeIdByProject: {},
        },
        7
      );

      const store = await loadStore();
      expect(store.getState().dockDensity).toBe("normal");
    });

    it("setDockDensity continues to update the value", async () => {
      const store = await loadStore();
      store.getState().setDockDensity("compact");
      expect(store.getState().dockDensity).toBe("compact");
      store.getState().setDockDensity("comfortable");
      expect(store.getState().dockDensity).toBe("comfortable");
    });
  });

  // Issue #8025 — every remote push now opens a confirm dialog, gated by a
  // per-worktree opt-out. The persisted store gains a new keyed record.
  describe("skipPushConfirmByWorktreePath (v9 migration)", () => {
    it("defaults to an empty record on a fresh install", async () => {
      const store = await loadStore();
      expect(store.getState().skipPushConfirmByWorktreePath).toEqual({});
    });

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
    it("defaults to true on a fresh install", async () => {
      const store = await loadStore();
      expect(store.getState().markdownWrapLines).toBe(true);
    });

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
    it("defaults to the rung rendered markdown has always used", async () => {
      const store = await loadStore();
      expect(store.getState().markdownFontSize).toBe("sm");
    });

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
    it("is a non-empty curated default list on a fresh install", async () => {
      const store = await loadStore();
      expect(store.getState().fileBrowserAlwaysHiddenPatterns.length).toBeGreaterThan(0);
    });

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
    it("defaults to the band's existing frecency order on a fresh install", async () => {
      // The default has to reproduce today's behavior exactly, or shipping the
      // control silently reorders every user's Other band on upgrade.
      const store = await loadStore();
      expect(store.getState().projectSwitcherOtherSortMode).toBe("mostUsed");
    });

    it("round-trips a non-default choice through storage", async () => {
      const store = await loadStore();
      store.getState().setProjectSwitcherOtherSortMode("alphabetical");

      const persisted = JSON.parse(storage[STORAGE_KEY]!) as {
        state: Record<string, unknown>;
      };
      expect(persisted.state.projectSwitcherOtherSortMode).toBe("alphabetical");
    });

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

    it("preserves an explicit choice across the v14 migration", async () => {
      setStoredState({ projectSwitcherOtherSortMode: "recent" }, 13);
      const store = await loadStore();
      expect(store.getState().projectSwitcherOtherSortMode).toBe("recent");
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
    it("starts empty so a fresh install opens with every band unfolded", async () => {
      const store = await loadStore();
      expect(store.getState().projectSwitcherCollapsedBands).toEqual({});
    });

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

    it("starts empty so a fresh install still gets told what its shortcut did", async () => {
      const store = await loadStore();
      expect(store.getState().keyboardLayoutConfirmationsByBinding).toEqual({});
    });

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
    it("starts unseen so a fresh install still gets taught the prefixes", async () => {
      const store = await loadStore();
      expect(store.getState().hasSeenActionPalettePrefixHint).toBe(false);
    });

    it("only ever moves forward — marking twice is the same as marking once", async () => {
      const store = await loadStore();
      store.getState().markActionPalettePrefixHintSeen();
      store.getState().markActionPalettePrefixHintSeen();
      expect(store.getState().hasSeenActionPalettePrefixHint).toBe(true);
    });

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
    it("defaults to auto rather than off", async () => {
      const store = await loadStore();
      expect(store.getState().diffWrapLines).toBeNull();
    });

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
  it("defaults to the source diff, so the new layout opts nobody in", async () => {
    const store = await loadStore();
    expect(store.getState().diffMarkdownRendered).toBe(false);
  });

  it("setDiffMarkdownRendered updates the value", async () => {
    const store = await loadStore();
    store.getState().setDiffMarkdownRendered(true);
    expect(store.getState().diffMarkdownRendered).toBe(true);
    store.getState().setDiffMarkdownRendered(false);
    expect(store.getState().diffMarkdownRendered).toBe(false);
  });

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
