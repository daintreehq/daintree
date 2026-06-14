// @vitest-environment jsdom
import { afterEach, describe, it, expect, beforeEach, vi } from "vitest";
import {
  useUrlHistoryStore,
  frecencyScore,
  getFrecencySuggestions,
  sanitizeUrlForHistory,
} from "../urlHistoryStore";
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

  it("updateFavicon is a no-op for non-existent URL (no ghost entry created)", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "http://localhost:3000/", "Title");
    store.updateFavicon("proj1", "http://localhost:5000/", "https://other.com/favicon.ico");
    const entries = useUrlHistoryStore.getState().entries["proj1"]!;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.url).toBe("http://localhost:3000/");
  });

  it("updateFavicon is a no-op for an unknown project", () => {
    const store = useUrlHistoryStore.getState();
    store.updateFavicon("missing", "http://localhost:3000/", "favicon.ico");
    expect(useUrlHistoryStore.getState().entries["missing"]).toBeUndefined();
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

  it("caps visitCount at 200 to prevent old high-frequency URLs from dominating forever", () => {
    const store = useUrlHistoryStore.getState();
    for (let i = 0; i < 250; i++) {
      store.recordVisit("proj1", "http://localhost:3000/", "Home");
    }
    const entries = useUrlHistoryStore.getState().entries["proj1"];
    expect(entries![0]!.visitCount).toBe(200);
  });

  it("dedupes recordVisit when only tracking parameters differ", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "https://example.com/page?utm_source=a", "Page");
    store.recordVisit("proj1", "https://example.com/page?utm_source=b", "Page");
    store.recordVisit("proj1", "https://example.com/page?fbclid=xyz", "Page");
    const entries = useUrlHistoryStore.getState().entries["proj1"]!;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.url).toBe("https://example.com/page");
    expect(entries[0]!.visitCount).toBe(3);
  });

  it("preserves non-tracking parameters and sorts them canonically", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "https://example.com/search?q=foo&sort=date&utm_source=ads", "");
    const entries = useUrlHistoryStore.getState().entries["proj1"]!;
    expect(entries[0]!.url).toBe("https://example.com/search?q=foo&sort=date");
  });

  it("skips OAuth callback URLs (code + state)", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit(
      "proj1",
      "https://app.com/callback?code=abc123&state=xyz789",
      "Authenticating"
    );
    expect(useUrlHistoryStore.getState().entries["proj1"]).toBeUndefined();
  });

  it("skips URLs with token fragments", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "https://app.com/#access_token=secret&token_type=Bearer", "");
    expect(useUrlHistoryStore.getState().entries["proj1"]).toBeUndefined();
  });

  it("skips URLs with HTTP basic auth credentials", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "https://user:pass@example.com/api", "");
    expect(useUrlHistoryStore.getState().entries["proj1"]).toBeUndefined();
  });

  it("skips AWS pre-signed URLs", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit(
      "proj1",
      "https://bucket.s3.amazonaws.com/file.pdf?X-Amz-Signature=abc&X-Amz-Credential=xyz",
      "File"
    );
    expect(useUrlHistoryStore.getState().entries["proj1"]).toBeUndefined();
  });

  it("skips GCS signed URLs", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit(
      "proj1",
      "https://storage.googleapis.com/bucket/file?X-Goog-Signature=abc",
      ""
    );
    expect(useUrlHistoryStore.getState().entries["proj1"]).toBeUndefined();
  });

  it("skips Azure SAS URLs", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit(
      "proj1",
      "https://account.blob.core.windows.net/container/file?sig=abc&se=2026&sv=2024",
      ""
    );
    expect(useUrlHistoryStore.getState().entries["proj1"]).toBeUndefined();
  });

  it("preserves hash-router fragments unchanged", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "http://localhost:3000/#/users/42?tab=profile", "Profile");
    const entries = useUrlHistoryStore.getState().entries["proj1"]!;
    expect(entries[0]!.url).toBe("http://localhost:3000/#/users/42?tab=profile");
  });

  it("prunes entries older than 90 days on the next recordVisit", () => {
    const stale = Date.now() - 100 * 24 * 3600 * 1000;
    useUrlHistoryStore.setState({
      entries: {
        proj1: [
          { url: "http://localhost:3000/old", title: "Old", visitCount: 5, lastVisitAt: stale },
        ],
      },
    });
    useUrlHistoryStore.getState().recordVisit("proj1", "http://localhost:3000/new", "New");
    const entries = useUrlHistoryStore.getState().entries["proj1"]!;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.url).toBe("http://localhost:3000/new");
  });

  it("recordVisit with a sensitive URL does not mutate existing safe history", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "http://localhost:3000/", "Home");
    const before = useUrlHistoryStore.getState().entries["proj1"]!;
    store.recordVisit("proj1", "https://app.com/cb?code=abc&state=xyz", "OAuth");
    const after = useUrlHistoryStore.getState().entries["proj1"]!;
    expect(after).toHaveLength(1);
    expect(after[0]!.url).toBe(before[0]!.url);
    expect(after[0]!.title).toBe("Home");
  });

  it("updateTitle canonicalizes the lookup URL and updates the existing entry", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "https://example.com/page", "Old");
    store.updateTitle("proj1", "https://example.com/page?utm_source=email", "New");
    const entries = useUrlHistoryStore.getState().entries["proj1"]!;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe("New");
  });

  it("updateFavicon canonicalizes the lookup URL and updates the existing entry", () => {
    const store = useUrlHistoryStore.getState();
    store.recordVisit("proj1", "https://example.com/page", "Page");
    store.updateFavicon("proj1", "https://example.com/page?fbclid=xyz", "favicon.ico");
    const entries = useUrlHistoryStore.getState().entries["proj1"]!;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.favicon).toBe("favicon.ico");
  });

  it("retention boundary: entries just under 90 days survive, just over are pruned", () => {
    const now = Date.now();
    const ninetyDaysMs = 90 * 24 * 3600 * 1000;
    useUrlHistoryStore.setState({
      entries: {
        proj1: [
          {
            url: "http://localhost:3000/just-old",
            title: "Just Old",
            visitCount: 1,
            lastVisitAt: now - ninetyDaysMs + 1000,
          },
          {
            url: "http://localhost:3000/too-old",
            title: "Too Old",
            visitCount: 1,
            lastVisitAt: now - ninetyDaysMs - 1000,
          },
        ],
      },
    });
    useUrlHistoryStore.getState().recordVisit("proj1", "http://localhost:3000/fresh", "Fresh");
    const entries = useUrlHistoryStore.getState().entries["proj1"]!;
    const urls = entries.map((e) => e.url).sort();
    expect(urls).toEqual(["http://localhost:3000/fresh", "http://localhost:3000/just-old"]);
  });

  it("500-entry cap evicts low-frecency entries first", () => {
    const store = useUrlHistoryStore.getState();
    const now = Date.now();
    const seeded: UrlHistoryEntry[] = [];
    for (let i = 0; i < 500; i++) {
      seeded.push({
        url: `http://localhost:3000/seed-${i}`,
        title: `Seed ${i}`,
        visitCount: 1,
        lastVisitAt: now - 1000,
      });
    }
    seeded.push({
      url: "http://localhost:3000/high-value",
      title: "High",
      visitCount: 50,
      lastVisitAt: now - 1000,
    });
    useUrlHistoryStore.setState({ entries: { proj1: seeded } });
    store.recordVisit("proj1", "http://localhost:3000/trigger-cap", "Trigger");
    const entries = useUrlHistoryStore.getState().entries["proj1"]!;
    expect(entries.length).toBeLessThanOrEqual(500);
    expect(entries.find((e) => e.url === "http://localhost:3000/high-value")).toBeDefined();
  });
});

