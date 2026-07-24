import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Cross-view write-merge coverage for the shared localStorage partition
 * (issue #11351). A stale project view must not clobber a sibling view's
 * concurrent writes to the same key. Mirrors the commandHistoryStore pattern:
 * a Map-backed fake localStorage, a fresh module per test (fresh baseline =
 * fresh WebContentsView), and a sibling simulated by mutating the backing map.
 */
describe("terminalSearchHistoryStore cross-view write merge (#11351)", () => {
  const STORAGE_KEY = "daintree-terminal-search-history";
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

  type PersistedBlob = {
    version: number;
    state: { searches: string[]; caseSensitive: boolean; regexEnabled: boolean };
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
  });

  afterEach(() => {
    restoreLocalStorage();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("a fresh view's toggle change preserves a sibling's searches and non-default toggle", async () => {
    const backing = installLocalStorage({});
    const { useTerminalSearchHistoryStore: store } = await import("../terminalSearchHistoryStore");

    // A sibling view populated the shared blob before this fresh view writes.
    backing.set(
      STORAGE_KEY,
      JSON.stringify({
        version: 0,
        state: { searches: ["sibling"], caseSensitive: true, regexEnabled: false },
      })
    );

    // This fresh view (null baseline) changes only a toggle — its default empty
    // searches / regex must not clobber the sibling.
    store.getState().setToggles(true, true);

    const written = readBlob(backing);
    expect(written.state.searches).toEqual(["sibling"]);
    expect(written.state.caseSensitive).toBe(true);
    expect(written.state.regexEnabled).toBe(true);
  });

  it("a stale view's addSearch preserves a sibling's concurrent search (MRU replay)", async () => {
    const backing = installLocalStorage({});
    const { useTerminalSearchHistoryStore: store } = await import("../terminalSearchHistoryStore");

    // This view records "a" to the shared partition.
    store.getState().addSearch("a");

    // A sibling view records "b" directly to the shared blob.
    const disk = readBlob(backing);
    disk.state.searches = ["b", "a"];
    backing.set(STORAGE_KEY, JSON.stringify(disk));

    // This stale view — which never learned about "b" — records "c".
    store.getState().addSearch("c");

    const written = readBlob(backing);
    // "c" moves to front; the sibling's "b" survives.
    expect(written.state.searches).toEqual(["c", "b", "a"]);
  });

  it("a toggle-only write keeps a sibling's searches and applies the independent toggle", async () => {
    const backing = installLocalStorage({});
    const { useTerminalSearchHistoryStore: store } = await import("../terminalSearchHistoryStore");

    backing.set(
      STORAGE_KEY,
      JSON.stringify({
        version: 0,
        state: { searches: ["s1", "s2"], caseSensitive: false, regexEnabled: false },
      })
    );

    store.getState().setToggles(true, false);

    const written = readBlob(backing);
    expect(written.state.searches).toEqual(["s1", "s2"]);
    expect(written.state.caseSensitive).toBe(true);
    expect(written.state.regexEnabled).toBe(false);
  });
});
