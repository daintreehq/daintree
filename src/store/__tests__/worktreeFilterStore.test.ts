// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorktreeFilterStore } from "../worktreeFilterStore";

function resetWorktreeFilterStore() {
  useWorktreeFilterStore.setState({
    query: "",
    liveQuery: "",
    orderBy: "created",
    groupByType: false,
    statusFilters: new Set(),
    typeFilters: new Set(),
    prIssueFilters: new Set(),
    sessionFilters: new Set(),
    hasAgentFilter: false,
    activityFilters: new Set(),
    devServerFilters: new Set(),
    alwaysShowActive: true,
    alwaysShowWaiting: true,
    hideMainWorktree: false,
    pinnedWorktrees: [],
    collapsedWorktrees: [],
    manualOrder: [],
    quickStateFilter: "all",
  });
}

describe("worktreeFilterStore", () => {
  beforeEach(() => {
    resetWorktreeFilterStore();
  });

  it("does not duplicate pinned worktree ids", () => {
    useWorktreeFilterStore.getState().pinWorktree("wt-1");
    useWorktreeFilterStore.getState().pinWorktree("wt-1");
    useWorktreeFilterStore.getState().pinWorktree("wt-2");

    expect(useWorktreeFilterStore.getState().pinnedWorktrees).toEqual(["wt-1", "wt-2"]);
  });

  it("tracks active filter count across filter buckets", () => {
    const store = useWorktreeFilterStore.getState();
    store.setQuery("abc");
    store.toggleStatusFilter("active");
    store.togglePrIssueFilter("hasIssue");

    expect(useWorktreeFilterStore.getState().getActiveFilterCount()).toBe(3);
    expect(useWorktreeFilterStore.getState().hasActiveFilters()).toBe(true);
  });

  it("treats 'Has an agent' as one facet filter that clearAll resets", () => {
    useWorktreeFilterStore.getState().setHasAgentFilter(true);

    const state = useWorktreeFilterStore.getState();
    expect(state.hasAgentFilter).toBe(true);
    expect(state.getActiveFilterCount()).toBe(1);
    expect(state.hasActiveFilters()).toBe(true);
    expect(state.hasFacetFilters()).toBe(true);

    // Clearing Sessions leaves it alone: it is not a Sessions value.
    state.clearSessionFilters();
    expect(useWorktreeFilterStore.getState().hasAgentFilter).toBe(true);

    useWorktreeFilterStore.getState().clearAll();
    expect(useWorktreeFilterStore.getState().hasAgentFilter).toBe(false);
    expect(useWorktreeFilterStore.getState().hasFacetFilters()).toBe(false);
  });

  it("hasActiveFilters returns true when only a facet filter is active (no query)", () => {
    useWorktreeFilterStore.getState().toggleStatusFilter("active");

    expect(useWorktreeFilterStore.getState().hasActiveFilters()).toBe(true);
    expect(useWorktreeFilterStore.getState().getActiveFilterCount()).toBe(1);

    useWorktreeFilterStore.getState().clearAll();

    expect(useWorktreeFilterStore.getState().hasActiveFilters()).toBe(false);
    expect(useWorktreeFilterStore.getState().getActiveFilterCount()).toBe(0);
  });

  it("treats whitespace-only query as inactive", () => {
    useWorktreeFilterStore.getState().setQuery("   ");

    expect(useWorktreeFilterStore.getState().hasActiveFilters()).toBe(false);
    expect(useWorktreeFilterStore.getState().getActiveFilterCount()).toBe(0);
  });

  it("clearAll resets the live query alongside the persisted query", () => {
    useWorktreeFilterStore.getState().setLiveQuery("draft");
    useWorktreeFilterStore.getState().setQuery("committed");

    useWorktreeFilterStore.getState().clearAll();

    expect(useWorktreeFilterStore.getState().liveQuery).toBe("");
    expect(useWorktreeFilterStore.getState().query).toBe("");
  });

  describe("per-section clear actions", () => {
    // Populate every facet section so each clear can be shown to affect only its own.
    function populateAllSections() {
      const store = useWorktreeFilterStore.getState();
      store.toggleStatusFilter("active");
      store.toggleStatusFilter("dirty");
      store.toggleTypeFilter("feature");
      store.togglePrIssueFilter("hasIssue");
      store.toggleSessionFilter("working");
      store.toggleActivityFilter("last1h");
      store.toggleDevServerFilter("running");
    }

    // Each section is described by a thunk that reads its current Set and a thunk
    // that invokes its clear action — typed references avoid dynamic string-key
    // indexing so the isolation assertion stays fully type-checked. `populated`
    // is the exact count `populateAllSections` leaves in that Set, so bystander
    // assertions can check exact membership rather than a weak `> 0`.
    const sections = [
      {
        name: "status",
        populated: 2,
        size: () => useWorktreeFilterStore.getState().statusFilters.size,
        clear: () => useWorktreeFilterStore.getState().clearStatusFilters(),
      },
      {
        name: "branch type",
        populated: 1,
        size: () => useWorktreeFilterStore.getState().typeFilters.size,
        clear: () => useWorktreeFilterStore.getState().clearTypeFilters(),
      },
      {
        name: "issues & PRs",
        populated: 1,
        size: () => useWorktreeFilterStore.getState().prIssueFilters.size,
        clear: () => useWorktreeFilterStore.getState().clearPrIssueFilters(),
      },
      {
        name: "sessions",
        populated: 1,
        size: () => useWorktreeFilterStore.getState().sessionFilters.size,
        clear: () => useWorktreeFilterStore.getState().clearSessionFilters(),
      },
      {
        name: "activity",
        populated: 1,
        size: () => useWorktreeFilterStore.getState().activityFilters.size,
        clear: () => useWorktreeFilterStore.getState().clearActivityFilters(),
      },
      {
        name: "dev server",
        populated: 1,
        size: () => useWorktreeFilterStore.getState().devServerFilters.size,
        clear: () => useWorktreeFilterStore.getState().clearDevServerFilters(),
      },
    ];

    it.each(sections)("clearing $name empties only its own section", (target) => {
      populateAllSections();

      target.clear();

      expect(target.size()).toBe(0);
      for (const other of sections) {
        if (other.name === target.name) continue;
        // Bystander sections keep their exact populated count — a clear that
        // accidentally dropped one entry would still pass a `> 0` check.
        expect(other.size()).toBe(other.populated);
      }
    });

    it("preserves the search query when clearing a single section", () => {
      const store = useWorktreeFilterStore.getState();
      store.setQuery("feature-x");
      store.toggleStatusFilter("active");

      useWorktreeFilterStore.getState().clearStatusFilters();

      expect(useWorktreeFilterStore.getState().statusFilters.size).toBe(0);
      expect(useWorktreeFilterStore.getState().query).toBe("feature-x");
    });
  });

  it("does not duplicate collapsed worktree ids", () => {
    useWorktreeFilterStore.getState().collapseWorktree("wt-1");
    useWorktreeFilterStore.getState().collapseWorktree("wt-1");
    useWorktreeFilterStore.getState().collapseWorktree("wt-2");

    expect(useWorktreeFilterStore.getState().collapsedWorktrees).toEqual(["wt-1", "wt-2"]);
  });

  it("toggles collapse state on and off", () => {
    const store = useWorktreeFilterStore.getState();
    store.toggleWorktreeCollapsed("wt-1");
    expect(useWorktreeFilterStore.getState().collapsedWorktrees).toEqual(["wt-1"]);

    useWorktreeFilterStore.getState().toggleWorktreeCollapsed("wt-1");
    expect(useWorktreeFilterStore.getState().collapsedWorktrees).toEqual([]);
  });

  it("expands a collapsed worktree", () => {
    useWorktreeFilterStore.getState().collapseWorktree("wt-1");
    useWorktreeFilterStore.getState().expandWorktree("wt-1");

    expect(useWorktreeFilterStore.getState().collapsedWorktrees).toEqual([]);
  });

  it("reports correct isWorktreeCollapsed state", () => {
    useWorktreeFilterStore.getState().collapseWorktree("wt-1");

    expect(useWorktreeFilterStore.getState().isWorktreeCollapsed("wt-1")).toBe(true);
    expect(useWorktreeFilterStore.getState().isWorktreeCollapsed("wt-2")).toBe(false);
  });

  it("does not reset collapsedWorktrees on clearAll", () => {
    useWorktreeFilterStore.getState().collapseWorktree("wt-1");
    useWorktreeFilterStore.getState().clearAll();

    expect(useWorktreeFilterStore.getState().collapsedWorktrees).toEqual(["wt-1"]);
  });

  it("counts quickStateFilter in hasActiveFilters and getActiveFilterCount", () => {
    expect(useWorktreeFilterStore.getState().hasActiveFilters()).toBe(false);

    useWorktreeFilterStore.getState().setQuickStateFilter("waiting");

    expect(useWorktreeFilterStore.getState().hasActiveFilters()).toBe(true);
    expect(useWorktreeFilterStore.getState().getActiveFilterCount()).toBe(1);
  });

  describe("hasFacetFilters", () => {
    it("returns false when no filters are active", () => {
      expect(useWorktreeFilterStore.getState().hasFacetFilters()).toBe(false);
    });

    it("returns true when a statusFilter is active", () => {
      useWorktreeFilterStore.getState().toggleStatusFilter("dirty");
      expect(useWorktreeFilterStore.getState().hasFacetFilters()).toBe(true);
    });

    it("returns true when a typeFilter is active", () => {
      useWorktreeFilterStore.getState().clearAll();
      useWorktreeFilterStore.getState().toggleTypeFilter("feature");
      expect(useWorktreeFilterStore.getState().hasFacetFilters()).toBe(true);
    });

    it("returns true when a prIssueFilter is active", () => {
      useWorktreeFilterStore.getState().clearAll();
      useWorktreeFilterStore.getState().togglePrIssueFilter("hasPR");
      expect(useWorktreeFilterStore.getState().hasFacetFilters()).toBe(true);
    });

    it("returns true when a sessionFilter is active", () => {
      useWorktreeFilterStore.getState().clearAll();
      useWorktreeFilterStore.getState().toggleSessionFilter("working");
      expect(useWorktreeFilterStore.getState().hasFacetFilters()).toBe(true);
    });

    it("returns true when an activityFilter is active", () => {
      useWorktreeFilterStore.getState().clearAll();
      useWorktreeFilterStore.getState().toggleActivityFilter("last1h");
      expect(useWorktreeFilterStore.getState().hasFacetFilters()).toBe(true);
    });

    it("returns true when a devServerFilter is active", () => {
      useWorktreeFilterStore.getState().clearAll();
      useWorktreeFilterStore.getState().toggleDevServerFilter("running");
      expect(useWorktreeFilterStore.getState().hasFacetFilters()).toBe(true);
    });

    it("returns false when only query is active", () => {
      useWorktreeFilterStore.getState().clearAll();
      useWorktreeFilterStore.getState().setQuery("search term");
      expect(useWorktreeFilterStore.getState().hasFacetFilters()).toBe(false);
    });

    it("returns false when only quickStateFilter is active", () => {
      useWorktreeFilterStore.getState().clearAll();
      useWorktreeFilterStore.getState().setQuickStateFilter("working");
      expect(useWorktreeFilterStore.getState().hasFacetFilters()).toBe(false);
    });
  });

  it('resets quickStateFilter to "all" on clearAll', () => {
    useWorktreeFilterStore.getState().setQuickStateFilter("working");
    useWorktreeFilterStore.getState().clearAll();

    expect(useWorktreeFilterStore.getState().quickStateFilter).toBe("all");
  });

  describe("devServerFilters", () => {
    it("toggleDevServerFilter adds and removes a value", () => {
      const store = useWorktreeFilterStore.getState();
      store.toggleDevServerFilter("running");
      expect(useWorktreeFilterStore.getState().devServerFilters.has("running")).toBe(true);
      store.toggleDevServerFilter("running");
      expect(useWorktreeFilterStore.getState().devServerFilters.has("running")).toBe(false);
    });

    it("counts devServerFilters in getActiveFilterCount and hasActiveFilters", () => {
      useWorktreeFilterStore.getState().toggleDevServerFilter("running");
      useWorktreeFilterStore.getState().toggleDevServerFilter("error");
      expect(useWorktreeFilterStore.getState().getActiveFilterCount()).toBe(2);
      expect(useWorktreeFilterStore.getState().hasActiveFilters()).toBe(true);
    });

    it("resets devServerFilters on clearAll", () => {
      useWorktreeFilterStore.getState().toggleDevServerFilter("running");
      useWorktreeFilterStore.getState().clearAll();
      expect(useWorktreeFilterStore.getState().devServerFilters.size).toBe(0);
    });

    it("does not persist devServerFilters to localStorage (session-only)", () => {
      useWorktreeFilterStore.getState().toggleDevServerFilter("running");
      // The per-project persist key holds only the persisted shape; the
      // session-only devServerFilters must never appear in it.
      const persisted = Object.keys(localStorage)
        .filter((k) => k.startsWith("daintree-worktree-filters"))
        .map((k) => localStorage.getItem(k) ?? "")
        .join("\n");
      expect(persisted).not.toContain("devServerFilters");
    });
  });

  it('clearQuickStateFilter resets only quickStateFilter to "all"', () => {
    const store = useWorktreeFilterStore.getState();
    store.setQuery("alpha");
    store.toggleStatusFilter("active");
    store.toggleTypeFilter("feature");
    store.togglePrIssueFilter("hasPR");
    store.toggleSessionFilter("working");
    store.toggleActivityFilter("last1h");
    store.pinWorktree("wt-1");
    store.setManualOrder(["wt-2", "wt-3"]);
    store.setQuickStateFilter("working");

    store.clearQuickStateFilter();

    const next = useWorktreeFilterStore.getState();
    expect(next.quickStateFilter).toBe("all");
    expect(next.query).toBe("alpha");
    expect(next.statusFilters.has("active")).toBe(true);
    expect(next.typeFilters.has("feature")).toBe(true);
    expect(next.prIssueFilters.has("hasPR")).toBe(true);
    expect(next.sessionFilters.has("working")).toBe(true);
    expect(next.activityFilters.has("last1h")).toBe(true);
    expect(next.pinnedWorktrees).toEqual(["wt-1"]);
    expect(next.manualOrder).toEqual(["wt-2", "wt-3"]);
  });

  describe("pruneStaleWorktreeIds", () => {
    it("removes pins and collapsed entries not in validIds", () => {
      const store = useWorktreeFilterStore.getState();
      store.pinWorktree("wt-1");
      store.pinWorktree("wt-2");
      store.pinWorktree("wt-stale");
      store.collapseWorktree("wt-2");
      store.collapseWorktree("wt-gone");

      store.pruneStaleWorktreeIds(new Set(["wt-1", "wt-2"]));

      const next = useWorktreeFilterStore.getState();
      expect(next.pinnedWorktrees).toEqual(["wt-1", "wt-2"]);
      expect(next.collapsedWorktrees).toEqual(["wt-2"]);
    });

    it("preserves array identity when nothing is stale", () => {
      const store = useWorktreeFilterStore.getState();
      store.pinWorktree("wt-1");
      store.collapseWorktree("wt-2");

      const before = useWorktreeFilterStore.getState();
      const beforePinned = before.pinnedWorktrees;
      const beforeCollapsed = before.collapsedWorktrees;

      store.pruneStaleWorktreeIds(new Set(["wt-1", "wt-2"]));

      const after = useWorktreeFilterStore.getState();
      expect(after.pinnedWorktrees).toBe(beforePinned);
      expect(after.collapsedWorktrees).toBe(beforeCollapsed);
    });
  });
});

