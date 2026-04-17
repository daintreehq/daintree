// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

type StorageMock = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear?: () => void;
};

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function installLocalStorage(value: StorageMock): void {
  Object.defineProperty(globalThis, "localStorage", {
    value,
    configurable: true,
    writable: true,
  });
}

function installThrowingLocalStorageGetter(error: Error): void {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw error;
    },
  });
}

function restoreLocalStorage(): void {
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
    return;
  }

  delete (globalThis as Partial<typeof globalThis>).localStorage;
}

function createStorageMock(overrides: Partial<StorageMock> = {}): StorageMock {
  const storage = new Map<string, string>();

  return {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => {
      storage.set(key, value);
    },
    removeItem: (key) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
    ...overrides,
  };
}

afterEach(() => {
  restoreLocalStorage();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("persistence boundary hardening", () => {
  it("urlHistoryStore keeps recording visits when storage writes fail", async () => {
    installLocalStorage(
      createStorageMock({
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      })
    );

    const { useUrlHistoryStore } = await import("../urlHistoryStore");

    expect(() => {
      useUrlHistoryStore.getState().recordVisit("proj-1", "https://example.com", "Example");
    }).not.toThrow();

    expect(useUrlHistoryStore.getState().entries["proj-1"]).toEqual([
      expect.objectContaining({
        url: "https://example.com",
        title: "Example",
        visitCount: 1,
      }),
    ]);
  });

  it("preferencesStore falls back cleanly when the localStorage getter throws", async () => {
    installThrowingLocalStorageGetter(new Error("SecurityError"));

    const { usePreferencesStore } = await import("../preferencesStore");

    expect(() => {
      usePreferencesStore.getState().setShowDeveloperTools(true);
    }).not.toThrow();

    expect(usePreferencesStore.getState().showDeveloperTools).toBe(true);
  });

  it("agentPreferencesStore survives migration reads when localStorage access throws", async () => {
    installThrowingLocalStorageGetter(new Error("blocked"));

    const { useAgentPreferencesStore } = await import("../agentPreferencesStore");

    expect(() => {
      useAgentPreferencesStore.getState().setDefaultAgent("codex");
    }).not.toThrow();

    expect(useAgentPreferencesStore.getState().defaultAgent).toBe("codex");
  });

  it("toolbarPreferencesStore updates state when storage writes fail", async () => {
    installLocalStorage(
      createStorageMock({
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      })
    );

    const { useToolbarPreferencesStore } = await import("../toolbarPreferencesStore");

    expect(() => {
      useToolbarPreferencesStore.getState().setAlwaysShowDevServer(true);
    }).not.toThrow();

    expect(useToolbarPreferencesStore.getState().launcher.alwaysShowDevServer).toBe(true);
  });

  it("twoPaneSplitStore still commits ratios when persistence writes fail", async () => {
    installLocalStorage(
      createStorageMock({
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      })
    );

    const { useTwoPaneSplitStore } = await import("../twoPaneSplitStore");

    expect(() => {
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt-1", 0.67, ["panel-a", "panel-b"]);
    }).not.toThrow();

    expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt-1"]).toEqual({
      ratio: 0.67,
      panels: ["panel-a", "panel-b"],
    });
  });

  it("worktreeFilterStore remains usable when hydration reads throw", async () => {
    installLocalStorage(
      createStorageMock({
        getItem: () => {
          throw new Error("SecurityError");
        },
      })
    );

    const { useWorktreeFilterStore } = await import("../worktreeFilterStore");

    expect(() => {
      useWorktreeFilterStore.getState().pinWorktree("wt-1");
    }).not.toThrow();

    expect(useWorktreeFilterStore.getState().pinnedWorktrees).toEqual(["wt-1"]);
  });

  it("portalStore still updates persisted fields when storage writes fail", async () => {
    installLocalStorage(
      createStorageMock({
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      })
    );

    const { usePortalStore } = await import("../portalStore");

    expect(() => {
      usePortalStore.getState().setWidth(600);
    }).not.toThrow();

    expect(usePortalStore.getState().width).toBe(600);
  });

  it("safeJSONParse returns fallback and logs context on malformed JSON", async () => {
    installLocalStorage(createStorageMock());
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { safeJSONParse } = await import("../persistence/safeStorage");

    const result = safeJSONParse<{ value: number } | null>(
      "{not-json",
      { store: "testStore", key: "test-key" },
      null
    );

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const payload = warnSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).toMatchObject({ store: "testStore", key: "test-key" });
    expect(typeof payload.error).toBe("string");
  });

  it("safeJSONParse returns fallback silently when raw value is null", async () => {
    installLocalStorage(createStorageMock());
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { safeJSONParse } = await import("../persistence/safeStorage");

    const result = safeJSONParse<number>(null, { store: "testStore", key: "test-key" }, 42);

    expect(result).toBe(42);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("createSafeJSONStorage.getItem returns null and logs when persisted JSON is corrupt", async () => {
    installLocalStorage(
      createStorageMock({
        getItem: (key) => (key === "test-persist-key" ? "{corrupt" : null),
      })
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { createSafeJSONStorage } = await import("../persistence/safeStorage");

    const storage = createSafeJSONStorage<{ value: number }>();
    const result = storage.getItem("test-persist-key");

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[1]).toMatchObject({ key: "test-persist-key" });
  });

  it("createSafeJSONStorage round-trips healthy state via setItem/getItem", async () => {
    installLocalStorage(createStorageMock());

    const { createSafeJSONStorage } = await import("../persistence/safeStorage");

    const storage = createSafeJSONStorage<{ value: number }>();
    storage.setItem("round-trip-key", { state: { value: 7 }, version: 1 });

    expect(storage.getItem("round-trip-key")).toEqual({ state: { value: 7 }, version: 1 });
  });

  it("agentPreferencesStore boots cleanly when the legacy toolbar blob is corrupt JSON", async () => {
    // Realistic first-run upgrade scenario: primary key absent, legacy toolbar
    // key holds corrupt JSON. Zustand's persist skips merge() when the primary
    // key is null, so the migration parse-guard inside merge is not exercised
    // here — what matters for issue #5218 is that module import and store boot
    // succeed without throwing.
    installLocalStorage(
      createStorageMock({
        getItem: (key) => (key === "daintree-toolbar-preferences" ? "{not-json" : null),
      })
    );

    const { useAgentPreferencesStore } = await import("../agentPreferencesStore");

    expect(useAgentPreferencesStore.getState().defaultAgent).toBeUndefined();
  });

  it("cliAvailabilityStore loadCache discards corrupt persisted cache without throwing", async () => {
    installLocalStorage(
      createStorageMock({
        getItem: (key) => (key === "daintree:cliAvailability:v1" ? "{corrupt" : null),
      })
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { useCliAvailabilityStore } = await import("../cliAvailabilityStore");

    expect(() => useCliAvailabilityStore.getState().initialize()).not.toThrow();
    expect(useCliAvailabilityStore.getState().hasRealData).toBe(false);
    const matching = warnSpy.mock.calls.find(
      (call) => (call[1] as Record<string, unknown> | undefined)?.store === "cliAvailabilityStore"
    );
    expect(matching).toBeDefined();
  });
});
