import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrantCache } from "../grantCache.js";
import type { McpGrantLifecyclePayload } from "../../../../shared/types/ipc/mcpServer.js";

interface EmittedEvent {
  sessionId: string;
  payload: McpGrantLifecyclePayload;
}

function newCache(opts?: {
  ttlMs?: number;
  sweepIntervalMs?: number;
  denialSilenceThreshold?: number;
  now?: () => number;
}): { cache: GrantCache; emitted: EmittedEvent[] } {
  const emitted: EmittedEvent[] = [];
  const cache = new GrantCache({
    ttlMs: opts?.ttlMs ?? 1000,
    // Disable the sweep by default so the only timer in the test is the
    // one each test explicitly drives; the lazy-eviction path on `check`
    // is the contract we care about most.
    sweepIntervalMs: opts?.sweepIntervalMs ?? 0,
    denialSilenceThreshold: opts?.denialSilenceThreshold ?? 2,
    now: opts?.now,
    emit: (sessionId, payload) => {
      emitted.push({ sessionId, payload });
    },
  });
  return { cache, emitted };
}

describe("GrantCache.issueGrant + check", () => {
  it("issueGrant returns an entry and emits grant.issued", () => {
    const { cache, emitted } = newCache();
    const entry = cache.issueGrant("s1", "git.commit");
    expect(entry.ttlMs).toBeGreaterThan(0);
    expect(entry.expiresAt).toBe(entry.issuedAt + entry.ttlMs);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      sessionId: "s1",
      payload: { type: "grant.issued", sessionId: "s1", toolId: "git.commit" },
    });
    cache.dispose();
  });

  it("check returns granted + issuedAt for a fresh grant", () => {
    const { cache } = newCache();
    const entry = cache.issueGrant("s1", "git.commit");
    const result = cache.check("s1", "git.commit");
    expect(result.granted).toBe(true);
    if (result.granted) {
      expect(result.issuedAt).toBe(entry.issuedAt);
      expect(result.expiresAt).toBe(entry.expiresAt);
    }
    cache.dispose();
  });

  it("check returns not granted for an unknown (sessionId, toolId)", () => {
    const { cache } = newCache();
    cache.issueGrant("s1", "git.commit");
    const a = cache.check("s2", "git.commit"); // different session
    const b = cache.check("s1", "git.push"); // different tool
    expect(a.granted).toBe(false);
    expect(b.granted).toBe(false);
    cache.dispose();
  });
});

describe("GrantCache lazy expiry", () => {
  it("check lazily evicts and emits grant.expired after the TTL passes", () => {
    let now = 0;
    const { cache, emitted } = newCache({ ttlMs: 1000, now: () => now });
    cache.issueGrant("s1", "git.commit");
    emitted.length = 0;

    // Just before expiry: still granted, no eviction.
    now = 999;
    expect(cache.check("s1", "git.commit").granted).toBe(true);
    expect(emitted).toHaveLength(0);

    // Just after expiry: lazy eviction + emit.
    now = 1001;
    expect(cache.check("s1", "git.commit").granted).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload.type).toBe("grant.expired");
    expect(emitted[0].payload.toolId).toBe("git.commit");

    // Subsequent check returns false but does NOT re-emit (entry gone).
    expect(cache.check("s1", "git.commit").granted).toBe(false);
    expect(emitted).toHaveLength(1);

    cache.dispose();
  });

  it("sweep evicts expired entries and emits one grant.expired per entry", () => {
    let now = 0;
    const { cache, emitted } = newCache({ ttlMs: 1000, now: () => now });
    cache.issueGrant("s1", "git.commit");
    cache.issueGrant("s2", "worktree.delete");
    emitted.length = 0;

    now = 5000;
    const evicted = cache.sweep();
    expect(evicted).toBe(2);
    expect(emitted.map((e) => e.payload.type)).toEqual(["grant.expired", "grant.expired"]);

    cache.dispose();
  });
});