describe("worktreeFilterStore persistence scoping", () => {
  const GLOBAL_KEY = "daintree-worktree-filters";
  const PROJECT_KEY = "daintree-worktree-filters:default";

  type StorageMock = {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
  };

  const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage"
  );

  function installLocalStorage(value: StorageMock): Map<string, string> {
    const backing = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (key: string) => {
          const direct = value.getItem(key);
          if (direct !== null) return direct;
          return backing.get(key) ?? null;
        },
        setItem: (key: string, val: string) => {
          backing.set(key, val);
          value.setItem(key, val);
        },
        removeItem: (key: string) => {
          backing.delete(key);
          value.removeItem(key);
        },
      },
      configurable: true,
      writable: true,
    });
    return backing;
  }

  function restoreLocalStorage(): void {
    if (originalLocalStorageDescriptor) {
      Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
      return;
    }
    delete (globalThis as Partial<typeof globalThis>).localStorage;
  }

  function setProjectIdInUrl(projectId: string | null): void {
    const search = projectId === null ? "" : `?projectId=${encodeURIComponent(projectId)}`;
    Object.defineProperty(window, "location", {
      value: { ...window.location, search },
      configurable: true,
      writable: true,
    });
  }

  beforeEach(() => {
    // Ensure each test gets a freshly evaluated store module that picks up
    // the installed localStorage mock at module-load time. The file-level
    // static import of useWorktreeFilterStore already evaluated once against
    // the jsdom default localStorage — we need to drop that and re-import.
    vi.resetModules();
  });

  afterEach(() => {
    restoreLocalStorage();
    setProjectIdInUrl(null);
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("persists per-project state to the scoped key, not the global key", async () => {
    vi.useFakeTimers();
    try {
      const writes = new Map<string, string>();
      installLocalStorage({
        getItem: () => null,
        setItem: (key, value) => {
          writes.set(key, value);
        },
        removeItem: (key) => {
          writes.delete(key);
        },
      });

      const { useWorktreeFilterStore: store } = await import("../worktreeFilterStore");

      store.getState().pinWorktree("wt-scoped");
      vi.advanceTimersByTime(400);

      expect(writes.has(PROJECT_KEY)).toBe(true);
      const projectBlob = JSON.parse(writes.get(PROJECT_KEY)!) as {
        state: { pinnedWorktrees: string[] };
      };
      expect(projectBlob.state.pinnedWorktrees).toEqual(["wt-scoped"]);

      // Global key should not receive pinnedWorktrees — only prefs are written
      // when a global setter runs, and we only ran a per-project action.
      const globalBlob = writes.get(GLOBAL_KEY);
      if (globalBlob) {
        const parsed = JSON.parse(globalBlob) as { state: Record<string, unknown> };
        expect(parsed.state).not.toHaveProperty("pinnedWorktrees");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not serialize the transient liveQuery to the scoped key", async () => {
    vi.useFakeTimers();
    try {
      const writes = new Map<string, string>();
      installLocalStorage({
        getItem: () => null,
        setItem: (key, value) => {
          writes.set(key, value);
        },
        removeItem: (key) => {
          writes.delete(key);
        },
      });

      const { useWorktreeFilterStore: store } = await import("../worktreeFilterStore");

      store.getState().setLiveQuery("draft");
      vi.advanceTimersByTime(400);

      // The in-memory live query updates, but partialize must keep it out of the
      // persisted blob so it never leaks across sessions.
      expect(store.getState().liveQuery).toBe("draft");
      const blob = writes.get(PROJECT_KEY);
      expect(blob).toBeDefined();
      const parsed = JSON.parse(blob!) as { state: Record<string, unknown> };
      expect(parsed.state).not.toHaveProperty("liveQuery");
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes the 'Has an agent' filter through to the scoped key when set and unset", async () => {
    vi.useFakeTimers();
    try {
      const writes = new Map<string, string>();
      installLocalStorage({
        getItem: (key) => writes.get(key) ?? null,
        setItem: (key, value) => {
          writes.set(key, value);
        },
        removeItem: (key) => {
          writes.delete(key);
        },
      });

      const { useWorktreeFilterStore: store } = await import("../worktreeFilterStore");
      const persisted = () =>
        (JSON.parse(writes.get(PROJECT_KEY)!) as { state: { hasAgentFilter: boolean } }).state
          .hasAgentFilter;

      store.getState().setHasAgentFilter(true);
      vi.advanceTimersByTime(400);
      expect(persisted()).toBe(true);

      store.getState().setHasAgentFilter(false);
      expect(store.getState().hasAgentFilter).toBe(false);
      vi.advanceTimersByTime(400);
      expect(persisted()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores the 'Has an agent' filter, and defaults it off when absent", async () => {
    const blob = (extra: Record<string, unknown>) =>
      JSON.stringify({
        state: {
          query: "",
          statusFilters: [],
          typeFilters: [],
          prIssueFilters: [],
          sessionFilters: [],
          activityFilters: [],
          pinnedWorktrees: [],
          collapsedWorktrees: [],
          manualOrder: [],
          ...extra,
        },
        version: 2,
      });
    installLocalStorage({
      getItem: (key) => (key === PROJECT_KEY ? blob({ hasAgentFilter: true }) : null),
      setItem: () => {},
      removeItem: () => {},
    });
    const first = await import("../worktreeFilterStore");
    expect(first.useWorktreeFilterStore.getState().hasAgentFilter).toBe(true);

    vi.resetModules();
    installLocalStorage({
      getItem: (key) => (key === PROJECT_KEY ? blob({}) : null),
      setItem: () => {},
      removeItem: () => {},
    });
    const second = await import("../worktreeFilterStore");
    expect(second.useWorktreeFilterStore.getState().hasAgentFilter).toBe(false);
  });

  it("seeds liveQuery from the persisted query on hydration", async () => {
    const scopedBlob = JSON.stringify({
      state: {
        query: "restored",
        statusFilters: [],
        typeFilters: [],
        prIssueFilters: [],
        sessionFilters: [],
        activityFilters: [],
        pinnedWorktrees: [],
        collapsedWorktrees: [],
        manualOrder: [],
      },
      version: 2,
    });
    installLocalStorage({
      getItem: (key) => (key === PROJECT_KEY ? scopedBlob : null),
      setItem: () => {},
      removeItem: () => {},
    });

    const { useWorktreeFilterStore: store } = await import("../worktreeFilterStore");

    // A restored search must show in the input/filter immediately, so the
    // transient live query is seeded from the persisted query at hydrate time.
    expect(store.getState().query).toBe("restored");
    expect(store.getState().liveQuery).toBe("restored");
  });

  it("persists global preferences to the global key, not the scoped key", async () => {
    const writes = new Map<string, string>();
    installLocalStorage({
      getItem: () => null,
      setItem: (key, value) => {
        writes.set(key, value);
      },
      removeItem: (key) => {
        writes.delete(key);
      },
    });

    const { useWorktreeFilterStore: store } = await import("../worktreeFilterStore");

    store.getState().setOrderBy("alpha");

    expect(writes.has(GLOBAL_KEY)).toBe(true);
    const globalBlob = JSON.parse(writes.get(GLOBAL_KEY)!) as {
      state: { orderBy: string };
      version: number;
    };
    expect(globalBlob.state.orderBy).toBe("alpha");
    expect(globalBlob.version).toBe(1);

    // The scoped key should not contain orderBy (it's not in the project
    // partialize output).
    const projectBlob = writes.get(PROJECT_KEY);
    if (projectBlob) {
      const parsed = JSON.parse(projectBlob) as { state: Record<string, unknown> };
      expect(parsed.state).not.toHaveProperty("orderBy");
    }
  });

  it("seeds per-project state from the legacy combined blob on first load", async () => {
    const legacyBlob = JSON.stringify({
      state: {
        query: "legacy",
        orderBy: "alpha",
        groupByType: false,
        statusFilters: ["active"],
        typeFilters: [],
        prIssueFilters: [],
        sessionFilters: [],
        activityFilters: [],
        alwaysShowActive: true,
        alwaysShowWaiting: true,
        hideMainWorktree: false,
        pinnedWorktrees: ["wt-legacy-pin"],
        collapsedWorktrees: ["wt-legacy-collapsed"],
        manualOrder: ["wt-a", "wt-b"],
      },
    });

    installLocalStorage({
      getItem: (key) => (key === GLOBAL_KEY ? legacyBlob : null),
      setItem: () => {},
      removeItem: () => {},
    });

    const { useWorktreeFilterStore: store } = await import("../worktreeFilterStore");

    const state = store.getState();
    expect(state.query).toBe("legacy");
    expect(state.pinnedWorktrees).toEqual(["wt-legacy-pin"]);
    expect(state.collapsedWorktrees).toEqual(["wt-legacy-collapsed"]);
    expect(state.manualOrder).toEqual(["wt-a", "wt-b"]);
    expect(Array.from(state.statusFilters)).toEqual(["active"]);
  });

  it("does not re-seed when the scoped key already exists", async () => {
    const legacyBlob = JSON.stringify({
      state: { pinnedWorktrees: ["wt-legacy-pin"] },
    });
    const scopedBlob = JSON.stringify({
      state: {
        query: "",
        statusFilters: [],
        typeFilters: [],
        prIssueFilters: [],
        sessionFilters: [],
        activityFilters: [],
        pinnedWorktrees: ["wt-scoped-pin"],
        collapsedWorktrees: [],
        manualOrder: [],
      },
      version: 0,
    });

    installLocalStorage({
      getItem: (key) => {
        if (key === GLOBAL_KEY) return legacyBlob;
        if (key === PROJECT_KEY) return scopedBlob;
        return null;
      },
      setItem: () => {},
      removeItem: () => {},
    });

    const { useWorktreeFilterStore: store } = await import("../worktreeFilterStore");

    expect(store.getState().pinnedWorktrees).toEqual(["wt-scoped-pin"]);
  });

  it("strips per-project fields from the legacy global blob on version migration", async () => {
    const legacyBlob = JSON.stringify({
      state: {
        orderBy: "alpha",
        groupByType: true,
        alwaysShowActive: false,
        alwaysShowWaiting: false,
        hideMainWorktree: true,
        pinnedWorktrees: ["wt-pin"],
        manualOrder: ["wt-a"],
      },
    });
    const writes = new Map<string, string>();
    installLocalStorage({
      getItem: (key) => (key === GLOBAL_KEY ? legacyBlob : null),
      setItem: (key, value) => {
        writes.set(key, value);
      },
      removeItem: () => {},
    });

    const { useWorktreeFilterStore: store } = await import("../worktreeFilterStore");

    // Trigger a persist write by nudging a global setter.
    store.getState().setOrderBy("recent");

    const globalBlob = writes.get(GLOBAL_KEY);
    expect(globalBlob).toBeDefined();
    const parsed = JSON.parse(globalBlob!) as {
      state: Record<string, unknown>;
      version: number;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.state).not.toHaveProperty("pinnedWorktrees");
    expect(parsed.state).not.toHaveProperty("manualOrder");
    expect(parsed.state.orderBy).toBe("recent");
    expect(parsed.state.hideMainWorktree).toBe(true);
  });

  it('strips retired "running" session filter from pre-v1 scoped blobs (issue #5810)', async () => {
    const scopedBlob = JSON.stringify({
      state: {
        query: "",
        statusFilters: [],
        typeFilters: [],
        prIssueFilters: [],
        sessionFilters: ["running", "waiting"],
        activityFilters: [],
        pinnedWorktrees: [],
        collapsedWorktrees: [],
        manualOrder: [],
      },
      version: 0,
    });

    installLocalStorage({
      getItem: (key) => (key === PROJECT_KEY ? scopedBlob : null),
      setItem: () => {},
      removeItem: () => {},
    });

    const { useWorktreeFilterStore: store } = await import("../worktreeFilterStore");

    expect([...store.getState().sessionFilters]).toEqual(["waiting"]);
  });

  it('strips retired "running" from sessionFilters recovered from the legacy global seed', async () => {
    const legacyBlob = JSON.stringify({
      state: {
        sessionFilters: ["running", "working"],
        pinnedWorktrees: ["wt-pin"],
      },
    });

    installLocalStorage({
      getItem: (key) => (key === GLOBAL_KEY ? legacyBlob : null),
      setItem: () => {},
      removeItem: () => {},
    });

    const { useWorktreeFilterStore: store } = await import("../worktreeFilterStore");

    expect([...store.getState().sessionFilters].sort()).toEqual(["working"]);
    expect(store.getState().pinnedWorktrees).toEqual(["wt-pin"]);
  });

  it("migrates v1 githubFilters key to prIssueFilters (v2, #8461)", async () => {
    const scopedBlob = JSON.stringify({
      state: {
        query: "",
        statusFilters: [],
        typeFilters: [],
        githubFilters: ["hasPR", "prOpen"],
        sessionFilters: [],
        activityFilters: [],
        pinnedWorktrees: [],
        collapsedWorktrees: [],
        manualOrder: [],
      },
      version: 1,
    });

    installLocalStorage({
      getItem: (key) => (key === PROJECT_KEY ? scopedBlob : null),
      setItem: () => {},
      removeItem: () => {},
    });

    const { useWorktreeFilterStore: store } = await import("../worktreeFilterStore");

    expect([...store.getState().prIssueFilters].sort()).toEqual(["hasPR", "prOpen"]);
  });

  it("reads legacy githubFilters key from the combined global seed (#8461)", async () => {
    const legacyBlob = JSON.stringify({
      state: {
        githubFilters: ["hasIssue", "prMerged"],
        pinnedWorktrees: ["wt-pin"],
      },
    });

    installLocalStorage({
      getItem: (key) => (key === GLOBAL_KEY ? legacyBlob : null),
      setItem: () => {},
      removeItem: () => {},
    });

    const { useWorktreeFilterStore: store } = await import("../worktreeFilterStore");

    expect([...store.getState().prIssueFilters].sort()).toEqual(["hasIssue", "prMerged"]);
    expect(store.getState().pinnedWorktrees).toEqual(["wt-pin"]);
  });

  it("isolates per-project pins across different projectIds in the URL", async () => {
    vi.useFakeTimers();
    try {
      // Shared localStorage across both project loads — backing key-value store
      // persists through module resets, just like real localStorage does.
      const persistent = new Map<string, string>();
      installLocalStorage({
        getItem: (key) => persistent.get(key) ?? null,
        setItem: (key, value) => {
          persistent.set(key, value);
        },
        removeItem: (key) => {
          persistent.delete(key);
        },
      });

      // Project A: pin wt-a
      setProjectIdInUrl("project-a");
      let mod = await import("../worktreeFilterStore");
      mod.useWorktreeFilterStore.getState().pinWorktree("wt-a");
      vi.advanceTimersByTime(400);
      expect(mod.useWorktreeFilterStore.getState().pinnedWorktrees).toEqual(["wt-a"]);

      // Switch to Project B — module reset simulates a fresh WebContentsView
      vi.useRealTimers();
      vi.resetModules();
      vi.useFakeTimers();
      setProjectIdInUrl("project-b");
      mod = await import("../worktreeFilterStore");

      // Project B must not see Project A's pin
      expect(mod.useWorktreeFilterStore.getState().pinnedWorktrees).toEqual([]);
      mod.useWorktreeFilterStore.getState().pinWorktree("wt-b");
      vi.advanceTimersByTime(400);
      expect(mod.useWorktreeFilterStore.getState().pinnedWorktrees).toEqual(["wt-b"]);

      // Back to Project A — its pin is intact
      vi.useRealTimers();
      vi.resetModules();
      setProjectIdInUrl("project-a");
      mod = await import("../worktreeFilterStore");
      expect(mod.useWorktreeFilterStore.getState().pinnedWorktrees).toEqual(["wt-a"]);

      // Each project writes to its own scoped key
      expect(persistent.has("daintree-worktree-filters:project-a")).toBe(true);
      expect(persistent.has("daintree-worktree-filters:project-b")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers legacy seed when the scoped key is corrupt JSON", async () => {
    const legacyBlob = JSON.stringify({
      state: {
        query: "recovered",
        pinnedWorktrees: ["wt-legacy"],
      },
    });
    installLocalStorage({
      getItem: (key) => {
        if (key === GLOBAL_KEY) return legacyBlob;
        if (key === PROJECT_KEY) return "{corrupt";
        return null;
      },
      setItem: () => {},
      removeItem: () => {},
    });

    const { useWorktreeFilterStore: store } = await import("../worktreeFilterStore");

    // Corrupt scoped blob should not suppress legacy recovery
    expect(store.getState().query).toBe("recovered");
    expect(store.getState().pinnedWorktrees).toEqual(["wt-legacy"]);
  });

  it("ignores legacy fields with wrong types to avoid silent corruption", async () => {
    const legacyBlob = JSON.stringify({
      state: {
        // Malformed: strings where arrays are expected. Without type guards,
        // `new Set<StatusFilter>("active")` would split into 6 characters.
        statusFilters: "active",
        pinnedWorktrees: "wt-oops",
        manualOrder: 42,
      },
    });
    installLocalStorage({
      getItem: (key) => (key === GLOBAL_KEY ? legacyBlob : null),
      setItem: () => {},
      removeItem: () => {},
    });

    const { useWorktreeFilterStore: store } = await import("../worktreeFilterStore");

    expect(Array.from(store.getState().statusFilters)).toEqual([]);
    expect(store.getState().pinnedWorktrees).toEqual([]);
    expect(store.getState().manualOrder).toEqual([]);
  });

  it("routes functional setState updates to the correct backing stores", async () => {
    const writes = new Map<string, string>();
    installLocalStorage({
      getItem: () => null,
      setItem: (key, value) => {
        writes.set(key, value);
      },
      removeItem: (key) => {
        writes.delete(key);
      },
    });

    const { useWorktreeFilterStore: store } = await import("../worktreeFilterStore");

    store.setState((state) => ({
      orderBy: state.orderBy === "created" ? "alpha" : "created",
      pinnedWorktrees: [...state.pinnedWorktrees, "wt-func"],
    }));

    const next = store.getState();
    expect(next.orderBy).toBe("alpha");
    expect(next.pinnedWorktrees).toEqual(["wt-func"]);
  });

  it("keeps global preferences when clearAll runs", async () => {
    installLocalStorage({
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });

    const { useWorktreeFilterStore: store } = await import("../worktreeFilterStore");

    store.getState().setOrderBy("alpha");
    store.getState().setAlwaysShowActive(false);
    store.getState().setAlwaysShowWaiting(false);
    store.getState().setHideMainWorktree(true);
    store.getState().pinWorktree("wt-pin");
    store.getState().setQuery("search");

    store.getState().clearAll();

    const state = store.getState();
    expect(state.orderBy).toBe("alpha");
    expect(state.alwaysShowActive).toBe(false);
    expect(state.alwaysShowWaiting).toBe(false);
    // hideMainWorktree IS reset by clearAll — preserves existing behavior
    expect(state.hideMainWorktree).toBe(false);
    expect(state.pinnedWorktrees).toEqual(["wt-pin"]);
    expect(state.query).toBe("");
  });
});

/**
 * Cross-view write-merge coverage for the shared localStorage partition
 * (issue #11351). Only the GLOBAL prefs sub-store (`daintree-worktree-filters`)
 * needs the merge: its five fields share one literal key across views. The
 * per-project sub-store (`daintree-worktree-filters:{projectId}`) is exempt — its
 * key already embeds the project id — and must stay untouched by a global write.
 */
describe("worktreeFilterStore cross-view write merge (#11351)", () => {
  const GLOBAL_KEY = "daintree-worktree-filters";
  // No projectId in the URL → the per-project store keys off "default".
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

  it("a stale same-project window's write preserves a sibling's 'Has an agent' filter", async () => {
    const backing = installLocalStorage({});
    const { useWorktreeFilterStore: store } = await import("../worktreeFilterStore");
    vi.advanceTimersByTime(400);

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
          hasAgentFilter: true,
          activityFilters: [],
          pinnedWorktrees: [],
          collapsedWorktrees: [],
          manualOrder: [],
        },
      })
    );

    store.getState().setQuery("needle");
    vi.advanceTimersByTime(400);

    const projectBlob: { state: { hasAgentFilter: boolean; query: string } } = JSON.parse(
      backing.get(PROJECT_KEY)!
    );
    expect(projectBlob.state.hasAgentFilter).toBe(true);
    expect(projectBlob.state.query).toBe("needle");
  });
});
