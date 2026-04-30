// @vitest-environment jsdom
import { afterEach, describe, it, expect, beforeEach, vi } from "vitest";
import { useUrlHistoryStore, frecencyScore, getFrecencySuggestions } from "../urlHistoryStore";
import type { UrlHistoryEntry } from "@shared/types/browser";

describe("urlHistoryStore", () => {
  beforeEach(() => {
    useUrlHistoryStore.setState({ entries: {} });
  });

  it("records a new visit", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "http://localhost:3000/", "Home");
    const entries = useUrlHistoryStore.getState().entries["proj1"];
    expect(entries).toHaveLength(1);
    expect(entries![0]!.url).toBe("http://localhost:3000/");
    expect(entries![0]!.title).toBe("Home");
    expect(entries![0]!.visitCount).toBe(1);
  });

  it("increments visitCount on repeated visits", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "http://localhost:3000/", "Home");
    store.recordVisit("proj1", "http://localhost:3000/", "Home");
    store.recordVisit("proj1", "http://localhost:3000/", "Home");
    const entries = useUrlHistoryStore.getState().entries["proj1"];
    expect(entries).toHaveLength(1);
    expect(entries![0]!.visitCount).toBe(3);
  });

  it("updates title on repeated visit with new title", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "http://localhost:3000/", "Old Title");
    store.recordVisit("proj1", "http://localhost:3000/", "New Title");
    const entries = useUrlHistoryStore.getState().entries["proj1"];
    expect(entries![0]!.title).toBe("New Title");
  });

  it("keeps existing title when new title is empty", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "http://localhost:3000/", "My Title");
    store.recordVisit("proj1", "http://localhost:3000/");
    const entries = useUrlHistoryStore.getState().entries["proj1"];
    expect(entries![0]!.title).toBe("My Title");
  });

  it("isolates entries by project", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "http://localhost:3000/", "P1");
    store.recordVisit("proj2", "http://localhost:5173/", "P2");
    expect(useUrlHistoryStore.getState().entries["proj1"]).toHaveLength(1);
    expect(useUrlHistoryStore.getState().entries["proj2"]).toHaveLength(1);
    expect(useUrlHistoryStore.getState().entries["proj1"]![0]!.url).toBe("http://localhost:3000/");
    expect(useUrlHistoryStore.getState().entries["proj2"]![0]!.url).toBe("http://localhost:5173/");
  });

  it("updateTitle updates title for an existing entry", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "http://localhost:3000/", "Old");
    store.updateTitle("proj1", "http://localhost:3000/", "New Title");
    const entries = useUrlHistoryStore.getState().entries["proj1"];
    expect(entries![0]!.title).toBe("New Title");
  });

  it("updateTitle is a no-op for non-existent URL", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "http://localhost:3000/", "Title");
    store.updateTitle("proj1", "http://localhost:5000/", "New");
    expect(useUrlHistoryStore.getState().entries["proj1"]).toHaveLength(1);
    expect(useUrlHistoryStore.getState().entries["proj1"]![0]!.title).toBe("Title");
  });

  it("removeProjectHistory clears all entries for a project", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "http://localhost:3000/", "P1");
    store.recordVisit("proj2", "http://localhost:5173/", "P2");
    store.removeProjectHistory("proj1");
    expect(useUrlHistoryStore.getState().entries["proj1"]).toBeUndefined();
    expect(useUrlHistoryStore.getState().entries["proj2"]).toHaveLength(1);
  });

  it("updateFavicon sets favicon for an existing entry", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "http://localhost:3000/", "Home");
    store.updateFavicon("proj1", "http://localhost:3000/", "https://example.com/favicon.ico");
    const entries = useUrlHistoryStore.getState().entries["proj1"];
    expect(entries![0]!.favicon).toBe("https://example.com/favicon.ico");
  });

  it("updateFavicon creates entry for non-existent URL", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "http://localhost:3000/", "Title");
    store.updateFavicon("proj1", "http://localhost:5000/", "https://other.com/favicon.ico");
    const entries = useUrlHistoryStore.getState().entries["proj1"]!;
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.url === "http://localhost:5000/")!.favicon).toBe(
      "https://other.com/favicon.ico"
    );
  });

  it("removeUrl removes a specific entry by URL", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "http://localhost:3000/", "A");
    store.recordVisit("proj1", "http://localhost:5173/", "B");
    store.removeUrl("proj1", "http://localhost:3000/");
    const entries = useUrlHistoryStore.getState().entries["proj1"];
    expect(entries).toHaveLength(1);
    expect(entries![0]!.url).toBe("http://localhost:5173/");
  });

  it("removeUrl is a no-op for non-existent URL", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "http://localhost:3000/", "A");
    store.removeUrl("proj1", "http://localhost:9999/");
    expect(useUrlHistoryStore.getState().entries["proj1"]).toHaveLength(1);
  });

  it("hydrates legacy entries without favicon field", () => {
    useUrlHistoryStore.setState({
      entries: {
        proj1: [
          {
            url: "http://localhost:3000/",
            title: "Legacy",
            visitCount: 1,
            lastVisitAt: Date.now(),
          },
        ],
      },
    });
    const entries = useUrlHistoryStore.getState().entries["proj1"];
    expect(entries![0]!.favicon).toBeUndefined();
    // Store methods still work on legacy entries
    useUrlHistoryStore.getState().updateFavicon("proj1", "http://localhost:3000/", "favicon.ico");
    expect(useUrlHistoryStore.getState().entries["proj1"]![0]!.favicon).toBe("favicon.ico");
  });

  it("updates lastVisitAt on repeated visits", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "http://localhost:3000/", "Home");
    const firstVisitAt = useUrlHistoryStore.getState().entries["proj1"]![0]!.lastVisitAt;
    // Small delay to ensure timestamp differs
    store.recordVisit("proj1", "http://localhost:3000/", "Home");
    const secondVisitAt = useUrlHistoryStore.getState().entries["proj1"]![0]!.lastVisitAt;
    expect(secondVisitAt).toBeGreaterThanOrEqual(firstVisitAt);
  });

  it("caps entries at 500 per project", () => {
    const store = useUrlHistoryStore.getState();
    for (let i = 0; i < 510; i++) {
      store.recordVisit("proj1", `http://localhost:3000/page-${i}`, `Page ${i}`);
    }
    const entries = useUrlHistoryStore.getState().entries["proj1"];
    expect(entries!.length).toBeLessThanOrEqual(500);
  });
});