describe("GrantCache.refresh — race guard (#2243)", () => {
  it("refresh extends expiresAt when issuedAt matches", () => {
    let now = 0;
    const { cache } = newCache({ ttlMs: 1000, now: () => now });
    const entry = cache.issueGrant("s1", "git.commit");

    now = 500;
    const refreshed = cache.refresh("s1", "git.commit", entry.issuedAt);
    expect(refreshed).toBe(true);

    // Original expiresAt was 1000; refresh at 500 with TTL 1000 → 1500.
    const peeked = cache._peek("s1", "git.commit");
    expect(peeked?.expiresAt).toBe(1500);
    cache.dispose();
  });

  it("refresh with stale issuedAt no-ops (revoke + reissue race)", () => {
    let now = 0;
    const { cache } = newCache({ ttlMs: 1000, now: () => now });
    const original = cache.issueGrant("s1", "git.commit");

    // Simulate: revoke (deletes entry), then issueGrant again (fresh issuedAt).
    cache.revokeSession("s1", "user");
    now = 100;
    const reissued = cache.issueGrant("s1", "git.commit");
    expect(reissued.issuedAt).not.toBe(original.issuedAt);

    // An in-flight dispatch refreshes with the OLD issuedAt — must no-op.
    now = 200;
    const refreshed = cache.refresh("s1", "git.commit", original.issuedAt);
    expect(refreshed).toBe(false);

    // Entry kept its reissue expiresAt (100 + 1000 = 1100), not extended.
    const peeked = cache._peek("s1", "git.commit");
    expect(peeked?.issuedAt).toBe(reissued.issuedAt);
    expect(peeked?.expiresAt).toBe(1100);

    cache.dispose();
  });

  it("refresh of a missing entry no-ops", () => {
    const { cache } = newCache();
    expect(cache.refresh("s1", "git.commit", 0)).toBe(false);
    cache.dispose();
  });
});

describe("GrantCache.revokeSession", () => {
  it("revokes all grants for the named session and emits grant.revoked per entry", () => {
    const { cache, emitted } = newCache();
    cache.issueGrant("s1", "git.commit");
    cache.issueGrant("s1", "git.push");
    cache.issueGrant("s2", "git.commit");
    emitted.length = 0;

    const revoked = cache.revokeSession("s1", "user");
    expect(revoked).toBe(2);
    expect(emitted).toHaveLength(2);
    expect(emitted.every((e) => e.payload.type === "grant.revoked")).toBe(true);
    expect(emitted.every((e) => e.payload.revokedReason === "user")).toBe(true);

    // s2 untouched.
    expect(cache.check("s2", "git.commit").granted).toBe(true);
    cache.dispose();
  });

  it("revokeSession on an unknown session returns 0 and emits nothing", () => {
    const { cache, emitted } = newCache();
    expect(cache.revokeSession("ghost", "user")).toBe(0);
    expect(emitted).toHaveLength(0);
    cache.dispose();
  });

  it("session-idle reason is propagated to the emitted record", () => {
    const { cache, emitted } = newCache();
    cache.issueGrant("s1", "git.commit");
    emitted.length = 0;
    cache.revokeSession("s1", "session-idle");
    expect(emitted[0].payload.revokedReason).toBe("session-idle");
    cache.dispose();
  });
});

describe("GrantCache denial counters", () => {
  it("incrementDenial counts per (sessionId, toolId) — cross-tool isolated", () => {
    const { cache } = newCache({ denialSilenceThreshold: 2 });
    expect(cache.incrementDenial("s1", "git.commit")).toBe(1);
    expect(cache.incrementDenial("s1", "git.commit")).toBe(2);
    expect(cache.incrementDenial("s1", "git.push")).toBe(1);
    expect(cache.getDenialCount("s1", "git.commit")).toBe(2);
    expect(cache.getDenialCount("s1", "git.push")).toBe(1);
    cache.dispose();
  });

  it("shouldSuppressBanner is true only after threshold denials have already counted", () => {
    const { cache } = newCache({ denialSilenceThreshold: 2 });
    // 1st denial: count=1, suppress=false.
    cache.incrementDenial("s1", "t");
    expect(cache.shouldSuppressBanner("s1", "t")).toBe(false);
    // 2nd denial: count=2, suppress=false (still fires).
    cache.incrementDenial("s1", "t");
    expect(cache.shouldSuppressBanner("s1", "t")).toBe(false);
    // 3rd denial: count=3, suppress=true.
    cache.incrementDenial("s1", "t");
    expect(cache.shouldSuppressBanner("s1", "t")).toBe(true);
    cache.dispose();
  });

  it("issueGrant zeroes the denial counter for the pair (re-arms the banner)", () => {
    const { cache } = newCache({ denialSilenceThreshold: 2 });
    cache.incrementDenial("s1", "t");
    cache.incrementDenial("s1", "t");
    cache.incrementDenial("s1", "t");
    expect(cache.shouldSuppressBanner("s1", "t")).toBe(true);

    cache.issueGrant("s1", "t");
    expect(cache.getDenialCount("s1", "t")).toBe(0);
    expect(cache.shouldSuppressBanner("s1", "t")).toBe(false);

    cache.dispose();
  });
});

