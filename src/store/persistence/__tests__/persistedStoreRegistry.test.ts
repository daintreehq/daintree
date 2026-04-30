// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
  _resetPersistedStoreRegistryForTests();
  vi.restoreAllMocks();
});

describe("persistedStoreRegistry", () => {
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

  it("_resetPersistedStoreRegistryForTests clears all entries", () => {
    registerPersistedStore({
      storeId: "ephemeral",
      store: makeStore({ name: "daintree-ephemeral" }),
      persistedStateType: "State",
    });

    expect(listPersistedStores()).toHaveLength(1);
    _resetPersistedStoreRegistryForTests();
    expect(listPersistedStores()).toHaveLength(0);
  });
});