describe("frecencyScore", () => {
  it("gives highest weight to recent entries", () => {
    const now = Date.now();
    const recent: UrlHistoryEntry = {
      url: "http://localhost:3000/",
      title: "Recent",
      visitCount: 1,
      lastVisitAt: now - 1000,
    };
    const old: UrlHistoryEntry = {
      url: "http://localhost:3000/old",
      title: "Old",
      visitCount: 1,
      lastVisitAt: now - 100 * 24 * 3600 * 1000,
    };
    expect(frecencyScore(recent, now)).toBeGreaterThan(frecencyScore(old, now));
  });

  it("weights visitCount as a multiplier", () => {
    const now = Date.now();
    const frequent: UrlHistoryEntry = {
      url: "http://localhost:3000/",
      title: "Frequent",
      visitCount: 10,
      lastVisitAt: now - 1000,
    };
    const single: UrlHistoryEntry = {
      url: "http://localhost:3000/once",
      title: "Single",
      visitCount: 1,
      lastVisitAt: now - 1000,
    };
    expect(frecencyScore(frequent, now)).toBe(10 * frecencyScore(single, now));
  });
});

describe("getFrecencySuggestions", () => {
  const now = Date.now();
  const entries: UrlHistoryEntry[] = [
    {
      url: "http://localhost:3000/dashboard",
      title: "Dashboard",
      visitCount: 5,
      lastVisitAt: now - 1000,
    },
    {
      url: "http://localhost:3000/settings",
      title: "Settings",
      visitCount: 2,
      lastVisitAt: now - 1000,
    },
    {
      url: "http://localhost:3000/api/users",
      title: "Users API",
      visitCount: 3,
      lastVisitAt: now - 1000,
    },
    { url: "http://localhost:5173/", title: "Vite Dev", visitCount: 1, lastVisitAt: now - 1000 },
  ];

  it("returns top entries for empty query", () => {
    const results = getFrecencySuggestions(entries, "");
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it("returns top entries for whitespace-only query", () => {
    const results = getFrecencySuggestions(entries, "   ");
    expect(results.length).toBeGreaterThan(0);
  });

  it("filters by URL substring match", () => {
    const results = getFrecencySuggestions(entries, "3000");
    expect(results).toHaveLength(3);
    expect(results.every((e) => e.url.includes("3000"))).toBe(true);
  });

  it("filters by title match (case-insensitive)", () => {
    const results = getFrecencySuggestions(entries, "dashboard");
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("Dashboard");
  });

  it("sorts by frecency score descending", () => {
    const results = getFrecencySuggestions(entries, "localhost");
    expect(results[0]!.url).toBe("http://localhost:3000/dashboard");
  });

  it("limits results to specified count", () => {
    const results = getFrecencySuggestions(entries, "localhost", 2);
    expect(results).toHaveLength(2);
  });
});

describe("urlHistoryStore persistence migration", () => {
  const STORAGE_KEY = "daintree-url-history";
  const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage"
  );

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
    if (originalLocalStorageDescriptor) {
      Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
      return;
    }
    delete (globalThis as Partial<typeof globalThis>).localStorage;
  }

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    restoreLocalStorage();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("rehydrates a legacy unversioned blob without discarding entries", async () => {
    const legacyBlob = JSON.stringify({
      state: {
        entries: {
          proj1: [
            {
              url: "http://localhost:3000/",
              title: "Legacy",
              visitCount: 3,
              lastVisitAt: 1_700_000_000_000,
            },
          ],
        },
      },
    });
    installLocalStorage({ [STORAGE_KEY]: legacyBlob });

    const { useUrlHistoryStore: store } = await import("../urlHistoryStore");

    const entries = store.getState().entries["proj1"];
    expect(entries).toHaveLength(1);
    expect(entries![0]!.url).toBe("http://localhost:3000/");
    expect(entries![0]!.visitCount).toBe(3);
  });

  it("writes version: 0 on the next persist after rehydration", async () => {
    const legacyBlob = JSON.stringify({
      state: {
        entries: {
          proj1: [
            { url: "http://a.test/", title: "A", visitCount: 1, lastVisitAt: 1_700_000_000_000 },
          ],
        },
      },
    });
    const backing = installLocalStorage({ [STORAGE_KEY]: legacyBlob });

    const { useUrlHistoryStore: store } = await import("../urlHistoryStore");
    store.getState().recordVisit("proj1", "http://b.test/", "B");

    const written = backing.get(STORAGE_KEY);
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!) as {
      version: number;
      state: { entries: Record<string, UrlHistoryEntry[]> };
    };
    expect(parsed.version).toBe(0);
    expect(parsed.state.entries["proj1"]!.some((e) => e.url === "http://a.test/")).toBe(true);
    expect(parsed.state.entries["proj1"]!.some((e) => e.url === "http://b.test/")).toBe(true);
  });
});

describe("urlHistoryStore storage fallback", () => {
  it("falls back to memory storage when localStorage is missing required methods", async () => {
    const originalLocalStorage = globalThis.localStorage;

    Object.defineProperty(globalThis, "localStorage", {
      value: { getItem: vi.fn() },
      configurable: true,
      writable: true,
    });

    vi.resetModules();

    const { useUrlHistoryStore: isolatedStore } = await import("../urlHistoryStore");

    expect(() => {
      isolatedStore.setState({ entries: {} });
      isolatedStore.getState().recordVisit("proj1", "http://localhost:3000/", "Home");
    }).not.toThrow();

    expect(isolatedStore.getState().entries["proj1"]).toHaveLength(1);

    Object.defineProperty(globalThis, "localStorage", {
      value: originalLocalStorage,
      configurable: true,
      writable: true,
    });
  });
});
