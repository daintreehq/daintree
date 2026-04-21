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
});