describe("GrantCache.clearSessionState", () => {
  it("clears grants and denial counters for the session quietly (no events)", () => {
    const { cache, emitted } = newCache();
    cache.issueGrant("s1", "t");
    cache.incrementDenial("s1", "t");
    cache.issueGrant("s2", "t");
    emitted.length = 0;

    cache.clearSessionState("s1");
    expect(emitted).toHaveLength(0);
    expect(cache.check("s1", "t").granted).toBe(false);
    expect(cache.getDenialCount("s1", "t")).toBe(0);
    // Other sessions untouched.
    expect(cache.check("s2", "t").granted).toBe(true);
    cache.dispose();
  });
});

describe("GrantCache.dispose + clearAll", () => {
  it("dispose stops the sweep interval and clears state; further issueGrant throws", () => {
    const { cache } = newCache({ sweepIntervalMs: 50 });
    cache.issueGrant("s1", "t");
    cache.dispose();
    expect(cache.check("s1", "t").granted).toBe(false);
    expect(() => cache.issueGrant("s2", "t")).toThrow();
    // Idempotent.
    cache.dispose();
  });

  it("clearAll drops state but keeps the cache usable after a subsequent issueGrant", () => {
    const { cache, emitted } = newCache();
    cache.issueGrant("s1", "t");
    cache.incrementDenial("s2", "t");
    emitted.length = 0;

    cache.clearAll();
    expect(cache.check("s1", "t").granted).toBe(false);
    expect(cache.getDenialCount("s2", "t")).toBe(0);

    // Still usable.
    cache.issueGrant("s3", "t");
    expect(cache.check("s3", "t").granted).toBe(true);
    cache.dispose();
  });

  it("sweep timer fires periodically when sweepIntervalMs > 0", () => {
    vi.useFakeTimers();
    try {
      const emitted: EmittedEvent[] = [];
      let now = 0;
      const cache = new GrantCache({
        ttlMs: 100,
        sweepIntervalMs: 50,
        now: () => now,
        emit: (sessionId, payload) => emitted.push({ sessionId, payload }),
      });
      cache.issueGrant("s1", "t");
      emitted.length = 0;

      // Advance now past expiry, then tick the sweep interval.
      now = 200;
      vi.advanceTimersByTime(50);
      expect(emitted.map((e) => e.payload.type)).toEqual(["grant.expired"]);

      cache.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GrantCache.getActiveGrants", () => {
  it("returns snapshot for all sessions or filtered by sessionId", () => {
    const { cache } = newCache();
    cache.issueGrant("s1", "a");
    cache.issueGrant("s1", "b");
    cache.issueGrant("s2", "a");

    const all = cache.getActiveGrants();
    expect(all).toHaveLength(3);

    const s1 = cache.getActiveGrants("s1");
    expect(s1).toHaveLength(2);
    expect(s1.map((g) => g.toolId).sort()).toEqual(["a", "b"]);
    cache.dispose();
  });
});

describe("GrantCache emitter resilience", () => {
  it("a throwing emitter does not wedge subsequent cache mutations", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const cache = new GrantCache({
        sweepIntervalMs: 0,
        emit: () => {
          throw new Error("boom");
        },
      });
      expect(() => cache.issueGrant("s1", "t")).not.toThrow();
      expect(cache.check("s1", "t").granted).toBe(true);
      cache.dispose();
    } finally {
      errSpy.mockRestore();
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("session-level integration assumptions", () => {
  // Sanity assertions that the cache's behaviour matches the contract
  // sessionStore/sessionServer rely on; if any of these flip we want a
  // test failure here, not a runtime surprise.
  it("colon-free tool IDs survive the flat key encoding", () => {
    const { cache } = newCache();
    cache.issueGrant("uuid-with-dashes", "namespace.action");
    expect(cache.check("uuid-with-dashes", "namespace.action").granted).toBe(true);
    cache.dispose();
  });
});

// Unused, but documents intent.
beforeEach(() => {
  // no-op; per-test caches are constructed inside each `it`.
});
