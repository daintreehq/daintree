// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { BUILT_IN_ACTION_IDS } from "@shared/config/actionIds";
import type { ActionDefinition, ActionContext, ActionManifestEntry } from "@shared/types/actions";
import { actionService } from "@/services/ActionService";

// Node 25 exposes a broken native `localStorage` stub on `globalThis` (no
// `clear`/`getItem`/etc) that shadows JSDOM's Storage and leaks the warning
// `--localstorage-file was provided without a valid path`. JSDOM also fails
// to replace it (its env setup skips configurable:false globals). Install an
// in-memory Storage shim so both `globalThis.localStorage` and
// `window.localStorage` resolve to the same working implementation.
function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.has(key) ? (data.get(key) ?? null) : null;
    },
    setItem(key: string, value: string) {
      data.set(key, String(value));
    },
    removeItem(key: string) {
      data.delete(key);
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null;
    },
  };
}
const testLocalStorage = createMemoryStorage();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  writable: true,
  value: testLocalStorage,
});
Object.defineProperty(window, "localStorage", {
  configurable: true,
  writable: true,
  value: testLocalStorage,
});

// Stubs for other actions' dependencies (actions.list, actions.getContext). These
// are not exercised by the persistedStores tests but must load without errors.
vi.mock("@/services/ActionService", () => ({
  actionService: {
    list: vi.fn(() => []),
    get: vi.fn(() => null),
  },
}));
vi.mock("@/store/panelStore", () => ({ usePanelStore: { getState: () => ({}) } }));
vi.mock("@/store/portalStore", () => ({ usePortalStore: { getState: () => ({}) } }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: { getState: () => ({}) } }));
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: { getState: () => ({}) },
}));
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

