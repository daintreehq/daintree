// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersistWriteMerge } from "../persistence/persistWriteMerge";

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

type PerfMarkRecord = {
  mark: string;
  meta?: Record<string, unknown>;
};

function seedPerfMarks(): PerfMarkRecord[] {
  const buffer: PerfMarkRecord[] = [];
  (window as Window & typeof globalThis).__DAINTREE_PERF_MARKS__ =
    buffer as unknown as typeof window.__DAINTREE_PERF_MARKS__;
  return buffer;
}

function clearPerfMarks(): void {
  delete (window as Window & typeof globalThis).__DAINTREE_PERF_MARKS__;
}

afterEach(() => {
  restoreLocalStorage();
  clearPerfMarks();
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
        url: "https://example.com/",
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

  it("createSafeJSONStorage mergeOnWrite reconciles concurrent project-view writes without clobbering (#11351)", async () => {
    const backing = new Map<string, string>();
    installLocalStorage({
      getItem: (key) => backing.get(key) ?? null,
      setItem: (key, value) => {
        backing.set(key, value);
      },
      removeItem: (key) => {
        backing.delete(key);
      },
    });

    const { createSafeJSONStorage } = await import("../persistence/safeStorage");
    const { mergeRecordByWriterDelta } = await import("../persistence/persistWriteMerge");

    type Sessions = { sessions: Record<string, { v: string }> };
    const mergeSessions: PersistWriteMerge<Sessions> = ({ baseline, onDisk, incoming }) => {
      if (!onDisk) return incoming;
      return {
        version: incoming.version,
        state: {
          sessions: mergeRecordByWriterDelta(
            baseline?.state.sessions ?? {},
            incoming.state.sessions,
            onDisk.state.sessions ?? {}
          ),
        },
      };
    };
    const KEY = "merge-sessions";
    const val = (sessions: Sessions["sessions"]) => ({ state: { sessions }, version: 1 });
    const diskSessions = () =>
      (JSON.parse(backing.get(KEY) ?? "null") as { state: Sessions } | null)?.state.sessions;
    const backupSessions = () =>
      (JSON.parse(backing.get(`${KEY}.__bak`) ?? "null") as { state: Sessions } | null)?.state
        .sessions;

    // Two views hydrate the same (empty) shared baseline.
    const viewA = createSafeJSONStorage<Sessions>({ mergeOnWrite: mergeSessions });
    const viewB = createSafeJSONStorage<Sessions>({ mergeOnWrite: mergeSessions });
    viewA.getItem(KEY);
    viewB.getItem(KEY);

    // View B writes its own project's session.
    viewB.setItem(KEY, val({ b: { v: "b" } }));
    // Stale view A — which never saw B's write — writes its own project's session.
    viewA.setItem(KEY, val({ a: { v: "a" } }));

    // Neither view's entry was dropped, and the backup tracks the merged result.
    expect(diskSessions()).toEqual({ a: { v: "a" }, b: { v: "b" } });
    expect(backupSessions()).toEqual({ a: { v: "a" }, b: { v: "b" } });

    // A third view hydrated now, while both entries exist.
    const viewC = createSafeJSONStorage<Sessions>({ mergeOnWrite: mergeSessions });
    viewC.getItem(KEY);

    // View A intentionally clears its own entry.
    viewA.setItem(KEY, val({}));
    expect(diskSessions()).toEqual({ b: { v: "b" } });

    // The stale third view still carries `a` in memory and writes an unrelated
    // addition — `a` must NOT be resurrected, and `b`/`c` survive.
    viewC.setItem(KEY, val({ a: { v: "a" }, b: { v: "b" }, c: { v: "c" } }));
    expect(diskSessions()).toEqual({ b: { v: "b" }, c: { v: "c" } });

    // A freshly-hydrating view observes the final converged state.
    const viewFresh = createSafeJSONStorage<Sessions>({ mergeOnWrite: mergeSessions });
    expect(viewFresh.getItem(KEY)).toEqual(val({ b: { v: "b" }, c: { v: "c" } }));
  });

  it("createSafeJSONStorage mergeOnWrite advances the baseline to the writer's snapshot, not the merged result (#11351)", async () => {
    const backing = new Map<string, string>();
    installLocalStorage({
      getItem: (key) => backing.get(key) ?? null,
      setItem: (key, value) => {
        backing.set(key, value);
      },
      removeItem: (key) => {
        backing.delete(key);
      },
    });

    const { createSafeJSONStorage } = await import("../persistence/safeStorage");
    const { mergeRecordByWriterDelta } = await import("../persistence/persistWriteMerge");

    type Sessions = { sessions: Record<string, { v: string }> };
    const mergeSessions: PersistWriteMerge<Sessions> = ({ baseline, onDisk, incoming }) => {
      if (!onDisk) return incoming;
      return {
        version: incoming.version,
        state: {
          sessions: mergeRecordByWriterDelta(
            baseline?.state.sessions ?? {},
            incoming.state.sessions,
            onDisk.state.sessions ?? {}
          ),
        },
      };
    };
    const KEY = "merge-baseline";
    const val = (sessions: Sessions["sessions"]) => ({ state: { sessions }, version: 1 });
    const diskSessions = () =>
      (JSON.parse(backing.get(KEY) ?? "null") as { state: Sessions } | null)?.state.sessions;

    const viewA = createSafeJSONStorage<Sessions>({ mergeOnWrite: mergeSessions });
    viewA.getItem(KEY);
    viewA.setItem(KEY, val({ a: { v: "a" } })); // baseline advances to { a }

    // A sibling adds `b` on disk; the merged disk is now { a, b } but view A's
    // baseline must remain { a } — folding `b` into the baseline would make the
    // next unchanged write look like an intentional deletion of `b`.
    backing.set(KEY, JSON.stringify(val({ a: { v: "a" }, b: { v: "b" } })));

    // View A writes an unchanged snapshot repeatedly; `b` must survive every time.
    viewA.setItem(KEY, val({ a: { v: "a" } }));
    expect(diskSessions()).toEqual({ a: { v: "a" }, b: { v: "b" } });
    viewA.setItem(KEY, val({ a: { v: "a" } }));
    expect(diskSessions()).toEqual({ a: { v: "a" }, b: { v: "b" } });
  });

  it("createDebouncedSafeJSONStorage mergeOnWrite reads disk at flush time, not enqueue time (#11351)", async () => {
    vi.useFakeTimers();
    try {
      const backing = new Map<string, string>();
      installLocalStorage({
        getItem: (key) => backing.get(key) ?? null,
        setItem: (key, value) => {
          backing.set(key, value);
        },
        removeItem: (key) => {
          backing.delete(key);
        },
      });

      const { createDebouncedSafeJSONStorage } = await import("../persistence/safeStorage");
      const { mergeRecordByWriterDelta } = await import("../persistence/persistWriteMerge");

      type Sessions = { sessions: Record<string, { v: string }> };
      const mergeSessions: PersistWriteMerge<Sessions> = ({ baseline, onDisk, incoming }) => {
        if (!onDisk) return incoming;
        return {
          version: incoming.version,
          state: {
            sessions: mergeRecordByWriterDelta(
              baseline?.state.sessions ?? {},
              incoming.state.sessions,
              onDisk.state.sessions ?? {}
            ),
          },
        };
      };
      const KEY = "merge-debounced";
      const val = (sessions: Sessions["sessions"]) => ({ state: { sessions }, version: 1 });
      const diskSessions = () =>
        (JSON.parse(backing.get(KEY) ?? "null") as { state: Sessions } | null)?.state.sessions;

      const viewA = createDebouncedSafeJSONStorage<Sessions>(300, { mergeOnWrite: mergeSessions });
      viewA.getItem(KEY); // hydrate empty → baseline null
      viewA.setItem(KEY, val({ a: { v: "a" } }));
      vi.advanceTimersByTime(400); // flush → disk { a }, baseline { a }

      // Enqueue a change, THEN a sibling writes `b` before the debounce fires.
      viewA.setItem(KEY, val({ a: { v: "a2" } }));
      backing.set(KEY, JSON.stringify(val({ a: { v: "a" }, b: { v: "b" } })));
      vi.advanceTimersByTime(400); // flush must read disk NOW and preserve `b`

      expect(diskSessions()).toEqual({ a: { v: "a2" }, b: { v: "b" } });
    } finally {
      vi.useRealTimers();
    }
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
        getItem: (key) => (key === "daintree:cliAvailability:v3" ? "{corrupt" : null),
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

  it("createResilientStorage emits a set mark with ok:true and storage:'localStorage' on successful write", async () => {
    installLocalStorage(createStorageMock());
    const marks = seedPerfMarks();

    const { createSafeJSONStorage } = await import("../persistence/safeStorage");
    const storage = createSafeJSONStorage<{ value: number }>();

    const payload = { state: { value: 42 }, version: 1 };
    storage.setItem("tel-set-key", payload);

    const setMarks = marks.filter((m) => m.mark === "persistence_localstorage_set");
    expect(setMarks).toHaveLength(1);
    const meta = setMarks[0]?.meta ?? {};
    expect(meta.key).toBe("tel-set-key");
    expect(meta.ok).toBe(true);
    expect(meta.storage).toBe("localStorage");
    expect(meta.payloadBytes).toBe(new TextEncoder().encode(JSON.stringify(payload)).length);
    expect(typeof meta.durationMs).toBe("number");
    expect(Number.isFinite(meta.durationMs as number)).toBe(true);
    expect((meta.durationMs as number) >= 0).toBe(true);
  });

  it("createResilientStorage emits a get mark with ok:true and storage:'localStorage' on successful read", async () => {
    installLocalStorage(createStorageMock());
    const marks = seedPerfMarks();

    const { createSafeJSONStorage } = await import("../persistence/safeStorage");
    const storage = createSafeJSONStorage<{ value: number }>();
    const payload = { state: { value: 1 }, version: 1 };
    storage.setItem("tel-get-key", payload);
    marks.length = 0;

    storage.getItem("tel-get-key");

    const getMarks = marks.filter((m) => m.mark === "persistence_localstorage_get");
    expect(getMarks).toHaveLength(1);
    const meta = getMarks[0]?.meta ?? {};
    expect(meta.key).toBe("tel-get-key");
    expect(meta.ok).toBe(true);
    expect(meta.storage).toBe("localStorage");
    expect(meta.payloadBytes).toBe(new TextEncoder().encode(JSON.stringify(payload)).length);
    expect(typeof meta.durationMs).toBe("number");
    expect(Number.isFinite(meta.durationMs as number)).toBe(true);
    expect((meta.durationMs as number) >= 0).toBe(true);
  });

  it("createResilientStorage emits a set mark with ok:false and storage:'localStorage' when the localStorage write throws", async () => {
    installLocalStorage(
      createStorageMock({
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      })
    );
    const marks = seedPerfMarks();

    const { createSafeJSONStorage } = await import("../persistence/safeStorage");
    const storage = createSafeJSONStorage<{ value: number }>();

    expect(() => {
      storage.setItem("tel-fail-key", { state: { value: 9 }, version: 1 });
    }).not.toThrow();

    const setMarks = marks.filter((m) => m.mark === "persistence_localstorage_set");
    expect(setMarks).toHaveLength(1);
    const meta = setMarks[0]?.meta ?? {};
    expect(meta.key).toBe("tel-fail-key");
    expect(meta.ok).toBe(false);
    expect(meta.storage).toBe("localStorage");
    expect(typeof meta.durationMs).toBe("number");
    expect(Number.isFinite(meta.durationMs as number)).toBe(true);
  });

  it("createResilientStorage emits a get mark with ok:false and storage:'localStorage' when the localStorage read throws", async () => {
    const throwingGetItem = vi.fn(() => {
      throw new Error("SecurityError");
    });
    installLocalStorage(
      createStorageMock({
        getItem: throwingGetItem,
      })
    );
    const marks = seedPerfMarks();

    const { createSafeJSONStorage } = await import("../persistence/safeStorage");
    const storage = createSafeJSONStorage<{ value: number }>();

    expect(() => storage.getItem("tel-err-key")).not.toThrow();

    const getMarks = marks.filter((m) => m.mark === "persistence_localstorage_get");
    expect(getMarks).toHaveLength(1);
    const meta = getMarks[0]?.meta ?? {};
    expect(meta.key).toBe("tel-err-key");
    expect(meta.ok).toBe(false);
    expect(meta.storage).toBe("localStorage");
    expect(meta.payloadBytes).toBeNull();
    expect(typeof meta.durationMs).toBe("number");
    expect(Number.isFinite(meta.durationMs as number)).toBe(true);
  });

  it("createResilientStorage flips storage to 'memory' and stops hitting broken localStorage after fallback", async () => {
    const throwingSetItem = vi.fn(() => {
      throw new Error("QuotaExceededError");
    });
    installLocalStorage(
      createStorageMock({
        setItem: throwingSetItem,
      })
    );
    const marks = seedPerfMarks();

    const { createSafeJSONStorage } = await import("../persistence/safeStorage");
    const storage = createSafeJSONStorage<{ value: number }>();

    storage.setItem("fallback-key", { state: { value: 1 }, version: 1 });
    storage.setItem("fallback-key-2", { state: { value: 2 }, version: 1 });

    const setMarks = marks.filter((m) => m.mark === "persistence_localstorage_set");
    expect(setMarks).toHaveLength(2);
    expect(setMarks[0]?.meta?.storage).toBe("localStorage");
    expect(setMarks[0]?.meta?.ok).toBe(false);
    expect(setMarks[1]?.meta?.storage).toBe("memory");
    expect(setMarks[1]?.meta?.ok).toBe(true);

    // Broken localStorage.setItem must only be called once — fallback sticks
    expect(throwingSetItem).toHaveBeenCalledTimes(1);

    // Subsequent reads of the in-memory value also emit storage:'memory'
    storage.getItem("fallback-key");
    const getMarks = marks.filter((m) => m.mark === "persistence_localstorage_get");
    expect(getMarks).toHaveLength(1);
    expect(getMarks[0]?.meta?.storage).toBe("memory");
    expect(getMarks[0]?.meta?.ok).toBe(true);
  });

  it("createSafeJSONStorage.getItem recovers from the backup key when the primary blob is corrupt", async () => {
    const backup = JSON.stringify({ state: { value: 99 }, version: 1 });
    installLocalStorage(
      createStorageMock({
        getItem: (key) => {
          if (key === "recover-key") return "{corrupt";
          if (key === "recover-key.__bak") return backup;
          return null;
        },
      })
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { createSafeJSONStorage } = await import("../persistence/safeStorage");
    const storage = createSafeJSONStorage<{ value: number }>();

    expect(storage.getItem("recover-key")).toEqual({ state: { value: 99 }, version: 1 });
    const recoveredWarn = warnSpy.mock.calls.find((call) =>
      String(call[0]).includes("recovered from backup")
    );
    expect(recoveredWarn).toBeDefined();
  });

  it("createSafeJSONStorage.setItem writes a backup copy alongside the primary key", async () => {
    const mock = createStorageMock();
    installLocalStorage(mock);

    const { createSafeJSONStorage } = await import("../persistence/safeStorage");
    const storage = createSafeJSONStorage<{ value: number }>();

    storage.setItem("backup-write-key", { state: { value: 5 }, version: 1 });

    expect(mock.getItem("backup-write-key.__bak")).toBe(
      JSON.stringify({ state: { value: 5 }, version: 1 })
    );
  });

  it("createSafeJSONStorage.getItem returns null when both primary and backup are corrupt", async () => {
    installLocalStorage(
      createStorageMock({
        getItem: (key) =>
          key === "both-corrupt" ? "{corrupt" : key === "both-corrupt.__bak" ? "{also-bad" : null,
      })
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { createSafeJSONStorage } = await import("../persistence/safeStorage");
    const storage = createSafeJSONStorage<{ value: number }>();

    expect(storage.getItem("both-corrupt")).toBeNull();
    const resetWarn = warnSpy.mock.calls.find((call) =>
      String(call[0]).includes("resetting to defaults")
    );
    expect(resetWarn).toBeDefined();
  });

  it("createResilientStorage treats QuotaExceededError as transient and keeps using localStorage", async () => {
    let setCalls = 0;
    const written = new Map<string, string>();
    installLocalStorage(
      createStorageMock({
        setItem: (key, value) => {
          setCalls += 1;
          if (setCalls === 1) {
            throw new DOMException("Quota exceeded", "QuotaExceededError");
          }
          written.set(key, value);
        },
      })
    );
    const marks = seedPerfMarks();

    const { createSafeJSONStorage } = await import("../persistence/safeStorage");
    const storage = createSafeJSONStorage<{ value: number }>();

    storage.setItem("quota-key-1", { state: { value: 1 }, version: 1 });
    storage.setItem("quota-key-2", { state: { value: 2 }, version: 1 });

    const setMarks = marks.filter((m) => m.mark === "persistence_localstorage_set");
    // Second write must still target localStorage — no permanent memory fallback.
    expect(setMarks[1]?.meta?.storage).toBe("localStorage");
    expect(setMarks[1]?.meta?.ok).toBe(true);
    expect(written.get("quota-key-2")).toBe(JSON.stringify({ state: { value: 2 }, version: 1 }));
  });

  it("does not advance the backup when the primary write hits a quota error", async () => {
    const backend = new Map<string, string>();
    const good = JSON.stringify({ state: { value: 1 }, version: 1 });
    backend.set("stale-key", good);
    backend.set("stale-key.__bak", good);
    installLocalStorage(
      createStorageMock({
        getItem: (key) => backend.get(key) ?? null,
        setItem: (key, value) => {
          if (key === "stale-key") {
            throw new DOMException("Quota exceeded", "QuotaExceededError");
          }
          backend.set(key, value);
        },
        removeItem: (key) => {
          backend.delete(key);
        },
      })
    );

    const { createSafeJSONStorage } = await import("../persistence/safeStorage");
    const storage = createSafeJSONStorage<{ value: number }>();

    storage.setItem("stale-key", { state: { value: 2 }, version: 1 });

    // Primary write quota-failed and kept the old value — the backup must NOT
    // advance to the new value, or a later recovery would surface stale state.
    expect(backend.get("stale-key.__bak")).toBe(good);
  });

  it("removeItem clears both the primary key and its backup", async () => {
    const mock = createStorageMock();
    installLocalStorage(mock);

    const { createSafeJSONStorage } = await import("../persistence/safeStorage");
    const storage = createSafeJSONStorage<{ value: number }>();

    storage.setItem("rm-key", { state: { value: 1 }, version: 1 });
    expect(mock.getItem("rm-key")).not.toBeNull();
    expect(mock.getItem("rm-key.__bak")).not.toBeNull();

    storage.removeItem("rm-key");
    expect(mock.getItem("rm-key")).toBeNull();
    expect(mock.getItem("rm-key.__bak")).toBeNull();
  });

  it("recovers from a backup written by an earlier setItem on the same instance", async () => {
    const backend = new Map<string, string>();
    installLocalStorage(
      createStorageMock({
        getItem: (key) => backend.get(key) ?? null,
        setItem: (key, value) => {
          backend.set(key, value);
        },
        removeItem: (key) => {
          backend.delete(key);
        },
      })
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { createSafeJSONStorage } = await import("../persistence/safeStorage");
    const storage = createSafeJSONStorage<{ value: number }>();

    storage.setItem("e2e-key", { state: { value: 7 }, version: 1 });
    // Corrupt only the primary; the backup written by setItem stays intact.
    backend.set("e2e-key", "{corrupt");

    expect(storage.getItem("e2e-key")).toEqual({ state: { value: 7 }, version: 1 });
    expect(
      warnSpy.mock.calls.some((call) => String(call[0]).includes("recovered from backup"))
    ).toBe(true);
  });

  it("notifies exactly once when a permanent structural fallback occurs", async () => {
    const notifySpy = vi.fn();
    installLocalStorage(
      createStorageMock({
        setItem: () => {
          // Plain Error (not a quota DOMException) → permanent fallback.
          throw new Error("SecurityError");
        },
      })
    );

    const { createSafeJSONStorage, setPermanentFallbackHandler } =
      await import("../persistence/safeStorage");
    setPermanentFallbackHandler(notifySpy);
    try {
      const storage = createSafeJSONStorage<{ value: number }>();
      storage.setItem("notify-key-1", { state: { value: 1 }, version: 1 });
      storage.setItem("notify-key-2", { state: { value: 2 }, version: 1 });

      // Dispatch is synchronous (handler-based, not dynamic import) so the
      // per-instance `hasNotifiedPermanentFallback` guard pins the count to
      // exactly 1 regardless of how many failing setItems we issue.
      expect(notifySpy).toHaveBeenCalledTimes(1);
    } finally {
      setPermanentFallbackHandler(null);
    }
  });

  it("preferencesStore clamps a corrupt closed-set field at the current version via merge", async () => {
    installLocalStorage(
      createStorageMock({
        getItem: (key) =>
          key === "daintree-preferences"
            ? JSON.stringify({
                state: {
                  dockDensity: "dense",
                  diffViewType: "side-by-side",
                  skipPushConfirmByWorktreePath: "all",
                },
                version: 9,
              })
            : null,
      })
    );

    const { usePreferencesStore } = await import("../preferencesStore");

    const state = usePreferencesStore.getState();
    expect(state.dockDensity).toBe("normal");
    expect(state.diffViewType).toBe("split");
    expect(state.skipPushConfirmByWorktreePath).toEqual({});
  });

  it("createResilientStorage emits no marks when DAINTREE_PERF_MARKS is absent and capture is disabled", async () => {
    installLocalStorage(createStorageMock());

    const { createSafeJSONStorage } = await import("../persistence/safeStorage");
    const storage = createSafeJSONStorage<{ value: number }>();

    storage.setItem("no-mark-key", { state: { value: 5 }, version: 1 });
    storage.getItem("no-mark-key");

    expect((window as Window & typeof globalThis).__DAINTREE_PERF_MARKS__).toBeUndefined();
  });

  describe("createDebouncedSafeJSONStorage", () => {
    it("coalesces rapid setItem calls into one underlying write per key", async () => {
      const setItem = vi.fn();
      installLocalStorage(
        createStorageMock({
          setItem,
        })
      );
      vi.useFakeTimers();

      const { createDebouncedSafeJSONStorage } = await import("../persistence/safeStorage");
      const storage = createDebouncedSafeJSONStorage<{ value: number }>(300);

      storage.setItem("k", { state: { value: 1 }, version: 1 });
      storage.setItem("k", { state: { value: 2 }, version: 1 });
      storage.setItem("k", { state: { value: 3 }, version: 1 });

      expect(setItem).toHaveBeenCalledTimes(0);

      vi.advanceTimersByTime(300);

      // One coalesced primary write (the backup write targets the `.__bak` key).
      expect(setItem.mock.calls.filter(([key]) => key === "k")).toHaveLength(1);
      expect(setItem).toHaveBeenCalledWith(
        "k",
        JSON.stringify({ state: { value: 3 }, version: 1 })
      );

      vi.useRealTimers();
    });

    it("removeItem cancels any pending debounced write for the same key", async () => {
      const setItem = vi.fn();
      const removeItem = vi.fn();
      installLocalStorage(
        createStorageMock({
          setItem,
          removeItem,
        })
      );
      vi.useFakeTimers();

      const { createDebouncedSafeJSONStorage } = await import("../persistence/safeStorage");
      const storage = createDebouncedSafeJSONStorage<{ value: number }>(300);

      storage.setItem("k", { state: { value: 1 }, version: 1 });
      storage.removeItem("k");
      vi.advanceTimersByTime(1000);

      expect(setItem).not.toHaveBeenCalled();
      expect(removeItem).toHaveBeenCalledWith("k");

      vi.useRealTimers();
    });

    it("getItem flushes any pending write so reads-after-writes are coherent", async () => {
      const backing = new Map<string, string>();
      const setItem = vi.fn((key: string, value: string) => {
        backing.set(key, value);
      });
      installLocalStorage(
        createStorageMock({
          getItem: (key) => backing.get(key) ?? null,
          setItem,
        })
      );
      vi.useFakeTimers();

      const { createDebouncedSafeJSONStorage } = await import("../persistence/safeStorage");
      const storage = createDebouncedSafeJSONStorage<{ value: number }>(300);

      storage.setItem("k", { state: { value: 42 }, version: 1 });
      // No timer advance — getItem must flush.
      const result = storage.getItem("k");

      // One coalesced primary write (the backup write targets the `.__bak` key).
      expect(setItem.mock.calls.filter(([key]) => key === "k")).toHaveLength(1);
      expect(result).toEqual({ state: { value: 42 }, version: 1 });

      vi.useRealTimers();
    });

    it("falls back to memory storage when localStorage.setItem throws", async () => {
      const setItem = vi.fn(() => {
        throw new Error("QuotaExceededError");
      });
      installLocalStorage(
        createStorageMock({
          setItem,
        })
      );
      vi.useFakeTimers();

      const { createDebouncedSafeJSONStorage } = await import("../persistence/safeStorage");
      const storage = createDebouncedSafeJSONStorage<{ value: number }>(300);

      expect(() => {
        storage.setItem("k", { state: { value: 1 }, version: 1 });
        vi.advanceTimersByTime(300);
      }).not.toThrow();

      // First write failed; resilient storage flips to memory. A subsequent
      // write should land in memory without re-throwing.
      storage.setItem("k", { state: { value: 2 }, version: 1 });
      vi.advanceTimersByTime(300);

      vi.useRealTimers();
    });

    it("debounce timers are scoped per key (independent flush windows)", async () => {
      const setItem = vi.fn();
      installLocalStorage(
        createStorageMock({
          setItem,
        })
      );
      vi.useFakeTimers();

      const { createDebouncedSafeJSONStorage } = await import("../persistence/safeStorage");
      const storage = createDebouncedSafeJSONStorage<{ value: number }>(300);

      storage.setItem("a", { state: { value: 1 }, version: 1 });
      vi.advanceTimersByTime(150);
      storage.setItem("b", { state: { value: 2 }, version: 1 });
      vi.advanceTimersByTime(150);

      // 'a' has flushed; 'b' has 150ms remaining (count primary writes only —
      // each durable flush also writes a `.__bak` backup copy).
      expect(setItem.mock.calls.filter(([key]) => key === "a")).toHaveLength(1);
      expect(setItem.mock.calls.filter(([key]) => key === "b")).toHaveLength(0);
      expect(setItem).toHaveBeenCalledWith("a", expect.any(String));

      vi.advanceTimersByTime(150);
      expect(setItem.mock.calls.filter(([key]) => key === "b")).toHaveLength(1);
      expect(setItem).toHaveBeenCalledWith("b", expect.any(String));

      vi.useRealTimers();
    });

    it("writes a backup copy alongside the primary key after a durable flush", async () => {
      const backing = new Map<string, string>();
      installLocalStorage(
        createStorageMock({
          getItem: (key) => backing.get(key) ?? null,
          setItem: (key, value) => {
            backing.set(key, value);
          },
        })
      );
      vi.useFakeTimers();

      const { createDebouncedSafeJSONStorage } = await import("../persistence/safeStorage");
      const storage = createDebouncedSafeJSONStorage<{ value: number }>(300);

      storage.setItem("backup-key", { state: { value: 5 }, version: 1 });
      vi.advanceTimersByTime(300);

      expect(backing.get("backup-key.__bak")).toBe(
        JSON.stringify({ state: { value: 5 }, version: 1 })
      );

      vi.useRealTimers();
    });

    it("does not advance the backup when the primary flush hits a quota error", async () => {
      const backing = new Map<string, string>();
      const good = JSON.stringify({ state: { value: 1 }, version: 1 });
      backing.set("stale-key", good);
      backing.set("stale-key.__bak", good);
      installLocalStorage(
        createStorageMock({
          getItem: (key) => backing.get(key) ?? null,
          setItem: (key, value) => {
            // Quota only on the primary key — let backup writes through so the
            // assertion proves the backup was never *attempted*, not just blocked.
            if (key === "stale-key") {
              throw new DOMException("Quota exceeded", "QuotaExceededError");
            }
            backing.set(key, value);
          },
        })
      );
      vi.useFakeTimers();

      const { createDebouncedSafeJSONStorage } = await import("../persistence/safeStorage");
      const storage = createDebouncedSafeJSONStorage<{ value: number }>(300);

      storage.setItem("stale-key", { state: { value: 2 }, version: 1 });
      vi.advanceTimersByTime(300);

      // Primary write failed → backup must keep the previous good value.
      expect(backing.get("stale-key.__bak")).toBe(good);

      vi.useRealTimers();
    });

    it("getItem recovers from the backup key when the primary blob is corrupt", async () => {
      const backup = JSON.stringify({ state: { value: 9 }, version: 1 });
      installLocalStorage(
        createStorageMock({
          getItem: (key) => {
            if (key === "recover-key") return "{corrupt";
            if (key === "recover-key.__bak") return backup;
            return null;
          },
        })
      );
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { createDebouncedSafeJSONStorage } = await import("../persistence/safeStorage");
      const storage = createDebouncedSafeJSONStorage<{ value: number }>(300);

      const result = storage.getItem("recover-key");

      expect(result).toEqual({ state: { value: 9 }, version: 1 });
      expect(warnSpy).toHaveBeenCalledWith(
        "[safeStorage] corrupt persisted state, recovered from backup",
        expect.objectContaining({ key: "recover-key" })
      );
    });

    it("removeItem clears both the primary key and its backup", async () => {
      const backing = new Map<string, string>();
      installLocalStorage(
        createStorageMock({
          getItem: (key) => backing.get(key) ?? null,
          setItem: (key, value) => {
            backing.set(key, value);
          },
          removeItem: (key) => {
            backing.delete(key);
          },
        })
      );
      vi.useFakeTimers();

      const { createDebouncedSafeJSONStorage } = await import("../persistence/safeStorage");
      const storage = createDebouncedSafeJSONStorage<{ value: number }>(300);

      storage.setItem("rm-key", { state: { value: 1 }, version: 1 });
      vi.advanceTimersByTime(300);
      expect(backing.get("rm-key.__bak")).not.toBeUndefined();

      storage.removeItem("rm-key");

      expect(backing.get("rm-key")).toBeUndefined();
      expect(backing.get("rm-key.__bak")).toBeUndefined();

      vi.useRealTimers();
    });

    it("recovers from a backup written by an earlier flush on the same instance", async () => {
      const backing = new Map<string, string>();
      installLocalStorage(
        createStorageMock({
          getItem: (key) => backing.get(key) ?? null,
          setItem: (key, value) => {
            backing.set(key, value);
          },
        })
      );
      vi.useFakeTimers();

      const { createDebouncedSafeJSONStorage } = await import("../persistence/safeStorage");
      const storage = createDebouncedSafeJSONStorage<{ value: number }>(300);

      storage.setItem("e2e-key", { state: { value: 7 }, version: 1 });
      vi.advanceTimersByTime(300);
      // Corrupt only the primary; the backup written by the flush stays intact.
      backing.set("e2e-key", "{corrupt");

      expect(storage.getItem("e2e-key")).toEqual({ state: { value: 7 }, version: 1 });

      vi.useRealTimers();
    });

    it("getItem returns null when both the primary and backup are corrupt", async () => {
      installLocalStorage(
        createStorageMock({
          getItem: (key) =>
            key === "both-corrupt" ? "{corrupt" : key === "both-corrupt.__bak" ? "{also-bad" : null,
        })
      );
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { createDebouncedSafeJSONStorage } = await import("../persistence/safeStorage");
      const storage = createDebouncedSafeJSONStorage<{ value: number }>(300);

      expect(storage.getItem("both-corrupt")).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        "[safeStorage] corrupt persisted state, resetting to defaults",
        expect.objectContaining({ key: "both-corrupt" })
      );
    });

    it("writes the backup on a getItem-triggered flush, not just the timer path", async () => {
      const backing = new Map<string, string>();
      installLocalStorage(
        createStorageMock({
          getItem: (key) => backing.get(key) ?? null,
          setItem: (key, value) => {
            backing.set(key, value);
          },
        })
      );
      vi.useFakeTimers();

      const { createDebouncedSafeJSONStorage } = await import("../persistence/safeStorage");
      const storage = createDebouncedSafeJSONStorage<{ value: number }>(300);

      storage.setItem("flush-read-key", { state: { value: 3 }, version: 1 });
      // No timer advance — the read forces a synchronous flush, which must also
      // advance the backup just like the timer-driven flush does.
      storage.getItem("flush-read-key");

      expect(backing.get("flush-read-key.__bak")).toBe(
        JSON.stringify({ state: { value: 3 }, version: 1 })
      );

      vi.useRealTimers();
    });

    it("keeps using localStorage after a transient quota error (no permanent fallback)", async () => {
      const backing = new Map<string, string>();
      let primaryWrites = 0;
      installLocalStorage(
        createStorageMock({
          getItem: (key) => backing.get(key) ?? null,
          setItem: (key, value) => {
            // Transient quota error on the very first primary write only.
            if (key === "q1") {
              primaryWrites += 1;
              if (primaryWrites === 1) {
                throw new DOMException("Quota exceeded", "QuotaExceededError");
              }
            }
            backing.set(key, value);
          },
        })
      );
      vi.useFakeTimers();

      const { createDebouncedSafeJSONStorage } = await import("../persistence/safeStorage");
      const storage = createDebouncedSafeJSONStorage<{ value: number }>(300);

      storage.setItem("q1", { state: { value: 1 }, version: 1 });
      vi.advanceTimersByTime(300);
      // Second write to a different key must still reach localStorage — a
      // transient quota error must not flip the resilient storage to memory.
      storage.setItem("q2", { state: { value: 2 }, version: 1 });
      vi.advanceTimersByTime(300);

      expect(backing.get("q2")).toBe(JSON.stringify({ state: { value: 2 }, version: 1 }));

      vi.useRealTimers();
    });
  });
});
