import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { UrlHistoryEntry } from "@shared/types/browser";

/**
 * Cross-view write-merge coverage for the shared localStorage partition
 * (issue #11351). Direct analog to commandHistoryStore: `entries` is a
 * `Record<projectId, UrlHistoryEntry[]>`, so a stale view writing its own project
 * must not wipe a sibling project's history. Storage is debounced (300ms), so
 * writes are driven with fake timers.
 */
describe("urlHistoryStore cross-view write merge (#11351)", () => {
  const STORAGE_KEY = "daintree-url-history";
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

  type PersistedBlob = { version: number; state: { entries: Record<string, UrlHistoryEntry[]> } };

  // Pinned clock so the sibling entry stays inside the 90-day retention window the
  // reconciler's `migrateEntries` normalization enforces on every input.
  const NOW = 1_800_000_000_000;

  const siblingEntry: UrlHistoryEntry = {
    url: "https://sibling.example/",
    title: "Sibling",
    visitCount: 3,
    lastVisitAt: NOW - 1000,
  };

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

  function readBlob(backing: Map<string, string>): PersistedBlob {
    const blob: PersistedBlob = JSON.parse(backing.get(STORAGE_KEY)!);
    return blob;
  }

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreLocalStorage();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("a fresh view's visit does not clobber a sibling project's history", async () => {
    const backing = installLocalStorage({});
    const { useUrlHistoryStore: store } = await import("../urlHistoryStore");
    vi.advanceTimersByTime(400); // drain any hydration-triggered write

    backing.set(
      STORAGE_KEY,
      JSON.stringify({ version: 1, state: { entries: { "proj-b": [siblingEntry] } } })
    );

    store.getState().recordVisit("proj-a", "https://a.example/");
    vi.advanceTimersByTime(400);

    const written = readBlob(backing);
    expect(Object.keys(written.state.entries).sort()).toEqual(["proj-a", "proj-b"]);
    expect(written.state.entries["proj-b"]).toHaveLength(1);
    expect(written.state.entries["proj-b"]?.[0]?.title).toBe("Sibling");
  });

  it("a sibling's visit written during the debounce window survives this view's flush", async () => {
    const backing = installLocalStorage({});
    const { useUrlHistoryStore: store } = await import("../urlHistoryStore");
    vi.advanceTimersByTime(400);

    // This view records project A and lets it settle.
    store.getState().recordVisit("proj-a", "https://a.example/");
    vi.advanceTimersByTime(400);

    // This view enqueues a SECOND A visit — pending, not yet flushed.
    store.getState().recordVisit("proj-a", "https://a2.example/");

    // A sibling records project B directly to disk DURING the pending debounce
    // window. The flush must read disk at flush time to preserve it.
    const disk = readBlob(backing);
    disk.state.entries["proj-b"] = [siblingEntry];
    backing.set(STORAGE_KEY, JSON.stringify(disk));

    vi.advanceTimersByTime(400);

    const written = readBlob(backing);
    expect(Object.keys(written.state.entries).sort()).toEqual(["proj-a", "proj-b"]);
    expect(written.state.entries["proj-b"]).toHaveLength(1);
    expect(written.state.entries["proj-b"]?.[0]?.title).toBe("Sibling");
    expect(written.state.entries["proj-a"]).toHaveLength(2);
  });

  it("does not resurrect a project's history this view removed, and keeps a sibling's", async () => {
    const backing = installLocalStorage({});
    const { useUrlHistoryStore: store } = await import("../urlHistoryStore");
    vi.advanceTimersByTime(400);

    store.getState().recordVisit("proj-a", "https://a.example/");
    vi.advanceTimersByTime(400);

    const disk = readBlob(backing);
    disk.state.entries["proj-b"] = [siblingEntry];
    backing.set(STORAGE_KEY, JSON.stringify(disk));

    store.getState().removeProjectHistory("proj-a");
    vi.advanceTimersByTime(400);

    const written = readBlob(backing);
    expect(written.state.entries["proj-a"]).toBeUndefined();
    expect(written.state.entries["proj-b"]).toHaveLength(1);
    expect(written.state.entries["proj-b"]?.[0]?.title).toBe("Sibling");
  });
});