describe("actions.list", () => {
  function makeEntry(overrides: Partial<ActionManifestEntry> = {}): ActionManifestEntry {
    return {
      id: "actions.example",
      name: "actions.example",
      title: "Example",
      description: "An example action",
      category: "test",
      kind: "command",
      danger: "safe",
      enabled: true,
      requiresArgs: false,
      ...overrides,
    } as ActionManifestEntry;
  }

  it("does not throw when filtering entries with undefined title or description", async () => {
    // Regression: #6120 — TypeError on toLowerCase when a manifest entry's
    // title or description arrived as undefined (e.g. from an IPC-sourced
    // plugin action). The filter must coerce missing strings to "".
    vi.mocked(actionService.list).mockReturnValueOnce([
      makeEntry({ id: "actions.alpha", title: undefined as unknown as string }),
      makeEntry({ id: "actions.beta", description: undefined as unknown as string }),
      makeEntry({
        id: "actions.gamma",
        title: undefined as unknown as string,
        description: undefined as unknown as string,
      }),
    ]);

    const def = registry.get("actions.list")!();
    await expect(def.run({ search: "alpha" } as never, stubCtx)).resolves.toBeDefined();
  });

  it("matches by id when title/description are undefined", async () => {
    vi.mocked(actionService.list).mockReturnValueOnce([
      makeEntry({
        id: "actions.findMe",
        title: undefined as unknown as string,
        description: undefined as unknown as string,
      }),
      makeEntry({ id: "actions.other", title: "Other", description: "Other action" }),
    ]);

    const def = registry.get("actions.list")!();
    const result = (await def.run({ search: "findMe" } as never, stubCtx)) as {
      actions: ActionManifestEntry[];
    };

    expect(result.actions.map((a) => a.id)).toEqual(["actions.findMe"]);
  });

  it("has mcpVisibility set to core", () => {
    const def = registry.get("actions.list")!();
    expect(def.mcpVisibility).toBe("core");
  });

  it("excludes actions with mcpVisibility hidden", async () => {
    vi.mocked(actionService.list).mockReturnValueOnce([
      makeEntry({ id: "actions.visible", title: "Visible", mcpVisibility: "core" }),
      makeEntry({ id: "actions.secret", title: "Secret", mcpVisibility: "hidden" }),
    ]);

    const def = registry.get("actions.list")!();
    const result = (await def.run(undefined, stubCtx)) as {
      actions: ActionManifestEntry[];
    };

    const ids = result.actions.map((a) => a.id);
    expect(ids).toContain("actions.visible");
    expect(ids).not.toContain("actions.secret");
  });

  it("excludes hidden actions under each user filter branch", async () => {
    // A narrower user filter must never be able to surface a hidden entry —
    // the hidden exclusion must run before category/search/enabledOnly.
    const hidden = makeEntry({ id: "actions.secret", title: "Secret", mcpVisibility: "hidden" });
    const visible = makeEntry({ id: "actions.secret", title: "Secret", mcpVisibility: "core" });

    for (const args of [{ category: "test" }, { search: "secret" }, { enabledOnly: true }]) {
      vi.mocked(actionService.list).mockReturnValueOnce([hidden, visible]);
      const def = registry.get("actions.list")!();
      const result = (await def.run(args as never, stubCtx)) as {
        actions: ActionManifestEntry[];
      };
      const ids = result.actions.map((a) => a.id);
      expect(ids).toContain("actions.secret");
      expect(ids.every((id, i) => i === ids.lastIndexOf(id))).toBe(true);
      expect(result.actions.find((a) => a.mcpVisibility === "hidden")).toBeUndefined();
    }
  });

  interface ListPage {
    actions: ActionManifestEntry[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  }

  // Far larger than any page the schema will allow, so the cap is observable
  // without copying the default page size out of the implementation.
  const OVERSIZED = 500;

  // Zero-padded so id order and fixture order agree, letting a page assertion
  // name exact ids.
  function makeEntries(count: number): ActionManifestEntry[] {
    return Array.from({ length: count }, (_, i) =>
      makeEntry({ id: `actions.p${String(i).padStart(3, "0")}`, mcpVisibility: "core" })
    );
  }

  // `ActionDefinition`'s schema generic defaults to `undefined`, which types
  // `argsSchema` away. Narrow just this lookup rather than widening the shared
  // `ActionFactory`, which would loosen `run()`'s args type in every block.
  function listArgsSchema(): z.ZodTypeAny {
    const def: ActionDefinition<z.ZodTypeAny> = registry.get("actions.list")!() as never;
    return def.argsSchema!;
  }

  async function listPage(args?: Record<string, unknown>): Promise<ListPage> {
    const def = registry.get("actions.list")!();
    return (await def.run(args as never, stubCtx)) as ListPage;
  }

  it("asks the manifest for entries without schemas", async () => {
    // #11529: the schema-bearing manifest was ~430 KB / ~107k tokens per call.
    // The real list() sets inputSchema/outputSchema to `undefined` rather than
    // dropping the keys (ActionService.toManifestEntry), so model that shape and
    // assert on the values plus the option actually passed.
    vi.mocked(actionService.list).mockImplementationOnce((_ctx, options) => {
      const withSchemas = options?.includeSchemas !== false;
      return [
        makeEntry({
          id: "git.commit",
          inputSchema: withSchemas ? { type: "object" } : undefined,
          outputSchema: withSchemas ? { type: "object" } : undefined,
        }),
      ];
    });

    const page = await listPage();

    expect(actionService.list).toHaveBeenCalledWith(stubCtx, { includeSchemas: false });
    expect(page.actions[0]!.inputSchema).toBeUndefined();
    expect(page.actions[0]!.outputSchema).toBeUndefined();
    // Undefined-valued keys vanish on the wire, so nothing schema-shaped
    // reaches the MCP client either.
    const onTheWire = JSON.parse(JSON.stringify(page.actions[0])) as Record<string, unknown>;
    expect(Object.keys(onTheWire)).not.toContain("inputSchema");
    expect(Object.keys(onTheWire)).not.toContain("outputSchema");
  });

  it("caps an unfiltered listing and reports the full match count", async () => {
    const source = makeEntries(OVERSIZED);
    vi.mocked(actionService.list).mockReturnValueOnce(source);

    const page = await listPage();

    expect(page.total).toBe(source.length);
    expect(page.actions.length).toBeLessThan(source.length);
    expect(page.offset).toBe(0);
    expect(page.hasMore).toBe(true);
    // The page is the head of the match set, not an arbitrary slice of it.
    expect(page.actions.map((a) => a.id)).toEqual(
      source.slice(0, page.actions.length).map((a) => a.id)
    );
    // And no caller can ask for a page big enough to hold the whole registry.
    expect(listArgsSchema().safeParse({ limit: source.length }).success).toBe(false);
  });

  it("caps pages well below the size of the real action registry", async () => {
    // #11529 was one call returning the whole manifest, so pin the cap against
    // the actual registry instead of copying the max out of the source: no
    // matter what the limit is, a single page must not be able to carry the
    // whole surface, or even a large fraction of it.
    const schema = listArgsSchema();
    const registrySize = BUILT_IN_ACTION_IDS.length;

    expect(schema.safeParse({ limit: registrySize }).success).toBe(false);
    expect(schema.safeParse({ limit: Math.ceil(registrySize / 3) }).success).toBe(false);
  });

  it("cannot be asked for an unbounded page", async () => {
    // A cap a caller can opt out of is no cap — the whole point of #11529.
    const schema = listArgsSchema();

    expect(schema.safeParse({ limit: Number.MAX_SAFE_INTEGER }).success).toBe(false);
    expect(schema.safeParse({ limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ limit: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ offset: -1 }).success).toBe(false);
    expect(schema.safeParse({ limit: 1, offset: 2 }).success).toBe(true);
    // Omitting args entirely stays valid — paging is opt-in, not required.
    expect(schema.safeParse(undefined).success).toBe(true);
  });

  it("honors an explicit limit and offset", async () => {
    vi.mocked(actionService.list).mockReturnValueOnce(makeEntries(10));

    const page = await listPage({ limit: 3, offset: 4 });

    expect(page.actions.map((a) => a.id)).toEqual(["actions.p004", "actions.p005", "actions.p006"]);
    expect(page.limit).toBe(3);
    expect(page.offset).toBe(4);
    expect(page.total).toBe(10);
    expect(page.hasMore).toBe(true);
  });

  it("reports the requested page size on a partial final page", async () => {
    // `limit` echoes what was asked for, not how many came back.
    vi.mocked(actionService.list).mockReturnValueOnce(makeEntries(5));

    const page = await listPage({ limit: 4, offset: 3 });

    expect(page.actions.map((a) => a.id)).toEqual(["actions.p003", "actions.p004"]);
    expect(page.actions.length).toBeLessThan(page.limit);
    expect(page.limit).toBe(4);
    expect(page.hasMore).toBe(false);
  });

  it("reports no more results when the final page ends exactly at the total", async () => {
    // offset + limit === total is the off-by-one seam: `<=` here would promise a
    // next page that doesn't exist.
    vi.mocked(actionService.list).mockReturnValueOnce(makeEntries(4));

    const page = await listPage({ limit: 2, offset: 2 });

    expect(page.actions.map((a) => a.id)).toEqual(["actions.p002", "actions.p003"]);
    expect(page.total).toBe(4);
    expect(page.hasMore).toBe(false);
  });

  it("pages through the whole match set without skipping or repeating an entry", async () => {
    // The load-bearing pagination property: a full walk reconstructs the source
    // exactly. An odd count guarantees a partial final page.
    const source = makeEntries(7);
    const limit = 3;
    const seen: string[] = [];
    let offset = 0;
    let pageCount = 0;

    for (;;) {
      vi.mocked(actionService.list).mockReturnValueOnce([...source]);
      const page = await listPage({ limit, offset });
      pageCount += 1;

      expect(page.total).toBe(source.length);
      expect(page.limit).toBe(limit);
      expect(page.offset).toBe(offset);
      seen.push(...page.actions.map((a) => a.id));

      if (!page.hasMore) break;
      offset += limit;
      expect(pageCount).toBeLessThanOrEqual(source.length);
    }

    expect(seen).toEqual(source.map((a) => a.id));
    expect(new Set(seen).size).toBe(source.length);
    expect(pageCount).toBe(Math.ceil(source.length / limit));
  });

  it("orders pages by id so an offset walk stays stable", async () => {
    // list() hands back Map insertion order, and re-registering a plugin action
    // moves it to the end — pages must not inherit that churn (#11529).
    vi.mocked(actionService.list).mockReturnValueOnce([
      makeEntry({ id: "actions.zeta", mcpVisibility: "core" }),
      makeEntry({ id: "actions.alpha", mcpVisibility: "core" }),
      makeEntry({ id: "actions.mid", mcpVisibility: "core" }),
    ]);

    const page = await listPage({ limit: 2 });

    expect(page.actions.map((a) => a.id)).toEqual(["actions.alpha", "actions.mid"]);
  });

  it("applies filters before paging", async () => {
    // total/hasMore must describe the filtered match set, and a hidden entry
    // must never be reachable by walking pages.
    vi.mocked(actionService.list).mockReturnValueOnce([
      makeEntry({ id: "actions.keepA", mcpVisibility: "core" }),
      makeEntry({ id: "actions.keepHidden", mcpVisibility: "hidden" }),
      makeEntry({ id: "actions.keepB", mcpVisibility: "core" }),
      makeEntry({ id: "actions.other", mcpVisibility: "core" }),
      makeEntry({ id: "actions.keepC", mcpVisibility: "core" }),
    ]);

    const page = await listPage({ search: "keep", limit: 1, offset: 1 });

    expect(page.actions.map((a) => a.id)).toEqual(["actions.keepB"]);
    expect(page.total).toBe(3);
    expect(page.hasMore).toBe(true);
  });

  it("counts only category matches before paging", async () => {
    vi.mocked(actionService.list).mockReturnValueOnce([
      makeEntry({ id: "actions.g0", category: "git", mcpVisibility: "core" }),
      makeEntry({ id: "actions.t0", category: "terminal", mcpVisibility: "core" }),
      makeEntry({ id: "actions.g1", category: "git", mcpVisibility: "core" }),
      makeEntry({ id: "actions.g2", category: "git", mcpVisibility: "core" }),
    ]);

    const page = await listPage({ category: "git", limit: 2, offset: 1 });

    expect(page.actions.map((a) => a.id)).toEqual(["actions.g1", "actions.g2"]);
    expect(page.total).toBe(3);
    expect(page.hasMore).toBe(false);
  });

  it("counts only enabled actions before paging when enabledOnly is set", async () => {
    vi.mocked(actionService.list).mockReturnValueOnce([
      makeEntry({ id: "actions.e0", enabled: true, mcpVisibility: "core" }),
      makeEntry({ id: "actions.d0", enabled: false, mcpVisibility: "core" }),
      makeEntry({ id: "actions.e1", enabled: true, mcpVisibility: "core" }),
    ]);

    const page = await listPage({ enabledOnly: true, limit: 1 });

    expect(page.actions.map((a) => a.id)).toEqual(["actions.e0"]);
    expect(page.total).toBe(2);
    expect(page.hasMore).toBe(true);
  });

  it("returns an empty page past the end without claiming more results", async () => {
    vi.mocked(actionService.list).mockReturnValueOnce(makeEntries(2));

    const page = await listPage({ offset: 50 });

    expect(page.actions).toEqual([]);
    expect(page.total).toBe(2);
    expect(page.hasMore).toBe(false);
  });

  it("returns a coherent empty page when nothing matches", async () => {
    vi.mocked(actionService.list).mockReturnValueOnce([]);

    const page = await listPage();

    expect(page.actions).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.hasMore).toBe(false);
  });

  it("declares every field it actually returns in its resultSchema", async () => {
    // Zod strips unknown keys, so a resultSchema that lost a field would still
    // parse — comparing the parsed value against the result catches that.
    vi.mocked(actionService.list).mockReturnValueOnce(makeEntries(2));

    const def = registry.get("actions.list")!();
    const result = await def.run(undefined, stubCtx);
    const parsed = def.resultSchema!.safeParse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(result);
  });
});

