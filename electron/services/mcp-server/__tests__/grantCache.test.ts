import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrantCache } from "../grantCache.js";
import { minimumPermittingTier } from "../shared.js";
import {
  NATIVE_GRANT_USE_POLICY_OVERRIDES,
  getNativeGrantUsePolicy,
  isGenericNativeGrantEligible,
} from "../../../../shared/config/nativeGrantUsePolicies.js";
import { BUILT_IN_ACTION_IDS } from "../../../../shared/config/actionIds.js";
import type { McpGrantLifecyclePayload } from "../../../../shared/types/ipc/mcpServer.js";

interface EmittedEvent {
  sessionId: string;
  payload: McpGrantLifecyclePayload;
}

function newCache(opts?: {
  ttlMs?: number;
  maxLifetimeMs?: number;
  sweepIntervalMs?: number;
  denialSilenceThreshold?: number;
  now?: () => number;
}): { cache: GrantCache; emitted: EmittedEvent[] } {
  const emitted: EmittedEvent[] = [];
  const cache = new GrantCache({
    ttlMs: opts?.ttlMs ?? 1000,
    // Default the ceiling well above the default TTL so existing tests are
    // unaffected; ceiling tests pass an explicit small value.
    maxLifetimeMs: opts?.maxLifetimeMs ?? 1_000_000,
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

describe("GrantCache max-lifetime ceiling (#9161)", () => {
  it("refresh is blocked once the ceiling passes and emits grant.revoked/grant-ceiling", () => {
    let now = 0;
    // Ceiling 5000 sits above the 1000ms TTL so the grant is refreshable for
    // a while, then hits the hard cap.
    const { cache, emitted } = newCache({ ttlMs: 1000, maxLifetimeMs: 5000, now: () => now });
    const entry = cache.issueGrant("s1", "git.commit");
    emitted.length = 0;

    // Within the ceiling: refresh slides the TTL window forward as usual.
    now = 4000;
    expect(cache.refresh("s1", "git.commit", entry.issuedAt)).toBe(true);
    expect(cache._peek("s1", "git.commit")?.expiresAt).toBe(5000);
    expect(emitted).toHaveLength(0);

    // Past the ceiling: refresh is denied, entry is evicted, event emitted.
    now = 5001;
    expect(cache.refresh("s1", "git.commit", entry.issuedAt)).toBe(false);
    expect(cache._peek("s1", "git.commit")).toBeUndefined();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload.type).toBe("grant.revoked");
    expect(emitted[0].payload).toMatchObject({
      revokedReason: "grant-ceiling",
      toolId: "git.commit",
    });

    cache.dispose();
  });

  it("ceiling boundary is exclusive — refresh at exactly issuedAt + maxLifetimeMs still succeeds", () => {
    let now = 0;
    const { cache } = newCache({ ttlMs: 10_000, maxLifetimeMs: 5000, now: () => now });
    const entry = cache.issueGrant("s1", "git.commit");

    now = 5000; // exactly at the ceiling
    expect(cache.refresh("s1", "git.commit", entry.issuedAt)).toBe(true);
    now = 5001; // one ms past
    expect(cache.refresh("s1", "git.commit", entry.issuedAt)).toBe(false);

    cache.dispose();
  });

  it("check evicts at the ceiling even when expiresAt is still in the future", () => {
    let now = 0;
    // TTL larger than the ceiling: a single grant's expiresAt stays in the
    // future, so only the ceiling can evict it.
    const { cache, emitted } = newCache({ ttlMs: 100_000, maxLifetimeMs: 5000, now: () => now });
    cache.issueGrant("s1", "git.commit");
    emitted.length = 0;

    now = 5001;
    const result = cache.check("s1", "git.commit");
    expect(result.granted).toBe(false);
    expect(emitted).toHaveLength(1);
    // grant.revoked, NOT grant.expired — the ceiling is an active eviction.
    expect(emitted[0].payload.type).toBe("grant.revoked");
    expect(emitted[0].payload).toMatchObject({ revokedReason: "grant-ceiling" });

    // Entry is gone — a subsequent check does not re-emit.
    expect(cache.check("s1", "git.commit").granted).toBe(false);
    expect(emitted).toHaveLength(1);

    cache.dispose();
  });

  it("sweep evicts ceiling-expired entries with grant.revoked/grant-ceiling", () => {
    let now = 0;
    const { cache, emitted } = newCache({ ttlMs: 100_000, maxLifetimeMs: 5000, now: () => now });
    cache.issueGrant("s1", "git.commit");
    emitted.length = 0;

    // expiresAt (100_000) is still in the future, so the TTL-only sweep would
    // skip this entry — the ceiling branch must catch it.
    now = 6000;
    const evicted = cache.sweep();
    expect(evicted).toBe(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload.type).toBe("grant.revoked");
    expect(emitted[0].payload).toMatchObject({ revokedReason: "grant-ceiling" });

    cache.dispose();
  });

  it("check honours the exclusive boundary — valid at the ceiling, evicted one ms past", () => {
    let now = 0;
    const { cache, emitted } = newCache({ ttlMs: 100_000, maxLifetimeMs: 5000, now: () => now });
    cache.issueGrant("s1", "git.commit");
    emitted.length = 0;

    now = 5000; // exactly at the ceiling — still valid
    expect(cache.check("s1", "git.commit").granted).toBe(true);
    expect(emitted).toHaveLength(0);

    now = 5001; // one ms past — evicted with grant-ceiling
    expect(cache.check("s1", "git.commit").granted).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload).toMatchObject({
      type: "grant.revoked",
      revokedReason: "grant-ceiling",
    });

    cache.dispose();
  });

  it("an idle grant past both TTL and ceiling is reported as grant.expired, not grant-ceiling", () => {
    let now = 0;
    // TTL well below the ceiling; the grant is never refreshed, so its sliding
    // window lapses long before the hard cap. Eviction should keep the
    // truthful passive-timeout signal even though the ceiling has also passed.
    const { cache, emitted } = newCache({ ttlMs: 1000, maxLifetimeMs: 5000, now: () => now });
    cache.issueGrant("s1", "git.commit");
    emitted.length = 0;

    now = 6000; // past both expiresAt (1000) and ceiling (5000)
    const result = cache.check("s1", "git.commit");
    expect(result.granted).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload.type).toBe("grant.expired");

    cache.dispose();
  });

  it("sweep reports an idle both-expired grant as grant.expired", () => {
    let now = 0;
    const { cache, emitted } = newCache({ ttlMs: 1000, maxLifetimeMs: 5000, now: () => now });
    cache.issueGrant("s1", "git.commit");
    emitted.length = 0;

    now = 6000;
    expect(cache.sweep()).toBe(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload.type).toBe("grant.expired");

    cache.dispose();
  });

  it("caps an actively-refreshed grant at the ceiling (core #9161 regression)", () => {
    let now = 0;
    const ttlMs = 1000;
    const maxLifetimeMs = 5000;
    const { cache, emitted } = newCache({ ttlMs, maxLifetimeMs, now: () => now });
    const entry = cache.issueGrant("s1", "git.commit");
    emitted.length = 0;

    // Refresh just inside every TTL window — the abusive pattern from #9161.
    // Each refresh slides expiresAt forward, but the ceiling never moves.
    for (now = 900; now < maxLifetimeMs; now += ttlMs - 1) {
      expect(cache.check("s1", "git.commit").granted).toBe(true);
      expect(cache.refresh("s1", "git.commit", entry.issuedAt)).toBe(true);
    }

    // One ms past the ceiling the grant is gone despite continuous refreshing.
    now = maxLifetimeMs + 1;
    expect(cache.refresh("s1", "git.commit", entry.issuedAt)).toBe(false);
    expect(cache.check("s1", "git.commit").granted).toBe(false);
    expect(cache._peek("s1", "git.commit")).toBeUndefined();
    expect(emitted.some((e) => e.payload.type === "grant.revoked")).toBe(true);
    expect(
      emitted.some(
        (e) => e.payload.type === "grant.revoked" && e.payload.revokedReason === "grant-ceiling"
      )
    ).toBe(true);

    cache.dispose();
  });

  it("re-issuing after a ceiling hit resets the lifetime clock with a fresh issuedAt", () => {
    let now = 0;
    // TTL larger than the ceiling so the ceiling, not the sliding TTL, is the
    // limiting factor for the assertions below.
    const { cache } = newCache({ ttlMs: 100_000, maxLifetimeMs: 5000, now: () => now });
    const original = cache.issueGrant("s1", "git.commit");

    // Cross the ceiling, then the user re-approves: a fresh grant is minted.
    now = 6000;
    const reissued = cache.issueGrant("s1", "git.commit");
    expect(reissued.issuedAt).toBe(6000);
    expect(reissued.issuedAt).not.toBe(original.issuedAt);

    // A stale in-flight refresh carrying the OLD issuedAt must no-op on the
    // fresh entry (the #2243 race guard), leaving the new clock intact.
    now = 6100;
    expect(cache.refresh("s1", "git.commit", original.issuedAt)).toBe(false);
    expect(cache._peek("s1", "git.commit")?.issuedAt).toBe(reissued.issuedAt);

    // The new grant has its own independent ceiling window: still valid just
    // before issuedAt + maxLifetimeMs (6000 + 5000 = 11000).
    now = 10_999;
    expect(cache.check("s1", "git.commit").granted).toBe(true);
    now = 11_001;
    expect(cache.check("s1", "git.commit").granted).toBe(false);

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

describe("GrantCache native grants (#10648)", () => {
  function issue(
    cache: GrantCache,
    overrides?: { allowedTools?: string[]; maxUses?: number; ttlMs?: number }
  ) {
    return cache.issueNativeGrant({
      sessionId: "s1",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: overrides?.allowedTools ?? ["git.commit", "git.push"],
      maxUses: overrides?.maxUses ?? 3,
      ttlMs: overrides?.ttlMs,
    });
  }

  it("issueNativeGrant mints an entry and emits grant.issued with native fields", () => {
    const { cache, emitted } = newCache({ ttlMs: 1000 });
    const entry = issue(cache);
    expect(entry.id).toBeTruthy();
    expect(entry.remainingUses).toBe(3);
    expect(entry.maxUses).toBe(3);
    expect([...entry.allowedTools].sort()).toEqual(["git.commit", "git.push"]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload).toMatchObject({
      type: "grant.issued",
      toolId: "*",
      grantId: entry.id,
      actorId: "help-1",
      actorType: "help-session",
      maxUses: 3,
      remainingUses: 3,
    });
    cache.dispose();
  });

  it("peekNativeGrant authorizes an allowed tool WITHOUT consuming a use", () => {
    const { cache, emitted } = newCache();
    const entry = issue(cache);
    emitted.length = 0;
    const result = cache.peekNativeGrant("s1", "git.commit");
    expect(result.granted).toBe(true);
    if (result.granted) expect(result.grantId).toBe(entry.id);
    // Peek must not decrement or emit — the use is charged by consume.
    expect(cache._peekNative(entry.id)?.remainingUses).toBe(3);
    expect(emitted).toHaveLength(0);
    cache.dispose();
  });

  it("consumeNativeGrantUse charges one use and emits grant.used", () => {
    const { cache, emitted } = newCache();
    const entry = issue(cache);
    emitted.length = 0;
    expect(cache.consumeNativeGrantUse(entry.id, "git.commit")).toBe(true);
    expect(cache._peekNative(entry.id)?.remainingUses).toBe(2);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload).toMatchObject({
      type: "grant.used",
      toolId: "git.commit",
      grantId: entry.id,
      remainingUses: 2,
    });
    cache.dispose();
  });

  it("peekNativeGrant denies a tool outside the allowlist", () => {
    const { cache, emitted } = newCache();
    const entry = issue(cache, { allowedTools: ["git.commit"] });
    emitted.length = 0;
    expect(cache.peekNativeGrant("s1", "git.push").granted).toBe(false);
    expect(cache._peekNative(entry.id)?.remainingUses).toBe(3);
    expect(emitted).toHaveLength(0);
    cache.dispose();
  });

  it("a maxUses:1 grant exhausts after one consumed use and fails closed on the second", () => {
    const { cache, emitted } = newCache();
    const entry = issue(cache, { maxUses: 1 });
    emitted.length = 0;
    expect(cache.consumeNativeGrantUse(entry.id, "git.commit")).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload).toMatchObject({
      type: "grant.exhausted",
      toolId: "git.commit",
      remainingUses: 0,
    });
    expect(cache._peekNative(entry.id)).toBeUndefined();
    // Grant is gone — a subsequent peek or consume fails closed.
    expect(cache.peekNativeGrant("s1", "git.commit").granted).toBe(false);
    expect(cache.consumeNativeGrantUse(entry.id, "git.commit")).toBe(false);
    cache.dispose();
  });

  it("a grant past its TTL fails closed (peek) and emits grant.expired", () => {
    let clock = 0;
    const { cache, emitted } = newCache({ ttlMs: 1000, maxLifetimeMs: 100000, now: () => clock });
    issue(cache, { ttlMs: 1000 });
    emitted.length = 0;
    clock = 2000;
    expect(cache.peekNativeGrant("s1", "git.commit").granted).toBe(false);
    expect(emitted.some((e) => e.payload.type === "grant.expired")).toBe(true);
    cache.dispose();
  });

  it("consumeNativeGrantUse fails closed when the grant aged past TTL since the peek", () => {
    let clock = 0;
    const { cache } = newCache({ ttlMs: 1000, maxLifetimeMs: 100000, now: () => clock });
    const entry = issue(cache, { ttlMs: 1000 });
    clock = 2000;
    expect(cache.consumeNativeGrantUse(entry.id, "git.commit")).toBe(false);
    expect(cache._peekNative(entry.id)).toBeUndefined();
    cache.dispose();
  });

  // Both policy ids, not just the destructive one: terminal.closeAll is
  // `danger: "safe"`, so it exercises the leg where a grant only ever widened
  // the tier floor and never bought a confirm bypass.
  it.each(["terminal.killAll", "terminal.closeAll"])(
    "peekNativeGrant refuses %s without consuming or emitting",
    (fanOutTool) => {
      const { cache, emitted } = newCache();
      const entry = issue(cache, { allowedTools: ["git.commit", fanOutTool] });
      emitted.length = 0;
      expect(cache.peekNativeGrant("s1", fanOutTool).granted).toBe(false);
      expect(emitted).toHaveLength(0);
      // The refusal is scoped to the tool, not the grant: an eligible sibling in
      // the same allowlist must still be authorized, with the budget untouched.
      expect(cache.peekNativeGrant("s1", "git.commit")).toEqual({
        granted: true,
        grantId: entry.id,
      });
      expect(cache._peekNative(entry.id)?.remainingUses).toBe(3);
      cache.dispose();
    }
  );

  it.each(["terminal.killAll", "terminal.closeAll"])(
    "consumeNativeGrantUse fails closed for %s without decrementing",
    (fanOutTool) => {
      const { cache, emitted } = newCache();
      const entry = issue(cache, { allowedTools: ["git.commit", fanOutTool] });
      emitted.length = 0;
      expect(cache.consumeNativeGrantUse(entry.id, fanOutTool)).toBe(false);
      expect(emitted).toHaveLength(0);
      // Nothing was authorized, so nothing was spent — and the grant survives for
      // the siblings it legitimately covers.
      expect(cache._peekNative(entry.id)?.remainingUses).toBe(3);
      expect(cache.consumeNativeGrantUse(entry.id, "git.commit")).toBe(true);
      cache.dispose();
    }
  );

  it("consumeNativeGrantUse reports expiry before refusing a per-resolved-target tool", () => {
    // An ORDER-LOCK, not coverage of the refusal itself — every assertion here
    // also holds without the policy guard. What it catches is the guard being
    // hoisted above the TTL/ceiling block, which would swallow the eviction and
    // its `grant.expired` signal for a caller holding a stale id.
    let clock = 0;
    const { cache, emitted } = newCache({ ttlMs: 1000, maxLifetimeMs: 100000, now: () => clock });
    const entry = issue(cache, {
      allowedTools: ["git.commit", "terminal.killAll"],
      ttlMs: 1000,
    });
    emitted.length = 0;
    clock = 2000;
    expect(cache.consumeNativeGrantUse(entry.id, "terminal.killAll")).toBe(false);
    expect(emitted.some((e) => e.payload.type === "grant.expired")).toBe(true);
    expect(cache._peekNative(entry.id)).toBeUndefined();
    cache.dispose();
  });

  // Naming the hazardous ids outright rather than asserting over whatever the
  // map happens to contain: a generic "every entry is well-formed" check stays
  // green when an entry is DELETED, which is the regression that reopens the
  // hole. These two must be declared, by id, forever.
  it.each(["terminal.killAll", "terminal.closeAll"])(
    "%s is declared per-resolved-target and stays grant-ineligible",
    (toolId) => {
      expect(getNativeGrantUsePolicy(toolId)).toBe("per-resolved-target");
      expect(isGenericNativeGrantEligible(toolId)).toBe(false);
    }
  );

  it("every per-resolved-target override names a real tool a grant could otherwise reach", () => {
    // The policy is keyed by tool id and defaults to `per-dispatch`, so a
    // renamed or retired action would silently fall back to being grantable
    // again. `BuiltInActionId` typing does not catch this on its own — it also
    // admits keybinding-only ids that no action registers.
    const overrides = Object.entries(NATIVE_GRANT_USE_POLICY_OVERRIDES);
    expect(overrides.length).toBeGreaterThan(0);
    for (const [toolId, policy] of overrides) {
      expect(policy).toBe("per-resolved-target");
      expect(BUILT_IN_ACTION_IDS, `${toolId} is not a registered action id`).toContain(toolId);
      expect(minimumPermittingTier(toolId), `${toolId} is no longer a grantable tool id`).not.toBe(
        null
      );
    }
  });

  it("treats a prototype-shaped tool id as an ordinary per-dispatch tool", () => {
    // The lookup is a Map, not a bare index into an object literal, because
    // `toolId` arrives from the MCP surface: an object literal would resolve
    // "toString" to an inherited function and this would not be "per-dispatch".
    for (const toolId of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(getNativeGrantUsePolicy(toolId)).toBe("per-dispatch");
      expect(isGenericNativeGrantEligible(toolId)).toBe(true);
    }
  });

  it("a grant past the hard ceiling fails closed (peek) and emits grant-ceiling revoke", () => {
    let clock = 0;
    const { cache, emitted } = newCache({ ttlMs: 100000, maxLifetimeMs: 1000, now: () => clock });
    issue(cache, { ttlMs: 100000 });
    emitted.length = 0;
    clock = 2000;
    expect(cache.peekNativeGrant("s1", "git.commit").granted).toBe(false);
    expect(
      emitted.some(
        (e) => e.payload.type === "grant.revoked" && e.payload.revokedReason === "grant-ceiling"
      )
    ).toBe(true);
    cache.dispose();
  });

  it("getLiveNativeGrants excludes a grant refreshed past the hard ceiling", () => {
    let clock = 0;
    const { cache } = newCache({ ttlMs: 1000, maxLifetimeMs: 5000, now: () => clock });
    const entry = issue(cache, { ttlMs: 4000 });
    // Slide the TTL so `expiresAt` stays in the FUTURE at the assertion — the
    // ceiling must be what drops the grant. If both bounds had elapsed, an
    // implementation that checked only `expiresAt` would pass too.
    clock = 4000;
    cache.refreshNativeGrant(entry.id); // expiresAt -> 8000, ceiling stays 5000
    clock = 6000;
    expect(cache.getActiveNativeGrants("s1")[0]!.expiresAt).toBeGreaterThan(clock);
    expect(cache.getLiveNativeGrants("s1")).toHaveLength(0);
    cache.dispose();
  });

  it("revokeSession drops native grants for the session and emits grant.revoked", () => {
    const { cache, emitted } = newCache();
    const entry = issue(cache);
    emitted.length = 0;
    const count = cache.revokeSession("s1", "session-ended");
    expect(count).toBeGreaterThanOrEqual(1);
    expect(cache._peekNative(entry.id)).toBeUndefined();
    expect(
      emitted.some(
        (e) =>
          e.payload.type === "grant.revoked" &&
          e.payload.grantId === entry.id &&
          e.payload.revokedReason === "session-ended"
      )
    ).toBe(true);
    cache.dispose();
  });

  it("revokeNativeGrant by id is idempotent", () => {
    const { cache } = newCache();
    const entry = issue(cache);
    expect(cache.revokeNativeGrant(entry.id)).toBe(true);
    expect(cache.revokeNativeGrant(entry.id)).toBe(false);
    cache.dispose();
  });

  it("refreshNativeGrant extends the TTL window; a gone grant is a no-op", () => {
    let clock = 0;
    const { cache } = newCache({ ttlMs: 1000, maxLifetimeMs: 100000, now: () => clock });
    const entry = issue(cache, { ttlMs: 1000 });
    clock = 500;
    expect(cache.refreshNativeGrant(entry.id)).toBe(true);
    expect(cache._peekNative(entry.id)?.expiresAt).toBe(1500);
    cache.revokeNativeGrant(entry.id);
    expect(cache.refreshNativeGrant(entry.id)).toBe(false);
    cache.dispose();
  });

  it("clearSessionState drops native grants without emitting", () => {
    const { cache, emitted } = newCache();
    const entry = issue(cache);
    emitted.length = 0;
    cache.clearSessionState("s1");
    expect(cache._peekNative(entry.id)).toBeUndefined();
    expect(emitted).toHaveLength(0);
    cache.dispose();
  });

  it("getActiveNativeGrants snapshots live grants for the session", () => {
    const { cache } = newCache();
    const entry = issue(cache);
    const snap = cache.getActiveNativeGrants("s1");
    expect(snap).toHaveLength(1);
    expect(snap[0].id).toBe(entry.id);
    expect(cache.getActiveNativeGrants("other")).toHaveLength(0);
    cache.dispose();
  });
});

describe("GrantCache.getLiveGrants", () => {
  it("returns only grants live by both the sliding TTL and the hard ceiling", () => {
    let now = 1000;
    const { cache } = newCache({ ttlMs: 500, maxLifetimeMs: 800, now: () => now });
    // issuedAt 1000 → TTL lapses at 1500, ceiling at 1800 for both.
    const stale = cache.issueGrant("s1", "ttl-expired");
    const ceilingPast = cache.issueGrant("s1", "ceiling-past");

    now = 1700;
    const fresh = cache.issueGrant("s1", "fresh");

    // Slide ceiling-past's TTL forward to 2250. `refresh` never moves
    // issuedAt, so its 1800 ceiling still bites — the case an expiresAt-only
    // liveness filter (as at sessionStore.ts:581) silently reports as live.
    now = 1750;
    expect(cache.refresh("s1", "ceiling-past", ceilingPast.issuedAt)).toBe(true);

    now = 1900;
    expect(stale.expiresAt).toBeLessThan(now);
    expect(ceilingPast.expiresAt).toBeGreaterThan(now);
    expect(fresh.expiresAt).toBeGreaterThan(now);

    expect(cache.getLiveGrants("s1").map((g) => g.toolId)).toEqual(["fresh"]);
    // getActiveGrants establishes no liveness at all — that contrast is the
    // whole reason getLiveGrants exists.
    expect(cache.getActiveGrants("s1")).toHaveLength(3);
    cache.dispose();
  });

  it("never evicts or emits, unlike check", () => {
    let now = 1000;
    const { cache, emitted } = newCache({ ttlMs: 100, now: () => now });
    cache.issueGrant("s1", "git.commit");
    emitted.length = 0;

    now = 5000;
    expect(cache.getLiveGrants("s1")).toEqual([]);
    // The read is pure: nothing deleted, no grant.expired pushed at the renderer.
    expect(emitted).toEqual([]);
    expect(cache.getActiveGrants("s1")).toHaveLength(1);

    // check() on the same expired grant does both, which is why a discovery
    // filter must not use it.
    expect(cache.check("s1", "git.commit").granted).toBe(false);
    expect(emitted.map((e) => e.payload.type)).toEqual(["grant.expired"]);
    expect(cache.getActiveGrants("s1")).toHaveLength(0);
    cache.dispose();
  });

  it("scopes to one session and returns every session when unfiltered", () => {
    const { cache } = newCache();
    cache.issueGrant("s1", "a");
    cache.issueGrant("s2", "b");
    expect(cache.getLiveGrants("s1").map((g) => g.toolId)).toEqual(["a"]);
    expect(cache.getLiveGrants("s2").map((g) => g.toolId)).toEqual(["b"]);
    expect(
      cache
        .getLiveGrants()
        .map((g) => g.toolId)
        .sort()
    ).toEqual(["a", "b"]);
    cache.dispose();
  });
});