describe("sanitizeUrlForHistory", () => {
  it("returns null for OAuth callbacks with code and state params", () => {
    expect(sanitizeUrlForHistory("https://app.com/cb?code=abc&state=xyz")).toBeNull();
  });

  it("returns null for token fragments", () => {
    expect(sanitizeUrlForHistory("https://app.com/#access_token=foo")).toBeNull();
    expect(sanitizeUrlForHistory("https://app.com/#id_token=foo")).toBeNull();
    expect(sanitizeUrlForHistory("https://app.com/#token_type=Bearer")).toBeNull();
  });

  it("returns null for tokens after `?` inside hash-router fragments (Angular/SPA implicit flow)", () => {
    expect(sanitizeUrlForHistory("https://app.com/#/callback?access_token=secret")).toBeNull();
    expect(sanitizeUrlForHistory("https://app.com/#/auth?id_token=eyJ&state=x")).toBeNull();
  });

  it("returns null for GCS signed URLs with uppercase param keys", () => {
    expect(sanitizeUrlForHistory("https://s.googleapis.com/b/f?X-GOOG-SIGNATURE=abc")).toBeNull();
  });

  it("returns null for basic-auth URLs", () => {
    expect(sanitizeUrlForHistory("https://user:pass@example.com/")).toBeNull();
    expect(sanitizeUrlForHistory("https://user@example.com/")).toBeNull();
  });

  it("returns null for AWS pre-signed URLs", () => {
    expect(
      sanitizeUrlForHistory("https://b.s3.amazonaws.com/f?X-Amz-Signature=abc&X-Amz-Date=z")
    ).toBeNull();
    expect(sanitizeUrlForHistory("https://b.s3.amazonaws.com/f?x-amz-signature=abc")).toBeNull();
  });

  it("returns null for GCS signed URLs", () => {
    expect(sanitizeUrlForHistory("https://s.googleapis.com/b/f?X-Goog-Signature=abc")).toBeNull();
  });

  it("returns null for Azure SAS URLs", () => {
    expect(
      sanitizeUrlForHistory("https://a.blob.core.windows.net/c/f?sig=abc&se=2026&sv=2024")
    ).toBeNull();
    expect(sanitizeUrlForHistory("https://a.blob.core.windows.net/c/f?sig=abc&sv=2024")).toBeNull();
  });

  it("strips tracking params and sorts remaining params alphabetically", () => {
    expect(sanitizeUrlForHistory("https://example.com/?utm_source=a&q=hello")).toBe(
      "https://example.com/?q=hello"
    );
    expect(sanitizeUrlForHistory("https://example.com/?z=1&a=2&fbclid=xyz")).toBe(
      "https://example.com/?a=2&z=1"
    );
  });

  it("strips tracking params case-insensitively", () => {
    expect(sanitizeUrlForHistory("https://example.com/?UTM_SOURCE=a&q=hello")).toBe(
      "https://example.com/?q=hello"
    );
  });

  it("lowercases scheme and host but preserves path case", () => {
    expect(sanitizeUrlForHistory("HTTPS://Example.COM/Some/Path")).toBe(
      "https://example.com/Some/Path"
    );
  });

  it("preserves hash-router fragments verbatim", () => {
    expect(sanitizeUrlForHistory("http://localhost:3000/#/users/42")).toBe(
      "http://localhost:3000/#/users/42"
    );
    expect(sanitizeUrlForHistory("http://localhost:3000/#!/route")).toBe(
      "http://localhost:3000/#!/route"
    );
  });

  it("trims trailing slash on non-root paths only", () => {
    expect(sanitizeUrlForHistory("https://example.com/")).toBe("https://example.com/");
    expect(sanitizeUrlForHistory("https://example.com/foo/")).toBe("https://example.com/foo");
  });

  it("returns the input unchanged for unparseable URLs", () => {
    expect(sanitizeUrlForHistory("not a url")).toBe("not a url");
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

  it("sorts empty-query results by frecency, not insertion order", () => {
    const now = Date.now();
    const insertionOrdered: UrlHistoryEntry[] = [
      { url: "http://a/", title: "a", visitCount: 1, lastVisitAt: now - 1000 },
      { url: "http://b/", title: "b", visitCount: 10, lastVisitAt: now - 1000 },
      { url: "http://c/", title: "c", visitCount: 3, lastVisitAt: now - 1000 },
    ];
    const results = getFrecencySuggestions(insertionOrdered, "");
    expect(results[0]!.url).toBe("http://b/");
    expect(results[1]!.url).toBe("http://c/");
    expect(results[2]!.url).toBe("http://a/");
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
    const recent = Date.now() - 1000;
    const legacyBlob = JSON.stringify({
      state: {
        entries: {
          proj1: [
            {
              url: "http://localhost:3000/",
              title: "Legacy",
              visitCount: 3,
              lastVisitAt: recent,
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

  it("writes version: 1 on the next persist after rehydration", async () => {
    const recent = Date.now() - 1000;
    const legacyBlob = JSON.stringify({
      state: {
        entries: {
          proj1: [{ url: "http://a.test/", title: "A", visitCount: 1, lastVisitAt: recent }],
        },
      },
    });
    const backing = installLocalStorage({ [STORAGE_KEY]: legacyBlob });

    const { useUrlHistoryStore: store } = await import("../urlHistoryStore");
    vi.useFakeTimers();
    try {
      store.getState().recordVisit("proj1", "http://b.test/", "B");
      vi.advanceTimersByTime(300);
    } finally {
      vi.useRealTimers();
    }

    const written = backing.get(STORAGE_KEY);
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!) as {
      version: number;
      state: { entries: Record<string, UrlHistoryEntry[]> };
    };
    expect(parsed.version).toBe(1);
    expect(parsed.state.entries["proj1"]!.some((e) => e.url === "http://a.test/")).toBe(true);
    expect(parsed.state.entries["proj1"]!.some((e) => e.url === "http://b.test/")).toBe(true);
  });

  it("strips sensitive URLs from a legacy blob during migration", async () => {
    const recent = Date.now() - 1000;
    const legacyBlob = JSON.stringify({
      state: {
        entries: {
          proj1: [
            { url: "https://example.com/safe", title: "Safe", visitCount: 1, lastVisitAt: recent },
            {
              url: "https://app.com/cb?code=abc&state=xyz",
              title: "OAuth",
              visitCount: 1,
              lastVisitAt: recent,
            },
            {
              url: "https://b.s3.amazonaws.com/f?X-Amz-Signature=zzz",
              title: "Signed",
              visitCount: 1,
              lastVisitAt: recent,
            },
          ],
        },
      },
    });
    installLocalStorage({ [STORAGE_KEY]: legacyBlob });

    const { useUrlHistoryStore: store } = await import("../urlHistoryStore");
    const entries = store.getState().entries["proj1"]!;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.url).toBe("https://example.com/safe");
  });

  it("dedupes tracking-param variants during migration", async () => {
    const recent = Date.now() - 1000;
    const legacyBlob = JSON.stringify({
      state: {
        entries: {
          proj1: [
            {
              url: "https://example.com/page?utm_source=a",
              title: "Page",
              visitCount: 2,
              lastVisitAt: recent - 5000,
            },
            {
              url: "https://example.com/page?utm_source=b",
              title: "",
              visitCount: 3,
              lastVisitAt: recent,
              favicon: "https://example.com/favicon.ico",
            },
          ],
        },
      },
    });
    installLocalStorage({ [STORAGE_KEY]: legacyBlob });

    const { useUrlHistoryStore: store } = await import("../urlHistoryStore");
    const entries = store.getState().entries["proj1"]!;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.url).toBe("https://example.com/page");
    expect(entries[0]!.visitCount).toBe(5);
    expect(entries[0]!.lastVisitAt).toBe(recent);
    expect(entries[0]!.title).toBe("Page");
    expect(entries[0]!.favicon).toBe("https://example.com/favicon.ico");
  });

  it("prunes entries older than 90 days during migration", async () => {
    const stale = Date.now() - 100 * 24 * 3600 * 1000;
    const legacyBlob = JSON.stringify({
      state: {
        entries: {
          proj1: [
            { url: "https://example.com/old", title: "Old", visitCount: 1, lastVisitAt: stale },
          ],
        },
      },
    });
    installLocalStorage({ [STORAGE_KEY]: legacyBlob });

    const { useUrlHistoryStore: store } = await import("../urlHistoryStore");
    expect(store.getState().entries["proj1"]).toBeUndefined();
  });

  it("caps visitCount during migration", async () => {
    const recent = Date.now() - 1000;
    const legacyBlob = JSON.stringify({
      state: {
        entries: {
          proj1: [
            { url: "https://example.com/", title: "", visitCount: 5000, lastVisitAt: recent },
          ],
        },
      },
    });
    installLocalStorage({ [STORAGE_KEY]: legacyBlob });

    const { useUrlHistoryStore: store } = await import("../urlHistoryStore");
    const entries = store.getState().entries["proj1"]!;
    expect(entries[0]!.visitCount).toBe(200);
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