describe("actions.search", () => {
  function makeEntry(overrides: Partial<ActionManifestEntry> = {}): ActionManifestEntry {
    return {
      id: "actions.example",
      name: "actions.example",
      title: "Example",
      description: "An example action",
      category: "test",
      kind: "command",
      danger: "safe",
      enabled: true,
      requiresArgs: false,
      ...overrides,
    } as ActionManifestEntry;
  }

  it("is registered with the expected metadata", () => {
    expect(registry.has("actions.search")).toBe(true);
    const def = registry.get("actions.search")!();
    expect(def.id).toBe("actions.search");
    expect(def.kind).toBe("query");
    expect(def.danger).toBe("safe");
    expect(def.mcpVisibility).toBe("core");
  });

  it("returns matching entries without inputSchema or outputSchema", async () => {
    // Mirror the real list() contract: schemas are present only when the
    // caller doesn't opt out — so the assertions below fail if actions.search
    // stops passing { includeSchemas: false }.
    vi.mocked(actionService.list).mockImplementationOnce((_ctx, options) => {
      const entries = [
        makeEntry({
          id: "git.commit",
          title: "Commit",
          description: "Commit staged changes",
          category: "git",
          inputSchema: { type: "object", properties: { message: { type: "string" } } },
          outputSchema: { type: "object" },
        }),
        makeEntry({ id: "worktree.list", title: "List Worktrees", category: "worktree" }),
      ];
      if (options?.includeSchemas === false) {
        return entries.map(
          ({ inputSchema: _i, outputSchema: _o, ...rest }) => rest as ActionManifestEntry
        );
      }
      return entries;
    });

    const def = registry.get("actions.search")!();
    const result = (await def.run({ query: "commit" } as never, stubCtx)) as {
      totalMatches: number;
      results: ActionManifestEntry[];
    };

    expect(result.totalMatches).toBe(1);
    expect(result.results[0]!.id).toBe("git.commit");
    expect(result.results[0]!).not.toHaveProperty("inputSchema");
    expect(result.results[0]!).not.toHaveProperty("outputSchema");
  });

  it("scores exact id match highest", async () => {
    vi.mocked(actionService.list).mockReturnValueOnce([
      makeEntry({ id: "git.commit", title: "Some Other Title", category: "git" }),
      makeEntry({ id: "git.commitAll", title: "Commit All", category: "git" }),
    ]);

    const def = registry.get("actions.search")!();
    const result = (await def.run({ query: "git.commit" } as never, stubCtx)) as {
      results: ActionManifestEntry[];
    };

    expect(result.results[0]!.id).toBe("git.commit");
  });

  it("excludes hidden entries from results", async () => {
    vi.mocked(actionService.list).mockReturnValueOnce([
      makeEntry({ id: "actions.secret", title: "Secret", mcpVisibility: "hidden" }),
      makeEntry({ id: "actions.visible", title: "Visible", mcpVisibility: "core" }),
    ]);

    const def = registry.get("actions.search")!();
    const result = (await def.run({ query: "actions" } as never, stubCtx)) as {
      results: ActionManifestEntry[];
    };

    const ids = result.results.map((r) => r.id);
    expect(ids).toContain("actions.visible");
    expect(ids).not.toContain("actions.secret");
  });

  it("includes unclassified entries (no mcpVisibility) for back-compat", async () => {
    vi.mocked(actionService.list).mockReturnValueOnce([
      makeEntry({ id: "git.push", title: "Push", mcpVisibility: undefined }),
    ]);

    const def = registry.get("actions.search")!();
    const result = (await def.run({ query: "push" } as never, stubCtx)) as {
      results: ActionManifestEntry[];
    };

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.id).toBe("git.push");
  });

  it("respects limit parameter", async () => {
    const entries = Array.from({ length: 30 }, (_, i) =>
      makeEntry({ id: `actions.tool${i}`, title: `Tool ${i}` })
    );
    vi.mocked(actionService.list).mockReturnValueOnce(entries);

    const def = registry.get("actions.search")!();
    const result = (await def.run({ query: "Tool", limit: 5 } as never, stubCtx)) as {
      results: ActionManifestEntry[];
    };

    expect(result.results).toHaveLength(5);
  });

  it("returns empty results for queries with no matches", async () => {
    vi.mocked(actionService.list).mockReturnValueOnce([
      makeEntry({ id: "git.commit", title: "Commit" }),
    ]);

    const def = registry.get("actions.search")!();
    const result = (await def.run({ query: "zzzNoMatch" } as never, stubCtx)) as {
      totalMatches: number;
      results: unknown[];
    };

    expect(result.totalMatches).toBe(0);
    expect(result.results).toEqual([]);
  });

  it("returns empty results for whitespace-only queries", async () => {
    vi.mocked(actionService.list).mockReturnValueOnce([
      makeEntry({ id: "git.commit", title: "Commit" }),
    ]);

    const def = registry.get("actions.search")!();
    const result = (await def.run({ query: "   " } as never, stubCtx)) as {
      totalMatches: number;
      results: unknown[];
    };

    expect(result.totalMatches).toBe(0);
    expect(result.results).toEqual([]);
  });

  it("matches across title, description, keywords, and category", async () => {
    vi.mocked(actionService.list).mockReturnValue([
      makeEntry({
        id: "a",
        title: "Alpha",
        description: "first",
        keywords: ["init"],
        category: "core",
      }),
      makeEntry({ id: "b", title: "Beta", description: "second", category: "extra" }),
    ]);

    const def = registry.get("actions.search")!();

    const byTitle = (await def.run({ query: "alpha" } as never, stubCtx)) as {
      results: ActionManifestEntry[];
    };
    expect(byTitle.results[0]!.id).toBe("a");

    const byDesc = (await def.run({ query: "second" } as never, stubCtx)) as {
      results: ActionManifestEntry[];
    };
    expect(byDesc.results[0]!.id).toBe("b");

    const byKeyword = (await def.run({ query: "init" } as never, stubCtx)) as {
      results: ActionManifestEntry[];
    };
    expect(byKeyword.results[0]!.id).toBe("a");

    const byCategory = (await def.run({ query: "extra" } as never, stubCtx)) as {
      results: ActionManifestEntry[];
    };
    expect(byCategory.results[0]!.id).toBe("b");
  });

  it("stably orders results by score descending then id ascending", async () => {
    vi.mocked(actionService.list).mockReturnValueOnce([
      makeEntry({ id: "c", title: "Title Match" }),
      makeEntry({ id: "a", title: "Title Match" }),
      makeEntry({ id: "b", title: "Title Match" }),
    ]);

    const def = registry.get("actions.search")!();
    const result = (await def.run({ query: "Title Match" } as never, stubCtx)) as {
      results: ActionManifestEntry[];
    };

    expect(result.results.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

describe("actions.getSchema", () => {
  function makeEntry(overrides: Partial<ActionManifestEntry> = {}): ActionManifestEntry {
    return {
      id: "actions.example",
      name: "actions.example",
      title: "Example",
      description: "An example action",
      category: "test",
      kind: "command",
      danger: "safe",
      enabled: true,
      requiresArgs: false,
      ...overrides,
    } as ActionManifestEntry;
  }

  it("is registered with the expected metadata", () => {
    expect(registry.has("actions.getSchema")).toBe(true);
    const def = registry.get("actions.getSchema")!();
    expect(def.id).toBe("actions.getSchema");
    expect(def.kind).toBe("query");
    expect(def.danger).toBe("safe");
    expect(def.mcpVisibility).toBe("core");
  });

  it("returns full entry including inputSchema for a valid action", async () => {
    const entry = makeEntry({
      id: "git.commit",
      title: "Commit",
      inputSchema: { type: "object", properties: { message: { type: "string" } } },
    });
    vi.mocked(actionService.get).mockReturnValueOnce(entry);

    const def = registry.get("actions.getSchema")!();
    const result = (await def.run({ actionId: "git.commit" } as never, stubCtx)) as {
      ok: true;
      entry: ActionManifestEntry;
    };

    expect(result.ok).toBe(true);
    expect(result.entry.id).toBe("git.commit");
    expect(result.entry.inputSchema).toBeDefined();
    expect(result.entry.inputSchema!.type).toBe("object");
  });

  it("returns structured error for unknown action", async () => {
    vi.mocked(actionService.get).mockReturnValueOnce(null);

    const def = registry.get("actions.getSchema")!();
    const result = (await def.run({ actionId: "nonexistent" } as never, stubCtx)) as {
      ok: false;
      error: { code: string; message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("NOT_FOUND");
    expect(result.error.message).toContain("nonexistent");
  });

  it("returns structured error for hidden action", async () => {
    const entry = makeEntry({ id: "actions.secret", mcpVisibility: "hidden" });
    vi.mocked(actionService.get).mockReturnValueOnce(entry);

    const def = registry.get("actions.getSchema")!();
    const result = (await def.run({ actionId: "actions.secret" } as never, stubCtx)) as {
      ok: false;
      error: { code: string; message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("returns structured error for restricted action", async () => {
    const entry = makeEntry({ id: "actions.locked", danger: "restricted" });
    vi.mocked(actionService.get).mockReturnValueOnce(entry);

    const def = registry.get("actions.getSchema")!();
    const result = (await def.run({ actionId: "actions.locked" } as never, stubCtx)) as {
      ok: false;
      error: { code: string; message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("NOT_FOUND");
    expect(result.error.message).toContain("actions.locked");
  });

  it("returns structured error when an entry is both hidden and restricted", async () => {
    const entry = makeEntry({
      id: "actions.dual",
      mcpVisibility: "hidden",
      danger: "restricted",
    });
    vi.mocked(actionService.get).mockReturnValueOnce(entry);

    const def = registry.get("actions.getSchema")!();
    const result = (await def.run({ actionId: "actions.dual" } as never, stubCtx)) as {
      ok: false;
      error: { code: string; message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("returns the full input schema for an action the listing summarised", async () => {
    const entry = makeEntry({
      id: "git.push",
      title: "Push",
      inputSchema: { type: "object", properties: { force: { type: "boolean" } } },
    });
    vi.mocked(actionService.get).mockReturnValueOnce(entry);

    const def = registry.get("actions.getSchema")!();
    const result = (await def.run({ actionId: "git.push" } as never, stubCtx)) as {
      ok: true;
      entry: ActionManifestEntry;
    };

    expect(result.ok).toBe(true);
    expect(result.entry.inputSchema).toBeDefined();
  });
});

describe("search → getSchema roundtrip", () => {
  function makeEntry(overrides: Partial<ActionManifestEntry> = {}): ActionManifestEntry {
    return {
      id: "actions.example",
      name: "actions.example",
      title: "Example",
      description: "An example action",
      category: "test",
      kind: "command",
      danger: "safe",
      enabled: true,
      requiresArgs: false,
      ...overrides,
    } as ActionManifestEntry;
  }

  // Schema-on-demand, not reachability. `actions.search` deliberately answers
  // without `inputSchema` so a broad query stays cheap, and `actions.getSchema`
  // fetches the full shape for the one action the model settled on. Both only
  // ever describe actions the session can already dispatch — the roundtrip does
  // not widen anything, which is what #11585 established the hard way.
  it("summarises in search, then returns the full schema on getSchema", async () => {
    const pushEntry = makeEntry({
      id: "git.push",
      title: "Push",
      description: "Push commits to remote",
      category: "git",
      inputSchema: { type: "object", properties: { force: { type: "boolean" } } },
    });
    vi.mocked(actionService.list).mockImplementationOnce((_ctx, options) => {
      const entries = [
        makeEntry({ id: "actions.list", title: "List Actions", mcpVisibility: "core" }),
        pushEntry,
      ];
      if (options?.includeSchemas === false) {
        return entries.map(
          ({ inputSchema: _i, outputSchema: _o, ...rest }) => rest as ActionManifestEntry
        );
      }
      return entries;
    });
    vi.mocked(actionService.get).mockReturnValueOnce(pushEntry);

    // Step 2: search finds it, without schemas
    const searchDef = registry.get("actions.search")!();
    const searchResult = (await searchDef.run({ query: "push" } as never, stubCtx)) as {
      results: ActionManifestEntry[];
    };
    expect(searchResult.results[0]!.id).toBe("git.push");
    expect(searchResult.results[0]!).not.toHaveProperty("inputSchema");

    // Step 3: getSchema retrieves the full schema
    const schemaDef = registry.get("actions.getSchema")!();
    const schemaResult = (await schemaDef.run({ actionId: "git.push" } as never, stubCtx)) as {
      ok: true;
      entry: ActionManifestEntry;
    };
    expect(schemaResult.ok).toBe(true);
    expect(schemaResult.entry.inputSchema).toBeDefined();
  });
});
