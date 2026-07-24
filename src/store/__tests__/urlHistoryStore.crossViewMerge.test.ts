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

  const siblingEntry: UrlHistoryEntry = {
    url: "https://sibling.example/",
    title: "Sibling",
    visitCount: 3,
    lastVisitAt: 1_700_000_000_000,
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
    return JSON.parse(backing.get(STORAGE_KEY)!) as PersistedBlob;
  }

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
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
    expect(written.state.entries["proj-b"]).toEqual([siblingEntry]);
  });

  it("a sibling's visit written during the debounce window survives this view's flush", async () => {
    const backing = installLocalStorage({});
    const { useUrlHistoryStore: store } = await import("../urlHistoryStore");
    vi.advanceTimersByTime(400);

    // This view records project A.
    store.getState().recordVisit("proj-a", "https://a.example/");
    vi.advanceTimersByTime(400);

    // A sibling records project B directly to the shared blob.
    const disk = readBlob(backing);
    disk.state.entries["proj-b"] = [siblingEntry];
    backing.set(STORAGE_KEY, JSON.stringify(disk));

    // This stale view records another A visit.
    store.getState().recordVisit("proj-a", "https://a2.example/");
    vi.advanceTimersByTime(400);

    const written = readBlob(backing);
    expect(Object.keys(written.state.entries).sort()).toEqual(["proj-a", "proj-b"]);
    expect(written.state.entries["proj-b"]).toEqual([siblingEntry]);
    expect(written.state.entries["proj-a"]!.map((e) => e.url).sort()).toEqual([
      "https://a.example/",
      "https://a2.example/",
    ]);
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
    expect(written.state.entries["proj-b"]).toEqual([siblingEntry]);
  });
});
