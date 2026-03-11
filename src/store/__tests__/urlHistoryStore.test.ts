import { describe, it, expect, beforeEach } from "vitest";
import { useUrlHistoryStore, frecencyScore, getFrecencySuggestions } from "../urlHistoryStore";
import type { UrlHistoryEntry } from "@shared/types/domain";

describe("urlHistoryStore", () => {
  beforeEach(() => {
    useUrlHistoryStore.setState({ entries: {} });
  });

  it("records a new visit", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "http://localhost:3000/", "Home");
    const entries = useUrlHistoryStore.getState().entries["proj1"];
    expect(entries).toHaveLength(1);
    expect(entries[0].url).toBe("http://localhost:3000/");
    expect(entries[0].title).toBe("Home");
    expect(entries[0].visitCount).toBe(1);
  });

  it("increments visitCount on repeated visits", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "http://localhost:3000/", "Home");
    store.recordVisit("proj1", "http://localhost:3000/", "Home");
    store.recordVisit("proj1", "http://localhost:3000/", "Home");
    const entries = useUrlHistoryStore.getState().entries["proj1"];
    expect(entries).toHaveLength(1);
    expect(entries[0].visitCount).toBe(3);
  });

  it("updates title on repeated visit with new title", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "http://localhost:3000/", "Old Title");
    store.recordVisit("proj1", "http://localhost:3000/", "New Title");
    const entries = useUrlHistoryStore.getState().entries["proj1"];
    expect(entries[0].title).toBe("New Title");
  });

  it("keeps existing title when new title is empty", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "http://localhost:3000/", "My Title");
    store.recordVisit("proj1", "http://localhost:3000/");
    const entries = useUrlHistoryStore.getState().entries["proj1"];
    expect(entries[0].title).toBe("My Title");
  });

  it("isolates entries by project", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "http://localhost:3000/", "P1");
    store.recordVisit("proj2", "http://localhost:5173/", "P2");
    expect(useUrlHistoryStore.getState().entries["proj1"]).toHaveLength(1);
    expect(useUrlHistoryStore.getState().entries["proj2"]).toHaveLength(1);
    expect(useUrlHistoryStore.getState().entries["proj1"][0].url).toBe("http://localhost:3000/");
    expect(useUrlHistoryStore.getState().entries["proj2"][0].url).toBe("http://localhost:5173/");
  });

  it("updateTitle updates title for an existing entry", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "http://localhost:3000/", "Old");
    store.updateTitle("proj1", "http://localhost:3000/", "New Title");
    const entries = useUrlHistoryStore.getState().entries["proj1"];
    expect(entries[0].title).toBe("New Title");
  });

  it("updateTitle is a no-op for non-existent URL", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "http://localhost:3000/", "Title");
    store.updateTitle("proj1", "http://localhost:5000/", "New");
    expect(useUrlHistoryStore.getState().entries["proj1"]).toHaveLength(1);
    expect(useUrlHistoryStore.getState().entries["proj1"][0].title).toBe("Title");
  });

  it("removeProjectHistory clears all entries for a project", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "http://localhost:3000/", "P1");
    store.recordVisit("proj2", "http://localhost:5173/", "P2");
    store.removeProjectHistory("proj1");
    expect(useUrlHistoryStore.getState().entries["proj1"]).toBeUndefined();
    expect(useUrlHistoryStore.getState().entries["proj2"]).toHaveLength(1);
  });

  it("updates lastVisitAt on repeated visits", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "http://localhost:3000/", "Home");
    const firstVisitAt = useUrlHistoryStore.getState().entries["proj1"][0].lastVisitAt;
    // Small delay to ensure timestamp differs
    store.recordVisit("proj1", "http://localhost:3000/", "Home");
    const secondVisitAt = useUrlHistoryStore.getState().entries["proj1"][0].lastVisitAt;
    expect(secondVisitAt).toBeGreaterThanOrEqual(firstVisitAt);
  });

  it("caps entries at 500 per project", () => {
    const store = useUrlHistoryStore.getState();
    for (let i = 0; i < 510; i++) {
      store.recordVisit("proj1", `http://localhost:3000/page-${i}`, `Page ${i}`);
    }
    const entries = useUrlHistoryStore.getState().entries["proj1"];
    expect(entries.length).toBeLessThanOrEqual(500);
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

  it("returns empty for empty query", () => {
    expect(getFrecencySuggestions(entries, "")).toEqual([]);
    expect(getFrecencySuggestions(entries, "   ")).toEqual([]);
  });

  it("filters by URL substring match", () => {
    const results = getFrecencySuggestions(entries, "3000");
    expect(results).toHaveLength(3);
    expect(results.every((e) => e.url.includes("3000"))).toBe(true);
  });

  it("filters by title match (case-insensitive)", () => {
    const results = getFrecencySuggestions(entries, "dashboard");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Dashboard");
  });

  it("sorts by frecency score descending", () => {
    const results = getFrecencySuggestions(entries, "localhost");
    expect(results[0].url).toBe("http://localhost:3000/dashboard");
  });

  it("limits results to specified count", () => {
    const results = getFrecencySuggestions(entries, "localhost", 2);
    expect(results).toHaveLength(2);
  });
});
