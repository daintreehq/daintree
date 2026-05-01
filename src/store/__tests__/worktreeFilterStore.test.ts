// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorktreeFilterStore } from "../worktreeFilterStore";

function resetWorktreeFilterStore() {
  useWorktreeFilterStore.setState({
    query: "",
    orderBy: "created",
    groupByType: false,
    statusFilters: new Set(),
    typeFilters: new Set(),
    githubFilters: new Set(),
    sessionFilters: new Set(),
    activityFilters: new Set(),
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
    store.toggleGitHubFilter("hasIssue");

    expect(useWorktreeFilterStore.getState().getActiveFilterCount()).toBe(3);
    expect(useWorktreeFilterStore.getState().hasActiveFilters()).toBe(true);
  });

  it("treats whitespace-only query as inactive", () => {
    useWorktreeFilterStore.getState().setQuery("   ");

    expect(useWorktreeFilterStore.getState().hasActiveFilters()).toBe(false);
    expect(useWorktreeFilterStore.getState().getActiveFilterCount()).toBe(0);
  });

  it("shows main worktree by default (hideMainWorktree is false)", () => {
    expect(useWorktreeFilterStore.getState().hideMainWorktree).toBe(false);
  });

  it("toggles hideMainWorktree on and off", () => {
    const store = useWorktreeFilterStore.getState();

    store.setHideMainWorktree(true);
    expect(useWorktreeFilterStore.getState().hideMainWorktree).toBe(true);

    store.setHideMainWorktree(false);
    expect(useWorktreeFilterStore.getState().hideMainWorktree).toBe(false);
  });

  it("resets hideMainWorktree to false on clearAll", () => {
    useWorktreeFilterStore.getState().setHideMainWorktree(true);
    useWorktreeFilterStore.getState().clearAll();

    expect(useWorktreeFilterStore.getState().hideMainWorktree).toBe(false);
  });

  it("defaults alwaysShowWaiting to true", () => {
    expect(useWorktreeFilterStore.getState().alwaysShowWaiting).toBe(true);
  });

  it("toggles alwaysShowWaiting via setter", () => {
    useWorktreeFilterStore.getState().setAlwaysShowWaiting(false);
    expect(useWorktreeFilterStore.getState().alwaysShowWaiting).toBe(false);

    useWorktreeFilterStore.getState().setAlwaysShowWaiting(true);
    expect(useWorktreeFilterStore.getState().alwaysShowWaiting).toBe(true);
  });

  it("does not reset alwaysShowWaiting on clearAll", () => {
    useWorktreeFilterStore.getState().setAlwaysShowWaiting(false);
    useWorktreeFilterStore.getState().clearAll();

    expect(useWorktreeFilterStore.getState().alwaysShowWaiting).toBe(false);
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

  it('defaults quickStateFilter to "all"', () => {
    expect(useWorktreeFilterStore.getState().quickStateFilter).toBe("all");
  });

  it("updates quickStateFilter via setter", () => {
    useWorktreeFilterStore.getState().setQuickStateFilter("working");
    expect(useWorktreeFilterStore.getState().quickStateFilter).toBe("working");

    useWorktreeFilterStore.getState().setQuickStateFilter("waiting");
    expect(useWorktreeFilterStore.getState().quickStateFilter).toBe("waiting");

    useWorktreeFilterStore.getState().setQuickStateFilter("all");
    expect(useWorktreeFilterStore.getState().quickStateFilter).toBe("all");
  });

  it("counts quickStateFilter in hasActiveFilters and getActiveFilterCount", () => {
    expect(useWorktreeFilterStore.getState().hasActiveFilters()).toBe(false);

    useWorktreeFilterStore.getState().setQuickStateFilter("waiting");

    expect(useWorktreeFilterStore.getState().hasActiveFilters()).toBe(true);
    expect(useWorktreeFilterStore.getState().getActiveFilterCount()).toBe(1);
  });

  it('resets quickStateFilter to "all" on clearAll', () => {
    useWorktreeFilterStore.getState().setQuickStateFilter("working");
    useWorktreeFilterStore.getState().clearAll();

    expect(useWorktreeFilterStore.getState().quickStateFilter).toBe("all");
  });

  it('clearQuickStateFilter resets only quickStateFilter to "all"', () => {
    const store = useWorktreeFilterStore.getState();
    store.setQuery("alpha");
    store.toggleStatusFilter("active");
    store.toggleTypeFilter("feature");
    store.toggleGitHubFilter("hasPR");
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
    expect(next.githubFilters.has("hasPR")).toBe(true);
    expect(next.sessionFilters.has("working")).toBe(true);
    expect(next.activityFilters.has("last1h")).toBe(true);
    expect(next.pinnedWorktrees).toEqual(["wt-1"]);
    expect(next.manualOrder).toEqual(["wt-2", "wt-3"]);
  });

  it("clearQuickStateFilter is a no-op when already 'all'", () => {
    const store = useWorktreeFilterStore.getState();
    store.toggleStatusFilter("active");
    store.clearQuickStateFilter();

    const next = useWorktreeFilterStore.getState();
    expect(next.quickStateFilter).toBe("all");
    expect(next.statusFilters.has("active")).toBe(true);
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
        githubFilters: [],
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
        githubFilters: [],
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
        githubFilters: [],
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

  it("isolates per-project pins across different projectIds in the URL", async () => {
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
    expect(mod.useWorktreeFilterStore.getState().pinnedWorktrees).toEqual(["wt-a"]);

    // Switch to Project B — module reset simulates a fresh WebContentsView
    vi.resetModules();
    setProjectIdInUrl("project-b");
    mod = await import("../worktreeFilterStore");

    // Project B must not see Project A's pin
    expect(mod.useWorktreeFilterStore.getState().pinnedWorktrees).toEqual([]);
    mod.useWorktreeFilterStore.getState().pinWorktree("wt-b");
    expect(mod.useWorktreeFilterStore.getState().pinnedWorktrees).toEqual(["wt-b"]);

    // Back to Project A — its pin is intact
    vi.resetModules();
    setProjectIdInUrl("project-a");
    mod = await import("../worktreeFilterStore");
    expect(mod.useWorktreeFilterStore.getState().pinnedWorktrees).toEqual(["wt-a"]);

    // Each project writes to its own scoped key
    expect(persistent.has("daintree-worktree-filters:project-a")).toBe(true);
    expect(persistent.has("daintree-worktree-filters:project-b")).toBe(true);
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
