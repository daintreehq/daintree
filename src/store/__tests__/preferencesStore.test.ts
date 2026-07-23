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
});
