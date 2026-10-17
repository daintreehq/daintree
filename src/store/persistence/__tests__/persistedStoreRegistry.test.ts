// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  _resetPersistedStoreRegistryForTests,
  listPersistedStores,
  registerPersistedStore,
  type StoreWithPersist,
} from "../persistedStoreRegistry";

function makeStore(options: {
  name?: string;
  version?: number;
  partialize?: unknown;
  migrate?: unknown;
  merge?: unknown;
}): StoreWithPersist {
  return {
    persist: {
      getOptions: () => options,
    },
  };
}

describe("persistedStoreRegistry", () => {
  afterEach(() => {
    _resetPersistedStoreRegistryForTests();
    vi.restoreAllMocks();
  });

  it("adds a registration and surfaces it via listPersistedStores", () => {
    const store = makeStore({ name: "daintree-test-a", version: 2 });

    registerPersistedStore({ storeId: "testStoreA", store, persistedStateType: "TestStateA" });

    const entries = listPersistedStores();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      storeId: "testStoreA",
      persistedStateType: "TestStateA",
    });
  });

  it("returns entries in insertion order", () => {
    registerPersistedStore({
      storeId: "storeA",
      store: makeStore({ name: "daintree-test-a" }),
      persistedStateType: "StateA",
    });
    registerPersistedStore({
      storeId: "storeB",
      store: makeStore({ name: "daintree-test-b" }),
      persistedStateType: "StateB",
    });
    registerPersistedStore({
      storeId: "storeC",
      store: makeStore({ name: "daintree-test-c" }),
      persistedStateType: "StateC",
    });

    expect(listPersistedStores().map((e) => e.storeId)).toEqual(["storeA", "storeB", "storeC"]);
  });

  it("throws in dev when a storeId is registered twice", () => {
    registerPersistedStore({
      storeId: "duplicate",
      store: makeStore({ name: "daintree-dup-1" }),
      persistedStateType: "StateX",
    });

    expect(() =>
      registerPersistedStore({
        storeId: "duplicate",
        store: makeStore({ name: "daintree-dup-2" }),
        persistedStateType: "StateY",
      })
    ).toThrow(/duplicate storeId/);

    expect(listPersistedStores()).toHaveLength(1);
  });

  it("throws in dev when a storage key collides across store IDs", () => {
    registerPersistedStore({
      storeId: "firstOwner",
      store: makeStore({ name: "daintree-shared-key" }),
      persistedStateType: "StateX",
    });

    expect(() =>
      registerPersistedStore({
        storeId: "secondOwner",
        store: makeStore({ name: "daintree-shared-key" }),
        persistedStateType: "StateY",
      })
    ).toThrow(/storage key collision/);

    expect(listPersistedStores().map((e) => e.storeId)).toEqual(["firstOwner"]);
  });

  it("allows stores with no name option (no collision check triggered)", () => {
    registerPersistedStore({
      storeId: "noNameA",
      store: makeStore({}),
      persistedStateType: "StateA",
    });
    registerPersistedStore({
      storeId: "noNameB",
      store: makeStore({}),
      persistedStateType: "StateB",
    });

    expect(listPersistedStores()).toHaveLength(2);
  });
});

/**
 * Regression guard: importing the store barrel must populate the registry with
 * every persisted Zustand store. If someone deletes a `registerPersistedStore`
 * call (or adds a new persisted store without one), this test fails and the
 * new `actions.persistedStores` diagnostic silently drops the missing entry.
 */

const EXPECTED_STORE_IDS = [
  "worktreeFilterStore",
  "commandHistoryStore",
  "helpPanelStore",
  "portalStore",
  "twoPaneSplitStore",
  "preferencesStore",
  "panelLimitStore",
  "toolbarPreferencesStore",
  "projectStore",
  "urlHistoryStore",
  "terminalSearchHistoryStore",
  "notificationHistoryStore",
  "diffNotesStore",
  "forgeTokenCalloutStore",
] as const;

const EXPECTED_STORAGE_KEYS: Record<(typeof EXPECTED_STORE_IDS)[number], string> = {
  worktreeFilterStore: "daintree-worktree-filters",
  commandHistoryStore: "daintree-command-history",
  helpPanelStore: "help-panel-storage",
  portalStore: "portal-storage",
  twoPaneSplitStore: "daintree-two-pane-split",
  preferencesStore: "daintree-preferences",
  panelLimitStore: "daintree-panel-limits",
  toolbarPreferencesStore: "daintree-toolbar-preferences",
  projectStore: "project-storage",
  urlHistoryStore: "daintree-url-history",
  terminalSearchHistoryStore: "daintree-terminal-search-history",
  notificationHistoryStore: "daintree-notification-history",
  diffNotesStore: "daintree-diff-notes",
  forgeTokenCalloutStore: "daintree-forge-token-callout",
};

describe("persisted store inventory", () => {
  beforeAll(async () => {
    _resetPersistedStoreRegistryForTests();

    await Promise.all([
      import("../../worktreeFilterStore"),
      import("../../commandHistoryStore"),
      import("../../helpPanelStore"),
      import("../../portalStore"),
      import("../../twoPaneSplitStore"),
      import("../../preferencesStore"),
      import("../../panelLimitStore"),
      import("../../toolbarPreferencesStore"),
      import("../../projectStore"),
      import("../../urlHistoryStore"),
      import("../../terminalSearchHistoryStore"),
      import("../../slices/notificationHistorySlice"),
      import("../../diffNotesStore"),
      import("../../forgeTokenCalloutStore"),
    ]);
  });

  afterAll(() => {
    _resetPersistedStoreRegistryForTests();
  });

  it("registers every known persisted store", () => {
    const registeredIds = listPersistedStores()
      .map((r) => r.storeId)
      .sort();
    const expected = [...EXPECTED_STORE_IDS].sort();
    expect(registeredIds).toEqual(expected);
  });

  it("exposes each store's localStorage key through persist.getOptions()", () => {
    const entries = listPersistedStores();
    for (const storeId of EXPECTED_STORE_IDS) {
      const entry = entries.find((r) => r.storeId === storeId);
      expect(entry, `missing registration for ${storeId}`).toBeDefined();
      expect(entry!.store.persist.getOptions().name).toBe(EXPECTED_STORAGE_KEYS[storeId]);
    }
  });
});
