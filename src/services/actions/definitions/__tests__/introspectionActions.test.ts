// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionDefinition, ActionContext } from "@shared/types/actions";

// Stubs for other actions' dependencies (actions.list, actions.getContext). These
// are not exercised by the persistedStores tests but must load without errors.
vi.mock("@/store/panelStore", () => ({ usePanelStore: { getState: () => ({}) } }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: { getState: () => ({}) } }));
vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({ getState: () => ({ worktrees: new Map() }) }),
}));

import {
  _resetPersistedStoreRegistryForTests,
  registerPersistedStore,
  type StoreWithPersist,
} from "@/store/persistence/persistedStoreRegistry";

type ActionFactory = () => ActionDefinition;

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

const stubCtx: ActionContext = {};
const registry = new Map<string, ActionFactory>();

beforeAll(async () => {
  const { registerIntrospectionActions } = await import("../introspectionActions");
  registerIntrospectionActions(registry as never, {} as never);
});

beforeEach(() => {
  _resetPersistedStoreRegistryForTests();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("actions.persistedStores", () => {
  it("is registered with the expected metadata", () => {
    expect(registry.has("actions.persistedStores")).toBe(true);
    const def = registry.get("actions.persistedStores")!();
    expect(def.id).toBe("actions.persistedStores");
    expect(def.kind).toBe("query");
    expect(def.danger).toBe("safe");
    expect(def.category).toBe("introspection");
    expect(def.scope).toBe("renderer");
  });

  it("returns storeCount and an entry per registered store", async () => {
    registerPersistedStore({
      storeId: "alpha",
      store: makeStore({ name: "daintree-alpha", version: 2 }),
      persistedStateType: "AlphaState",
    });
    registerPersistedStore({
      storeId: "beta",
      store: makeStore({ name: "daintree-beta" }),
      persistedStateType: "BetaState",
    });

    const def = registry.get("actions.persistedStores")!();
    const result = (await def.run(undefined, stubCtx)) as {
      storeCount: number;
      stores: Array<{ storeId: string }>;
    };

    expect(result.storeCount).toBe(2);
    expect(result.stores.map((s) => s.storeId)).toEqual(["alpha", "beta"]);
  });

  it("flips hasMigrate / hasMerge / hasPartialize based on options", async () => {
    registerPersistedStore({
      storeId: "withAll",
      store: makeStore({
        name: "daintree-with-all",
        partialize: () => ({}),
        migrate: () => ({}),
        merge: () => ({}),
      }),
      persistedStateType: "State",
    });
    registerPersistedStore({
      storeId: "bare",
      store: makeStore({ name: "daintree-bare" }),
      persistedStateType: "State",
    });

    const def = registry.get("actions.persistedStores")!();
    const result = (await def.run(undefined, stubCtx)) as {
      stores: Array<{
        storeId: string;
        hasMigrate: boolean;
        hasMerge: boolean;
        hasPartialize: boolean;
      }>;
    };

    const withAll = result.stores.find((s) => s.storeId === "withAll")!;
    const bare = result.stores.find((s) => s.storeId === "bare")!;

    expect(withAll).toMatchObject({ hasMigrate: true, hasMerge: true, hasPartialize: true });
    expect(bare).toMatchObject({ hasMigrate: false, hasMerge: false, hasPartialize: false });
  });

  it("reports declaredVersion as null when the store has no version option", async () => {
    registerPersistedStore({
      storeId: "versionless",
      store: makeStore({ name: "daintree-versionless" }),
      persistedStateType: "State",
    });

    const def = registry.get("actions.persistedStores")!();
    const result = (await def.run(undefined, stubCtx)) as {
      stores: Array<{ storeId: string; declaredVersion: number | null }>;
    };

    expect(result.stores[0]!.declaredVersion).toBeNull();
  });

  it("reads persistedBlobVersion and sizeBytes lazily from localStorage at call time", async () => {
    registerPersistedStore({
      storeId: "lazy",
      store: makeStore({ name: "daintree-lazy", version: 3 }),
      persistedStateType: "State",
    });

    const def = registry.get("actions.persistedStores")!();

    // Empty localStorage: missing status, zero bytes
    const firstResult = (await def.run(undefined, stubCtx)) as {
      stores: Array<{
        hasPersistedValue: boolean;
        sizeBytes: number;
        parseStatus: string;
        persistedBlobVersion: number | null;
      }>;
    };
    expect(firstResult.stores[0]).toMatchObject({
      hasPersistedValue: false,
      sizeBytes: 0,
      parseStatus: "missing",
      persistedBlobVersion: null,
    });

    // Populate the key: second call should see the new value
    const raw = JSON.stringify({ state: { foo: "bar" }, version: 2 });
    localStorage.setItem("daintree-lazy", raw);

    const secondResult = (await def.run(undefined, stubCtx)) as {
      stores: Array<{
        hasPersistedValue: boolean;
        sizeBytes: number;
        parseStatus: string;
        persistedBlobVersion: number | null;
      }>;
    };
    expect(secondResult.stores[0]).toMatchObject({
      hasPersistedValue: true,
      sizeBytes: raw.length * 2,
      parseStatus: "ok",
      persistedBlobVersion: 2,
    });
  });

  it("reports parseStatus: 'corrupt' for malformed JSON without throwing", async () => {
    registerPersistedStore({
      storeId: "broken",
      store: makeStore({ name: "daintree-broken" }),
      persistedStateType: "State",
    });
    localStorage.setItem("daintree-broken", "{not-json");

    const def = registry.get("actions.persistedStores")!();
    const result = (await def.run(undefined, stubCtx)) as {
      stores: Array<{
        hasPersistedValue: boolean;
        parseStatus: string;
        persistedBlobVersion: number | null;
        sizeBytes: number;
      }>;
    };

    expect(result.stores[0]).toMatchObject({
      hasPersistedValue: true,
      parseStatus: "corrupt",
      persistedBlobVersion: null,
    });
    expect(result.stores[0]!.sizeBytes).toBe("{not-json".length * 2);
  });

  it("does not log or throw when parsing corrupt JSON", async () => {
    registerPersistedStore({
      storeId: "silent",
      store: makeStore({ name: "daintree-silent" }),
      persistedStateType: "State",
    });
    localStorage.setItem("daintree-silent", "{broken");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const def = registry.get("actions.persistedStores")!();
    await expect(def.run(undefined, stubCtx)).resolves.toBeDefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("reports persistedBlobVersion: null when the blob is valid JSON but has no version field", async () => {
    registerPersistedStore({
      storeId: "noBlobVersion",
      store: makeStore({ name: "daintree-no-blob-version", version: 1 }),
      persistedStateType: "State",
    });
    localStorage.setItem(
      "daintree-no-blob-version",
      JSON.stringify({ state: { x: 1 } }) // no version key
    );

    const def = registry.get("actions.persistedStores")!();
    const result = (await def.run(undefined, stubCtx)) as {
      stores: Array<{ persistedBlobVersion: number | null; declaredVersion: number | null }>;
    };

    expect(result.stores[0]!.persistedBlobVersion).toBeNull();
    expect(result.stores[0]!.declaredVersion).toBe(1);
  });

  it("falls back gracefully when localStorage access throws", async () => {
    registerPersistedStore({
      storeId: "blocked",
      store: makeStore({ name: "daintree-blocked" }),
      persistedStateType: "State",
    });

    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });

    try {
      const def = registry.get("actions.persistedStores")!();
      const result = (await def.run(undefined, stubCtx)) as {
        stores: Array<{ hasPersistedValue: boolean; parseStatus: string }>;
      };
      expect(result.stores[0]).toMatchObject({
        hasPersistedValue: false,
        parseStatus: "missing",
      });
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, "localStorage", originalDescriptor);
      } else {
        delete (globalThis as Partial<typeof globalThis>).localStorage;
      }
    }
  });

  it("returns an empty stores array when no stores are registered", async () => {
    const def = registry.get("actions.persistedStores")!();
    const result = (await def.run(undefined, stubCtx)) as {
      storeCount: number;
      stores: unknown[];
    };
    expect(result.storeCount).toBe(0);
    expect(result.stores).toEqual([]);
  });
});
