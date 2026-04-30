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
});
