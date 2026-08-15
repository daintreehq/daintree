import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MCP_SSE_IDLE_TIMEOUT_MS,
  MCP_TIER_ELEVATION_TTL_MS,
  type McpSseSession,
  type McpHttpSession,
} from "../shared.js";

// Mutable test state controlled per-test.
let mockAwakeTimeSince = 0;

vi.mock("../../SystemSleepService.js", () => ({
  getSystemSleepService: vi.fn(() => ({
    getAwakeTimeSince: vi.fn(() => mockAwakeTimeSince),
    onWake: vi.fn(() => () => {}),
  })),
}));

import { SessionStore } from "../sessionStore.js";

function fakeSseSession(): McpSseSession {
  return {
    transport: {
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as McpSseSession["transport"],
    server: {
      sendToolListChanged: vi.fn().mockResolvedValue(undefined),
    } as unknown as McpSseSession["server"],
    idleTimer: setTimeout(() => {}, 1_000_000),
  };
}

function fakeHttpSession(): McpHttpSession {
  return {
    transport: {
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as McpHttpSession["transport"],
    server: {} as McpHttpSession["server"],
    idleTimer: setTimeout(() => {}, 1_000_000),
  };
}

function setAwakeTime(ms: number): void {
  mockAwakeTimeSince = ms;
}

describe("SessionStore.sessionWebContentsMap (#7002)", () => {
  let store: SessionStore;
  let resourceCleanups: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    resourceCleanups = [];
    store = new SessionStore((sessionId) => {
      resourceCleanups.push(sessionId);
    });
  });

  afterEach(() => {
    // GrantCache owns a recurring sweep interval (`unref`'d) so the test
    // runner can't be kept alive by it, but `vi.useFakeTimers` advances
    // every registered timer regardless — we must explicitly dispose so
    // tests can `vi.runAllTimers()`-equivalents without hitting the
    // sweep loop. SessionStore.drain() keeps the cache usable; only
    // dispose tears down the sweep timer.
    store.grantCache.dispose();
    vi.useRealTimers();
  });

  it("drain() clears the pinned map alongside other session maps", () => {
    store.sessions.set("a", fakeSseSession());
    store.httpSessions.set("b", fakeHttpSession());
    store.sessionTierMap.set("a", "action");
    store.sessionTierMap.set("b", "action");
    store.sessionWebContentsMap.set("a", 100);
    store.sessionWebContentsMap.set("b", 200);
    store.sessionHelpIdMap.set("a", "help-a");
    store.sessionHelpIdMap.set("b", "help-b");

    store.drain();

    expect(store.sessions.size).toBe(0);
    expect(store.httpSessions.size).toBe(0);
    expect(store.sessionTierMap.size).toBe(0);
    expect(store.sessionWebContentsMap.size).toBe(0);
    expect(store.sessionHelpIdMap.size).toBe(0);
  });

  it("SSE idle-timer expiry deletes the session's pin so an evicted session does not leak the WebContents id", () => {
    setAwakeTime(MCP_SSE_IDLE_TIMEOUT_MS);
    const session = fakeSseSession();
    const sessionId = "sse-1";
    store.sessions.set(sessionId, session);
    store.sessionTierMap.set(sessionId, "action");
    store.sessionWebContentsMap.set(sessionId, 42);
    store.sessionHelpIdMap.set(sessionId, "help-1");

    clearTimeout(session.idleTimer);
    session.idleTimer = store.createIdleTimer(sessionId);

    // Advance past the idle window only — running every timer would
    // re-fire the GrantCache sweep interval indefinitely.
    vi.advanceTimersByTime(MCP_SSE_IDLE_TIMEOUT_MS + 1);

    expect(store.sessions.has(sessionId)).toBe(false);
    expect(store.sessionTierMap.has(sessionId)).toBe(false);
    expect(store.sessionWebContentsMap.has(sessionId)).toBe(false);
    expect(store.sessionHelpIdMap.has(sessionId)).toBe(false);
    expect(resourceCleanups).toContain(sessionId);
  });

  it("Streamable-HTTP idle-timer expiry deletes the session's pin", () => {
    setAwakeTime(MCP_SSE_IDLE_TIMEOUT_MS);
    const session = fakeHttpSession();
    const sessionId = "http-1";
    store.httpSessions.set(sessionId, session);
    store.sessionTierMap.set(sessionId, "action");
    store.sessionWebContentsMap.set(sessionId, 99);
    store.sessionHelpIdMap.set(sessionId, "help-1");

    clearTimeout(session.idleTimer);
    session.idleTimer = store.createHttpIdleTimer(sessionId);

    // Advance past the idle window only — running every timer would
    // re-fire the GrantCache sweep interval indefinitely.
    vi.advanceTimersByTime(MCP_SSE_IDLE_TIMEOUT_MS + 1);

    expect(store.httpSessions.has(sessionId)).toBe(false);
    expect(store.sessionTierMap.has(sessionId)).toBe(false);
    expect(store.sessionWebContentsMap.has(sessionId)).toBe(false);
    expect(store.sessionHelpIdMap.has(sessionId)).toBe(false);
    expect(resourceCleanups).toContain(sessionId);
  });

  it("drain() clears the grant cache without disposing it (cache stays usable across stop/start)", () => {
    store.grantCache.issueGrant("s1", "git.commit");
    expect(store.grantCache.check("s1", "git.commit").granted).toBe(true);

    store.drain();
    expect(store.grantCache.check("s1", "git.commit").granted).toBe(false);

    // Cache is still alive — a subsequent issueGrant should not throw.
    expect(() => store.grantCache.issueGrant("s2", "git.commit")).not.toThrow();
    expect(store.grantCache.check("s2", "git.commit").granted).toBe(true);
  });

  it("SSE idle-timer expiry calls revokeSession with the session-idle reason", () => {
    const sessionId = "sse-2";
    const session = fakeSseSession();
    store.sessions.set(sessionId, session);
    // Spy on `revokeSession` directly — observing emissions is brittle
    // because the GrantCache's sweep interval and 15-min lazy expiry
    // both race with the 30-min SSE idle timer during a fast-forward
    // and can emit `grant.expired` before the reaper runs.
    const revokeSpy = vi.spyOn(store.grantCache, "revokeSession");

    clearTimeout(session.idleTimer);
    session.idleTimer = store.createIdleTimer(sessionId);

    vi.advanceTimersByTime(MCP_SSE_IDLE_TIMEOUT_MS + 1);

    expect(revokeSpy).toHaveBeenCalledWith(sessionId, "session-idle");
  });

  it("HTTP idle-timer expiry calls revokeSession with the session-idle reason", () => {
    const sessionId = "http-2";
    const session = fakeHttpSession();
    store.httpSessions.set(sessionId, session);
    const revokeSpy = vi.spyOn(store.grantCache, "revokeSession");

    clearTimeout(session.idleTimer);
    session.idleTimer = store.createHttpIdleTimer(sessionId);

    vi.advanceTimersByTime(MCP_SSE_IDLE_TIMEOUT_MS + 1);

    expect(revokeSpy).toHaveBeenCalledWith(sessionId, "session-idle");
  });

  it("idle-timer for a session that was already removed is a no-op (does not stomp another session's pin)", () => {
    setAwakeTime(MCP_SSE_IDLE_TIMEOUT_MS);
    store.sessions.set("alive", fakeSseSession());
    store.sessionWebContentsMap.set("alive", 1);
    store.sessionWebContentsMap.set("evicted", 2);

    const evictedSession = fakeSseSession();
    store.sessions.set("evicted", evictedSession);
    clearTimeout(evictedSession.idleTimer);
    evictedSession.idleTimer = store.createIdleTimer("evicted");

    // Caller removed it explicitly (e.g. transport.onclose).
    store.sessions.delete("evicted");
    store.sessionWebContentsMap.delete("evicted");

    // Advance past the idle window only — running every timer would
    // re-fire the GrantCache sweep interval indefinitely.
    vi.advanceTimersByTime(MCP_SSE_IDLE_TIMEOUT_MS + 1);

    // The other session's pin must remain untouched.
    expect(store.sessionWebContentsMap.get("alive")).toBe(1);
  });
});

describe("SessionStore.recomputeIdleTimers", () => {
  let store: SessionStore;
  let resourceCleanups: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    mockAwakeTimeSince = 0;
    resourceCleanups = [];
    store = new SessionStore((sessionId) => {
      resourceCleanups.push(sessionId);
    });
  });

  afterEach(() => {
    // GrantCache owns a recurring sweep interval; dispose so `vi.runAllTimers()`
    // in tests doesn't loop indefinitely on the sweep schedule.
    store.grantCache.dispose();
    vi.useRealTimers();
  });

  it("expires an SSE session when awake elapsed >= MCP_SSE_IDLE_TIMEOUT_MS", () => {
    setAwakeTime(MCP_SSE_IDLE_TIMEOUT_MS);
    const session = fakeSseSession();
    store.sessions.set("sse-1", session);
    store.sessionTierMap.set("sse-1", "action");
    clearTimeout(session.idleTimer);
    session.idleTimer = store.createIdleTimer("sse-1");

    store.recomputeIdleTimers();

    expect(store.sessions.has("sse-1")).toBe(false);
    expect(store.sessionTierMap.has("sse-1")).toBe(false);
    expect(resourceCleanups).toContain("sse-1");
  });

  it("expires an HTTP session when awake elapsed >= MCP_SSE_IDLE_TIMEOUT_MS", () => {
    setAwakeTime(MCP_SSE_IDLE_TIMEOUT_MS);
    const session = fakeHttpSession();
    store.httpSessions.set("http-1", session);
    store.sessionTierMap.set("http-1", "action");
    clearTimeout(session.idleTimer);
    session.idleTimer = store.createHttpIdleTimer("http-1");

    store.recomputeIdleTimers();

    expect(store.httpSessions.has("http-1")).toBe(false);
    expect(store.sessionTierMap.has("http-1")).toBe(false);
    expect(resourceCleanups).toContain("http-1");
  });

  it("resets SSE timer with remaining awake time when not yet expired", () => {
    const halfTimeout = MCP_SSE_IDLE_TIMEOUT_MS / 2;
    setAwakeTime(halfTimeout);
    const session = fakeSseSession();
    store.sessions.set("sse-2", session);
    clearTimeout(session.idleTimer);
    const originalTimer = store.createIdleTimer("sse-2");
    session.idleTimer = originalTimer;

    store.recomputeIdleTimers();

    expect(store.sessions.has("sse-2")).toBe(true);
    expect(session.idleTimer).not.toBe(originalTimer);

    vi.advanceTimersByTime(halfTimeout - 1);
    expect(store.sessions.has("sse-2")).toBe(true);

    // The timer callback's defense-in-depth checks getAwakeTimeSince().
    // Set it to expired so it proceeds to actual expiry.
    setAwakeTime(MCP_SSE_IDLE_TIMEOUT_MS);
    vi.advanceTimersByTime(2);
    expect(store.sessions.has("sse-2")).toBe(false);
  });

  it("resets HTTP timer with remaining awake time when not yet expired", () => {
    const halfTimeout = MCP_SSE_IDLE_TIMEOUT_MS / 2;
    setAwakeTime(halfTimeout);
    const session = fakeHttpSession();
    store.httpSessions.set("http-2", session);
    clearTimeout(session.idleTimer);
    const originalTimer = store.createHttpIdleTimer("http-2");
    session.idleTimer = originalTimer;

    store.recomputeIdleTimers();

    expect(store.httpSessions.has("http-2")).toBe(true);
    expect(session.idleTimer).not.toBe(originalTimer);

    vi.advanceTimersByTime(halfTimeout - 1);
    expect(store.httpSessions.has("http-2")).toBe(true);

    setAwakeTime(MCP_SSE_IDLE_TIMEOUT_MS);
    vi.advanceTimersByTime(2);
    expect(store.httpSessions.has("http-2")).toBe(false);
  });

  it("resetIdleTimer updates the timestamp so recompute reflects the reset", () => {
    setAwakeTime(0);
    const session = fakeSseSession();
    store.sessions.set("sse-3", session);
    clearTimeout(session.idleTimer);
    session.idleTimer = store.createIdleTimer("sse-3");

    setAwakeTime(20 * 60 * 1000);
    store.resetIdleTimer("sse-3");

    setAwakeTime(5 * 60 * 1000);
    store.recomputeIdleTimers();

    expect(store.sessions.has("sse-3")).toBe(true);
  });

  it("resetHttpIdleTimer updates the timestamp so recompute reflects the reset", () => {
    setAwakeTime(0);
    const session = fakeHttpSession();
    store.httpSessions.set("http-3", session);
    clearTimeout(session.idleTimer);
    session.idleTimer = store.createHttpIdleTimer("http-3");

    setAwakeTime(20 * 60 * 1000);
    store.resetHttpIdleTimer("http-3");

    setAwakeTime(5 * 60 * 1000);
    store.recomputeIdleTimers();

    expect(store.httpSessions.has("http-3")).toBe(true);
  });

  it("drain() clears timestamp maps so no stale entries survive", () => {
    const session = fakeSseSession();
    store.sessions.set("a", session);
    clearTimeout(session.idleTimer);
    session.idleTimer = store.createIdleTimer("a");
    const httpSession = fakeHttpSession();
    store.httpSessions.set("b", httpSession);
    clearTimeout(httpSession.idleTimer);
    httpSession.idleTimer = store.createHttpIdleTimer("b");

    store.drain();

    setAwakeTime(MCP_SSE_IDLE_TIMEOUT_MS);
    expect(() => store.recomputeIdleTimers()).not.toThrow();
  });

  it("timer callback cleans up timestamp entries on expiry", () => {
    setAwakeTime(MCP_SSE_IDLE_TIMEOUT_MS);
    const session = fakeSseSession();
    store.sessions.set("sse-ts", session);
    clearTimeout(session.idleTimer);
    session.idleTimer = store.createIdleTimer("sse-ts");

    // Use advanceTimersByTime rather than runAllTimers — GrantCache's recurring
    // sweep interval would otherwise trigger vitest's infinite-loop guard.
    vi.advanceTimersByTime(MCP_SSE_IDLE_TIMEOUT_MS + 1);

    expect(store.sessions.has("sse-ts")).toBe(false);
    expect(() => store.drain()).not.toThrow();
  });

  it("timer callback re-arms when awake time is below threshold (defense-in-depth)", () => {
    setAwakeTime(0);
    const session = fakeSseSession();
    store.sessions.set("sse-survive", session);
    clearTimeout(session.idleTimer);
    session.idleTimer = store.createIdleTimer("sse-survive");

    vi.advanceTimersByTime(MCP_SSE_IDLE_TIMEOUT_MS);

    // Session should survive because awake time is below threshold.
    expect(store.sessions.has("sse-survive")).toBe(true);
  });

  it("is a no-op when no sessions exist", () => {
    expect(() => store.recomputeIdleTimers()).not.toThrow();
  });

  it("uses fallback timestamp for sessions missing idleStartedAt (does not expire immediately)", () => {
    setAwakeTime(0);
    const session = fakeSseSession();
    store.sessions.set("no-ts", session);

    store.recomputeIdleTimers();

    expect(store.sessions.has("no-ts")).toBe(true);
  });

  it("repeated recompute calls do not extend idle lifetime (accumulated awake time is preserved)", () => {
    // Simulate: idle for 10 min, sleep, wake (recompute), idle 10 min, sleep,
    // wake (recompute), idle 10 min, sleep, wake (recompute). The session has
    // accumulated 30+ min of awake idle time and should expire on the third wake.
    const thirdOfTimeout = MCP_SSE_IDLE_TIMEOUT_MS / 3;
    setAwakeTime(0);
    const session = fakeSseSession();
    store.sessions.set("acc", session);
    clearTimeout(session.idleTimer);
    session.idleTimer = store.createIdleTimer("acc");

    // First cycle: 10 min awake, recompute on wake.
    setAwakeTime(thirdOfTimeout);
    store.recomputeIdleTimers();
    expect(store.sessions.has("acc")).toBe(true);

    // Second cycle: 20 min awake, recompute on wake.
    setAwakeTime(thirdOfTimeout * 2);
    store.recomputeIdleTimers();
    expect(store.sessions.has("acc")).toBe(true);

    // Third cycle: 30 min awake — should expire.
    setAwakeTime(MCP_SSE_IDLE_TIMEOUT_MS);
    store.recomputeIdleTimers();
    expect(store.sessions.has("acc")).toBe(false);
    expect(resourceCleanups).toContain("acc");
  });
});

describe("SessionStore.revokeSession", () => {
  let store: SessionStore;
  let resourceCleanups: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    resourceCleanups = [];
    store = new SessionStore((sessionId) => {
      resourceCleanups.push(sessionId);
    });
  });

  afterEach(() => {
    store.grantCache.dispose();
    vi.useRealTimers();
  });

  it("revokes an SSE session and cleans all maps", () => {
    const session = fakeSseSession();
    const closeSpy = session.transport.close as ReturnType<typeof vi.fn>;
    store.sessions.set("sse-1", session);
    store.sessionTierMap.set("sse-1", "action");
    store.sessionWebContentsMap.set("sse-1", 42);
    store.sessionContextMap.set("sse-1", { worktreeId: "w1" } as never);
    store.sessionHelpIdMap.set("sse-1", "help-1");

    const result = store.revokeSession("sse-1");

    expect(result).toBe(true);
    expect(store.sessions.has("sse-1")).toBe(false);
    expect(store.sessionTierMap.has("sse-1")).toBe(false);
    expect(store.sessionWebContentsMap.has("sse-1")).toBe(false);
    expect(store.sessionContextMap.has("sse-1")).toBe(false);
    expect(store.sessionHelpIdMap.has("sse-1")).toBe(false);
    expect(resourceCleanups).toContain("sse-1");
    expect(closeSpy).toHaveBeenCalled();
  });

  it("revokes a Streamable-HTTP session", () => {
    const session = fakeHttpSession();
    const closeSpy = session.transport.close as ReturnType<typeof vi.fn>;
    store.httpSessions.set("http-1", session);
    store.sessionTierMap.set("http-1", "system");
    store.sessionWebContentsMap.set("http-1", 99);

    const result = store.revokeSession("http-1");

    expect(result).toBe(true);
    expect(store.httpSessions.has("http-1")).toBe(false);
    expect(store.sessionTierMap.has("http-1")).toBe(false);
    expect(closeSpy).toHaveBeenCalled();
  });

  it("returns false for unknown session", () => {
    expect(store.revokeSession("ghost")).toBe(false);
  });

  it("is idempotent — double revoke is harmless", () => {
    const session = fakeSseSession();
    store.sessions.set("sse-1", session);
    store.sessionTierMap.set("sse-1", "action");

    expect(store.revokeSession("sse-1")).toBe(true);
    expect(store.revokeSession("sse-1")).toBe(false);
  });

  it("only revokes the target session, leaving others intact", () => {
    const s1 = fakeSseSession();
    const s2 = fakeSseSession();
    store.sessions.set("s1", s1);
    store.sessions.set("s2", s2);
    store.sessionTierMap.set("s1", "action");
    store.sessionTierMap.set("s2", "system");

    store.revokeSession("s1");

    expect(store.sessions.has("s1")).toBe(false);
    expect(store.sessions.has("s2")).toBe(true);
    expect(store.sessionTierMap.get("s2")).toBe("system");
  });

  it("clears dedup state for the revoked session", () => {
    const session = fakeSseSession();
    store.sessions.set("sse-1", session);
    store.dedupInFlight.set("sse-1", new Map([["k", Promise.resolve({}) as never]]));
    store.dedupResultCache.set("sse-1", new Map());

    store.revokeSession("sse-1");

    expect(store.dedupInFlight.has("sse-1")).toBe(false);
    expect(store.dedupResultCache.has("sse-1")).toBe(false);
  });

  it("revokes the session's grants via grantCache.revokeSession (#8467)", () => {
    // Without this hop the renderer never receives the `revoked`
    // lifecycle event for outstanding per-tool grants on the
    // session being torn down by the abuse-policy circuit-breaker.
    const session = fakeSseSession();
    store.sessions.set("sse-1", session);
    store.sessionWebContentsMap.set("sse-1", 42);
    const grantRevokeSpy = vi.spyOn(store.grantCache, "revokeSession");

    store.revokeSession("sse-1");

    expect(grantRevokeSpy).toHaveBeenCalledWith("sse-1", "session-ended");
  });
});

describe("SessionStore dropAbuseState wiring (#8467)", () => {
  let dropAbuseSpy: ReturnType<typeof vi.fn<(sessionId: string) => void>>;
  let store: SessionStore;

  beforeEach(() => {
    vi.useFakeTimers();
    dropAbuseSpy = vi.fn<(sessionId: string) => void>();
    store = new SessionStore(() => {}, { dropAbuseState: dropAbuseSpy });
  });

  afterEach(() => {
    store.grantCache.dispose();
    vi.useRealTimers();
  });

  it("invokes dropAbuseState on SSE idle expiry", () => {
    const session = fakeSseSession();
    store.sessions.set("s1", session);
    clearTimeout(session.idleTimer);
    session.idleTimer = store.createIdleTimer("s1");

    vi.advanceTimersByTime(MCP_SSE_IDLE_TIMEOUT_MS + 1);

    expect(dropAbuseSpy).toHaveBeenCalledWith("s1");
  });

  it("invokes dropAbuseState on Streamable-HTTP idle expiry", () => {
    const session = fakeHttpSession();
    store.httpSessions.set("h1", session);
    clearTimeout(session.idleTimer);
    session.idleTimer = store.createHttpIdleTimer("h1");

    vi.advanceTimersByTime(MCP_SSE_IDLE_TIMEOUT_MS + 1);

    expect(dropAbuseSpy).toHaveBeenCalledWith("h1");
  });

  it("invokes dropAbuseState on explicit revokeSession", () => {
    const session = fakeSseSession();
    store.sessions.set("s1", session);

    store.revokeSession("s1");

    expect(dropAbuseSpy).toHaveBeenCalledWith("s1");
  });

  it("does not fire dropAbuseState when revokeSession returns false (unknown session)", () => {
    expect(store.revokeSession("ghost")).toBe(false);
    expect(dropAbuseSpy).not.toHaveBeenCalled();
  });
});

describe("SessionStore dropBearerState wiring (#8778)", () => {
  let dropBearerSpy: ReturnType<typeof vi.fn<(sessionId: string) => void>>;
  let store: SessionStore;

  beforeEach(() => {
    vi.useFakeTimers();
    dropBearerSpy = vi.fn<(sessionId: string) => void>();
    store = new SessionStore(() => {}, { dropBearerState: dropBearerSpy });
  });

  afterEach(() => {
    store.grantCache.dispose();
    vi.useRealTimers();
  });

  it("invokes dropBearerState on SSE idle expiry", () => {
    const session = fakeSseSession();
    store.sessions.set("s1", session);
    clearTimeout(session.idleTimer);
    session.idleTimer = store.createIdleTimer("s1");

    vi.advanceTimersByTime(MCP_SSE_IDLE_TIMEOUT_MS + 1);

    expect(dropBearerSpy).toHaveBeenCalledWith("s1");
  });

  it("invokes dropBearerState on Streamable-HTTP idle expiry", () => {
    const session = fakeHttpSession();
    store.httpSessions.set("h1", session);
    clearTimeout(session.idleTimer);
    session.idleTimer = store.createHttpIdleTimer("h1");

    vi.advanceTimersByTime(MCP_SSE_IDLE_TIMEOUT_MS + 1);

    expect(dropBearerSpy).toHaveBeenCalledWith("h1");
  });

  it("invokes dropBearerState on explicit revokeSession", () => {
    const session = fakeSseSession();
    store.sessions.set("s1", session);

    store.revokeSession("s1");

    expect(dropBearerSpy).toHaveBeenCalledWith("s1");
  });

  it("does not fire dropBearerState when revokeSession returns false (unknown session)", () => {
    expect(store.revokeSession("ghost")).toBe(false);
    expect(dropBearerSpy).not.toHaveBeenCalled();
  });
});

describe("SessionStore tier-elevation decay (#8462)", () => {
  let store: SessionStore;
  let decayed: string[];
  let decayedArgs: Array<{ sessionId: string; previousTier: string; newTier: string }>;

  beforeEach(() => {
    vi.useFakeTimers();
    setAwakeTime(0);
    decayed = [];
    decayedArgs = [];
    store = new SessionStore(() => {}, {
      onTierDecayed: (sessionId, previousTier, newTier) => {
        decayed.push(sessionId);
        decayedArgs.push({ sessionId, previousTier, newTier });
      },
    });
  });

  afterEach(() => {
    store.grantCache.dispose();
    store.drain();
    vi.useRealTimers();
  });

  it("decays a workbench-baseline session back to workbench after the TTL and fires onTierDecayed", () => {
    store.sessions.set("s", fakeSseSession());
    store.sessionTierMap.set("s", "action");
    store.armTierElevationTimer("s", "action", "workbench");

    setAwakeTime(MCP_TIER_ELEVATION_TTL_MS);
    vi.advanceTimersByTime(MCP_TIER_ELEVATION_TTL_MS + 1);

    expect(store.getTier("s")).toBe("workbench");
    expect(decayed).toEqual(["s"]);
  });

  it("passes the elevated tier and baseline to onTierDecayed for the audit trail (#9151)", () => {
    store.sessions.set("s", fakeSseSession());
    store.sessionTierMap.set("s", "action");
    store.armTierElevationTimer("s", "system", "action");
    store.sessionTierMap.set("s", "system");

    setAwakeTime(MCP_TIER_ELEVATION_TTL_MS);
    vi.advanceTimersByTime(MCP_TIER_ELEVATION_TTL_MS + 1);

    expect(decayedArgs).toEqual([{ sessionId: "s", previousTier: "system", newTier: "action" }]);
  });

  it("decays to the session's token baseline, not hardcoded workbench", () => {
    // A help-session bearer configured with `tier: "action"` connects at
    // the action baseline, then gets elevated to system. After the window
    // it must fall back to action — dropping to workbench would strip
    // tools the user legitimately held from handshake.
    store.sessions.set("s", fakeSseSession());
    store.sessionTierMap.set("s", "action");
    store.armTierElevationTimer("s", "system", "action");
    store.sessionTierMap.set("s", "system");

    setAwakeTime(MCP_TIER_ELEVATION_TTL_MS);
    vi.advanceTimersByTime(MCP_TIER_ELEVATION_TTL_MS + 1);

    expect(store.getTier("s")).toBe("action");
    expect(decayed).toEqual(["s"]);
  });

  it("a chained elevation decays all the way to the original baseline", () => {
    // workbench → action → system: the second arm must preserve the
    // workbench baseline captured by the first, not decay to action.
    store.sessions.set("s", fakeSseSession());
    store.sessionTierMap.set("s", "workbench");
    store.armTierElevationTimer("s", "action", "workbench");
    store.sessionTierMap.set("s", "action");
    store.armTierElevationTimer("s", "system", "action");
    store.sessionTierMap.set("s", "system");

    setAwakeTime(MCP_TIER_ELEVATION_TTL_MS);
    vi.advanceTimersByTime(MCP_TIER_ELEVATION_TTL_MS + 1);

    expect(store.getTier("s")).toBe("workbench");
    expect(decayed).toEqual(["s"]);
  });

  it("does not arm a timer when the requested tier equals the baseline (nothing to decay)", () => {
    store.sessions.set("s", fakeSseSession());
    store.sessionTierMap.set("s", "workbench");
    store.armTierElevationTimer("s", "workbench", "workbench");

    setAwakeTime(MCP_TIER_ELEVATION_TTL_MS);
    vi.advanceTimersByTime(MCP_TIER_ELEVATION_TTL_MS + 1);

    expect(decayed).toEqual([]);
  });

  it("drops stale denial-suppression counters on decay so the banner re-triggers", () => {
    store.sessions.set("s", fakeSseSession());
    store.sessionTierMap.set("s", "action");
    store.armTierElevationTimer("s", "action", "workbench");

    // Tool was denied enough times before the elevation that the banner
    // is now suppressed for it.
    store.grantCache.incrementDenial("s", "worktree.delete");
    store.grantCache.incrementDenial("s", "worktree.delete");
    store.grantCache.incrementDenial("s", "worktree.delete");
    expect(store.grantCache.shouldSuppressBanner("s", "worktree.delete")).toBe(true);

    setAwakeTime(MCP_TIER_ELEVATION_TTL_MS);
    vi.advanceTimersByTime(MCP_TIER_ELEVATION_TTL_MS + 1);

    expect(store.getTier("s")).toBe("workbench");
    // Post-decay the next out-of-baseline call must surface the banner.
    expect(store.grantCache.shouldSuppressBanner("s", "worktree.delete")).toBe(false);
  });

  it("re-arming refreshes the window from now (repeat Always allow)", () => {
    store.sessions.set("s", fakeSseSession());
    store.sessionTierMap.set("s", "action");
    store.armTierElevationTimer("s", "action", "workbench");

    // Halfway through the window the user re-approves — window resets.
    setAwakeTime(MCP_TIER_ELEVATION_TTL_MS / 2);
    vi.advanceTimersByTime(MCP_TIER_ELEVATION_TTL_MS / 2);
    store.armTierElevationTimer("s", "action", "workbench");

    // Original deadline passes — must NOT have decayed (window was reset).
    setAwakeTime(MCP_TIER_ELEVATION_TTL_MS / 2 + 1);
    vi.advanceTimersByTime(MCP_TIER_ELEVATION_TTL_MS / 2 + 1);
    expect(store.getTier("s")).toBe("action");

    // Full fresh window elapsed from the re-arm — now it decays.
    setAwakeTime(MCP_TIER_ELEVATION_TTL_MS + 1);
    vi.advanceTimersByTime(MCP_TIER_ELEVATION_TTL_MS);
    expect(store.getTier("s")).toBe("workbench");
  });

  it("does not count suspended time against the window (awake-time corrected)", () => {
    store.sessions.set("s", fakeSseSession());
    store.sessionTierMap.set("s", "system");
    store.armTierElevationTimer("s", "system", "workbench");

    // Wall clock advances a full TTL but the machine was asleep — zero
    // awake time elapsed, so the elevation must survive.
    setAwakeTime(0);
    vi.advanceTimersByTime(MCP_TIER_ELEVATION_TTL_MS + 1);

    expect(store.getTier("s")).toBe("system");
    expect(decayed).toEqual([]);
  });

  it("recomputeIdleTimers does not prematurely decay when awake time is below the TTL (suspend correction)", () => {
    store.httpSessions.set("h", fakeHttpSession());
    store.sessionTierMap.set("h", "action");
    clearTimeout(store.httpSessions.get("h")!.idleTimer);
    store.httpSessions.get("h")!.idleTimer = store.createHttpIdleTimer("h");
    store.armTierElevationTimer("h", "action", "workbench");

    // Long wall-clock sleep but ~no awake time elapsed — the wake recompute
    // must keep both the idle and elevation windows armed, not collapse them.
    setAwakeTime(0);
    store.recomputeIdleTimers();

    expect(store.getTier("h")).toBe("action");
    expect(store.httpSessions.has("h")).toBe(true);
    expect(decayed).toEqual([]);
  });

  it("does not wipe a tier the user re-approved between arm and fire (stale-token guard, #2243)", () => {
    store.sessions.set("s", fakeSseSession());
    store.sessionTierMap.set("s", "action");
    store.armTierElevationTimer("s", "action", "workbench");

    // Simulate a re-elevation to a different tier just before the original
    // timer fires: the live tier no longer matches the captured token.
    store.sessionTierMap.set("s", "system");

    setAwakeTime(MCP_TIER_ELEVATION_TTL_MS);
    vi.advanceTimersByTime(MCP_TIER_ELEVATION_TTL_MS + 1);

    // The original timer's decay must be a no-op — the re-approval stands.
    expect(store.getTier("s")).toBe("system");
    expect(decayed).toEqual([]);
  });

  it("is a safe no-op when the session was torn down before the timer fires (#3728)", () => {
    store.sessions.set("s", fakeSseSession());
    store.sessionTierMap.set("s", "action");
    store.armTierElevationTimer("s", "action", "workbench");

    store.revokeSession("s");

    setAwakeTime(MCP_TIER_ELEVATION_TTL_MS);
    expect(() => vi.advanceTimersByTime(MCP_TIER_ELEVATION_TTL_MS + 1)).not.toThrow();
    expect(decayed).toEqual([]);
  });

  it("clears elevation state on revokeSession, drain, and clearElevationTimer", () => {
    store.sessions.set("s1", fakeSseSession());
    store.armTierElevationTimer("s1", "action", "workbench");
    store.revokeSession("s1");

    store.httpSessions.set("h1", fakeHttpSession());
    store.armTierElevationTimer("h1", "action", "workbench");
    store.clearElevationTimer("h1");

    store.sessions.set("s2", fakeSseSession());
    store.armTierElevationTimer("s2", "action", "workbench");
    store.drain();

    // No armed timer survives — advancing past the TTL decays nothing.
    setAwakeTime(MCP_TIER_ELEVATION_TTL_MS);
    vi.advanceTimersByTime(MCP_TIER_ELEVATION_TTL_MS + 1);
    expect(decayed).toEqual([]);
  });

  it("idle expiry beating elevation decay leaves the decay a no-op", () => {
    store.sessions.set("s", fakeSseSession());
    store.sessionTierMap.set("s", "action");
    clearTimeout(store.sessions.get("s")!.idleTimer);
    store.sessions.get("s")!.idleTimer = store.createIdleTimer("s");
    store.armTierElevationTimer("s", "action", "workbench");

    // Both windows are equal; the idle reaper collects the session first.
    setAwakeTime(MCP_SSE_IDLE_TIMEOUT_MS);
    vi.advanceTimersByTime(MCP_SSE_IDLE_TIMEOUT_MS + 1);

    expect(store.sessions.has("s")).toBe(false);
    expect(decayed).toEqual([]);
  });
});

describe("SessionStore.listExternalActiveClients (#8779)", () => {
  let store: SessionStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new SessionStore(() => {});
  });

  afterEach(() => {
    store.grantCache.dispose();
    vi.useRealTimers();
  });

  function addExternal(
    sessionId: string,
    userAgent: string | null,
    transport: "sse" | "streamable-http"
  ): void {
    if (transport === "sse") {
      store.sessions.set(sessionId, fakeSseSession());
    } else {
      store.httpSessions.set(sessionId, fakeHttpSession());
    }
    store.sessionTierMap.set(sessionId, "external");
    store.registerClientMetadata(sessionId, userAgent, transport);
  }

  it("lists external SSE and HTTP clients with their captured metadata", () => {
    vi.setSystemTime(new Date("2026-05-21T00:00:00Z"));
    addExternal("ext-sse", "Claude Code/1.2", "sse");
    addExternal("ext-http", "Cursor/0.9", "streamable-http");

    const clients = store.listExternalActiveClients();
    expect(clients).toHaveLength(2);
    const bySession = new Map(clients.map((c) => [c.sessionId, c]));
    expect(bySession.get("ext-sse")).toMatchObject({
      userAgent: "Claude Code/1.2",
      transport: "sse",
      connectedAtMs: Date.now(),
    });
    expect(bySession.get("ext-http")).toMatchObject({
      userAgent: "Cursor/0.9",
      transport: "streamable-http",
    });
  });

  it("excludes the internal help-assistant session", () => {
    addExternal("ext", "Claude Code", "streamable-http");
    // Daintree's own consumer, pinned to the renderer that minted it — must
    // not self-name in the disconnect dialog. Classified by origin rather than
    // by having a pin (#11789), because a bound external client has a pin too.
    store.httpSessions.set("internal", fakeHttpSession());
    store.sessionTierMap.set("internal", "external");
    store.sessionOriginMap.set("internal", "help");
    store.sessionWebContentsMap.set("internal", 7);
    store.registerClientMetadata("internal", "node", "streamable-http");

    const clients = store.listExternalActiveClients();
    expect(clients.map((c) => c.sessionId)).toEqual(["ext"]);
  });

  it("excludes an assistant-pane session", () => {
    addExternal("ext", "Claude Code", "streamable-http");
    store.httpSessions.set("pane", fakeHttpSession());
    store.sessionTierMap.set("pane", "external");
    store.sessionOriginMap.set("pane", "assistant-pane");
    store.sessionWebContentsMap.set("pane", 8);
    store.registerClientMetadata("pane", "node", "streamable-http");

    const clients = store.listExternalActiveClients();
    expect(clients.map((c) => c.sessionId)).toEqual(["ext"]);
  });

  it("still lists a workspace-bound external client (#11789)", () => {
    // A real workspace handshake writes `sessionWorkspaceMap` only — the
    // selector and renderer-pin routes are mutually exclusive by construction,
    // since a pinned bearer's selector is refused. A background-bound agent is
    // the one the user most needs to be able to find and disconnect, since
    // they cannot see it working.
    store.httpSessions.set("bound", fakeHttpSession());
    store.sessionTierMap.set("bound", "external");
    store.sessionOriginMap.set("bound", "external");
    store.sessionWorkspaceMap.set("bound", "ws-a");
    store.registerClientMetadata("bound", "Claude Code/1.2", "streamable-http");

    const clients = store.listExternalActiveClients();
    expect(clients.map((c) => c.sessionId)).toEqual(["bound"]);
  });

  it("lists an external client even if one somehow also carried a renderer pin", () => {
    // Defence in depth rather than a reachable state: the point is that
    // classification reads origin, so no future route can silently hide a
    // third-party client from the disconnect UI again.
    store.httpSessions.set("bound", fakeHttpSession());
    store.sessionTierMap.set("bound", "external");
    store.sessionOriginMap.set("bound", "external");
    store.sessionWebContentsMap.set("bound", 42);
    store.registerClientMetadata("bound", "Claude Code/1.2", "streamable-http");

    expect(store.listExternalActiveClients().map((c) => c.sessionId)).toEqual(["bound"]);
  });

  it("excludes non-external (workbench/action/system) sessions", () => {
    addExternal("ext", "Claude Code", "sse");
    store.sessions.set("pane", fakeSseSession());
    store.sessionTierMap.set("pane", "action");
    store.registerClientMetadata("pane", "pane-token-client", "sse");

    const clients = store.listExternalActiveClients();
    expect(clients.map((c) => c.sessionId)).toEqual(["ext"]);
  });

  it("falls back to null user-agent and a present timestamp when none captured", () => {
    store.sessions.set("ext", fakeSseSession());
    store.sessionTierMap.set("ext", "external");
    // No registerClientMetadata call — simulates a pre-metadata session.

    const clients = store.listExternalActiveClients();
    expect(clients).toHaveLength(1);
    expect(clients[0]!.userAgent).toBeNull();
    expect(typeof clients[0]!.connectedAtMs).toBe("number");
  });

  it("drops metadata on revokeSession so the client no longer lists", () => {
    addExternal("ext", "Claude Code", "streamable-http");
    expect(store.listExternalActiveClients()).toHaveLength(1);

    store.revokeSession("ext");

    expect(store.listExternalActiveClients()).toEqual([]);
  });

  it("clears all metadata on drain()", () => {
    addExternal("a", "ua-a", "sse");
    addExternal("b", "ua-b", "streamable-http");

    store.drain();

    expect(store.listExternalActiveClients()).toEqual([]);
  });

  it("clearClientMetadata drops a normally-disconnected client from the list", () => {
    addExternal("ext", "Claude Code", "streamable-http");
    expect(store.listExternalActiveClients()).toHaveLength(1);

    // Mirrors the inline transport.onclose cleanup in httpLifecycle, which
    // deletes the session map entry and clears its metadata.
    store.httpSessions.delete("ext");
    store.clearClientMetadata("ext");

    expect(store.listExternalActiveClients()).toEqual([]);
  });
});

describe("SessionStore.nextFigureNumber (#9828)", () => {
  let store: SessionStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new SessionStore(() => {});
  });

  afterEach(() => {
    store.grantCache.dispose();
    vi.useRealTimers();
  });

  it("assigns sequential figure numbers starting from 1 within a help session", () => {
    expect(store.nextFigureNumber("help-1")).toBe(1);
    expect(store.nextFigureNumber("help-1")).toBe(2);
    expect(store.nextFigureNumber("help-1")).toBe(3);
  });

  it("keeps independent counters per help session", () => {
    expect(store.nextFigureNumber("help-a")).toBe(1);
    expect(store.nextFigureNumber("help-b")).toBe(1);
    expect(store.nextFigureNumber("help-a")).toBe(2);
    expect(store.nextFigureNumber("help-b")).toBe(2);
  });

  it("clears the counter on revokeSession, keyed by the public help-session id", () => {
    store.httpSessions.set("transport-1", fakeHttpSession());
    store.sessionHelpIdMap.set("transport-1", "help-1");
    store.nextFigureNumber("help-1");
    store.nextFigureNumber("help-1");
    expect(store.figureCounters.get("help-1")).toBe(2);

    store.revokeSession("transport-1");

    expect(store.figureCounters.has("help-1")).toBe(false);
    // A fresh session under the same public id restarts at 1.
    expect(store.nextFigureNumber("help-1")).toBe(1);
  });

  it("clears the counter on SSE idle expiry", () => {
    setAwakeTime(MCP_SSE_IDLE_TIMEOUT_MS);
    const session = fakeSseSession();
    store.sessions.set("transport-2", session);
    store.sessionHelpIdMap.set("transport-2", "help-2");
    store.nextFigureNumber("help-2");

    clearTimeout(session.idleTimer);
    session.idleTimer = store.createIdleTimer("transport-2");
    vi.advanceTimersByTime(MCP_SSE_IDLE_TIMEOUT_MS + 1);

    expect(store.figureCounters.has("help-2")).toBe(false);
  });

  it("clears the counter on HTTP idle expiry", () => {
    setAwakeTime(MCP_SSE_IDLE_TIMEOUT_MS);
    const session = fakeHttpSession();
    store.httpSessions.set("transport-h", session);
    store.sessionHelpIdMap.set("transport-h", "help-h");
    store.nextFigureNumber("help-h");

    clearTimeout(session.idleTimer);
    session.idleTimer = store.createHttpIdleTimer("transport-h");
    vi.advanceTimersByTime(MCP_SSE_IDLE_TIMEOUT_MS + 1);

    expect(store.figureCounters.has("help-h")).toBe(false);
  });

  it("clears the counter on normal transport close via clearFigureCounter", () => {
    store.sessionHelpIdMap.set("transport-c", "help-c");
    store.nextFigureNumber("help-c");
    expect(store.figureCounters.get("help-c")).toBe(1);

    // Mirrors the httpLifecycle transport.onclose path: clearFigureCounter
    // must run BEFORE the sessionHelpIdMap entry is deleted.
    store.clearFigureCounter("transport-c");
    store.sessionHelpIdMap.delete("transport-c");

    expect(store.figureCounters.has("help-c")).toBe(false);
  });

  it("clears all counters on drain()", () => {
    store.nextFigureNumber("help-1");
    store.nextFigureNumber("help-2");
    expect(store.figureCounters.size).toBe(2);

    store.drain();

    expect(store.figureCounters.size).toBe(0);
  });
});

describe("SessionStore.getLiveStatusForHelpSession (#10032)", () => {
  let store: SessionStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new SessionStore(() => {});
  });

  afterEach(() => {
    store.grantCache.dispose();
    vi.useRealTimers();
  });

  const WC = 4242;
  const TRANSPORT = "transport-x";
  const HELP_ID = "help-public-1";

  function wireLiveHelpSession(opts?: { tier?: "workbench" | "action" | "system" }): void {
    store.httpSessions.set(TRANSPORT, fakeHttpSession());
    store.sessionWebContentsMap.set(TRANSPORT, WC);
    store.sessionHelpIdMap.set(TRANSPORT, HELP_ID);
    if (opts?.tier) store.sessionTierMap.set(TRANSPORT, opts.tier);
  }

  it("resolves the transport session from the public help id and returns its live tier", () => {
    wireLiveHelpSession({ tier: "system" });

    const result = store.getLiveStatusForHelpSession(HELP_ID, WC);

    expect(result).not.toBeNull();
    expect(result?.tier).toBe("system");
    expect(result?.activeGrants).toEqual([]);
  });

  it("defaults the tier to workbench when the tier map has no entry", () => {
    wireLiveHelpSession();

    expect(store.getLiveStatusForHelpSession(HELP_ID, WC)?.tier).toBe("workbench");
  });

  it("maps active grants to {toolId, expiresAt, ttlMs} for the resolved transport id", () => {
    wireLiveHelpSession({ tier: "action" });
    store.grantCache.issueGrant(TRANSPORT, "terminal.kill");
    store.grantCache.issueGrant(TRANSPORT, "git.push");
    // A grant on an unrelated session must not leak into this snapshot.
    store.grantCache.issueGrant("other-transport", "worktree.delete");

    const grants = store.getLiveStatusForHelpSession(HELP_ID, WC)?.activeGrants ?? [];

    expect(grants.map((g) => g.toolId).sort()).toEqual(["git.push", "terminal.kill"]);
    for (const grant of grants) {
      expect(grant.expiresAt).toBeGreaterThan(Date.now());
      expect(grant.ttlMs).toBeGreaterThan(0);
    }
  });

  it("returns null when the caller is not the pinned WebContents (forgery defence)", () => {
    wireLiveHelpSession({ tier: "system" });

    expect(store.getLiveStatusForHelpSession(HELP_ID, WC + 1)).toBeNull();
  });

  it("returns null when the help id maps to no transport session", () => {
    wireLiveHelpSession({ tier: "system" });

    expect(store.getLiveStatusForHelpSession("unknown-help", WC)).toBeNull();
  });

  it("returns null when the tier map outlives a closed transport (decaying session)", () => {
    // Tier + pin still present, but the transport was already removed — the
    // session is no longer live and must not report as connected.
    store.sessionWebContentsMap.set(TRANSPORT, WC);
    store.sessionHelpIdMap.set(TRANSPORT, HELP_ID);
    store.sessionTierMap.set(TRANSPORT, "system");

    expect(store.getLiveStatusForHelpSession(HELP_ID, WC)).toBeNull();
  });

  it("returns null for an empty help id", () => {
    wireLiveHelpSession({ tier: "system" });

    expect(store.getLiveStatusForHelpSession("", WC)).toBeNull();
  });

  it("omits grants past their expiry that the sweep hasn't yet evicted", () => {
    wireLiveHelpSession({ tier: "action" });
    // Issue one grant, advance the wall clock past its expiry WITHOUT firing
    // the sweep interval (setSystemTime doesn't run timers), then issue a
    // second one still in its window. The first lingers in the cache (lazy
    // eviction) but must not surface as active.
    const expired = store.grantCache.issueGrant(TRANSPORT, "git.push");
    vi.setSystemTime(expired.expiresAt + 1);
    store.grantCache.issueGrant(TRANSPORT, "terminal.kill");

    const grants = store.getLiveStatusForHelpSession(HELP_ID, WC)?.activeGrants ?? [];

    expect(grants.map((g) => g.toolId)).toEqual(["terminal.kill"]);
  });

  it("finds the caller's live transport even when a stale same-help-id mapping is iterated first", () => {
    // A reconnect left an older transport for the same help id pinned to a
    // different WebContents; it must not short-circuit the lookup before the
    // caller's own live transport is reached.
    store.httpSessions.set("stale-transport", fakeHttpSession());
    store.sessionWebContentsMap.set("stale-transport", WC + 99);
    store.sessionHelpIdMap.set("stale-transport", HELP_ID);
    store.sessionTierMap.set("stale-transport", "workbench");

    wireLiveHelpSession({ tier: "system" });

    expect(store.getLiveStatusForHelpSession(HELP_ID, WC)?.tier).toBe("system");
  });
});

describe("SessionStore session origin and workspace binding (#11789)", () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(() => {});
  });

  afterEach(() => {
    store.grantCache.dispose();
  });

  it("classifies an unrecorded session as external", () => {
    // Fail-closed default: a session whose handshake never recorded an origin
    // — or one already half torn down — must never be mistaken for one of
    // Daintree's own surfaces and handed elevation rights.
    expect(store.getOrigin("never-seen")).toBe("external");
    expect(store.isRendererOwnedOrigin("never-seen")).toBe(false);
  });

  it("treats help and assistant-pane as renderer-owned, external as not", () => {
    store.sessionOriginMap.set("help", "help");
    store.sessionOriginMap.set("pane", "assistant-pane");
    store.sessionOriginMap.set("ext", "external");

    expect(store.isRendererOwnedOrigin("help")).toBe(true);
    expect(store.isRendererOwnedOrigin("pane")).toBe(true);
    expect(store.isRendererOwnedOrigin("ext")).toBe(false);
  });

  it("does not treat a workspace-bound external session as renderer-owned", () => {
    // The whole point of splitting origin from routing: this session HAS a
    // renderer route, and must still be refused renderer-driven elevation.
    store.sessionOriginMap.set("bound", "external");
    store.sessionWorkspaceMap.set("bound", "ws-a");
    store.sessionWebContentsMap.set("bound", 42);

    expect(store.isRendererOwnedOrigin("bound")).toBe(false);
  });

  it("clearSessionBinding drops route, context, origin and workspace together", () => {
    store.sessionWebContentsMap.set("s", 42);
    store.sessionContextMap.set("s", { worktreeId: "w1" } as never);
    store.sessionOriginMap.set("s", "help");
    store.sessionWorkspaceMap.set("s", "ws-a");

    store.clearSessionBinding("s");

    expect(store.sessionWebContentsMap.has("s")).toBe(false);
    expect(store.sessionContextMap.has("s")).toBe(false);
    expect(store.sessionOriginMap.has("s")).toBe(false);
    expect(store.sessionWorkspaceMap.has("s")).toBe(false);
    // And the accessor reverts to the fail-closed default rather than keeping
    // a stale privilege a recycled session id could inherit.
    expect(store.isRendererOwnedOrigin("s")).toBe(false);
  });

  it("revokeSession clears the binding record", () => {
    store.httpSessions.set("bound", fakeHttpSession());
    store.sessionTierMap.set("bound", "external");
    store.sessionOriginMap.set("bound", "external");
    store.sessionWorkspaceMap.set("bound", "ws-a");
    store.sessionWebContentsMap.set("bound", 42);

    expect(store.revokeSession("bound")).toBe(true);

    expect(store.sessionOriginMap.has("bound")).toBe(false);
    expect(store.sessionWorkspaceMap.has("bound")).toBe(false);
    expect(store.sessionWebContentsMap.has("bound")).toBe(false);
  });

  it("drain clears the binding records", () => {
    store.httpSessions.set("bound", fakeHttpSession());
    store.sessionOriginMap.set("bound", "external");
    store.sessionWorkspaceMap.set("bound", "ws-a");

    store.drain();

    expect(store.sessionOriginMap.size).toBe(0);
    expect(store.sessionWorkspaceMap.size).toBe(0);
  });

  it("idle expiry clears the binding records", () => {
    vi.useFakeTimers();
    try {
      setAwakeTime(MCP_SSE_IDLE_TIMEOUT_MS + 1);
      const session = fakeHttpSession();
      store.httpSessions.set("bound", session);
      store.sessionOriginMap.set("bound", "external");
      store.sessionWorkspaceMap.set("bound", "ws-a");
      session.idleTimer = store.createHttpIdleTimer("bound");

      vi.advanceTimersByTime(MCP_SSE_IDLE_TIMEOUT_MS + 10);

      expect(store.httpSessions.has("bound")).toBe(false);
      expect(store.sessionOriginMap.has("bound")).toBe(false);
      expect(store.sessionWorkspaceMap.has("bound")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SessionStore.hasLiveWorkspaceBinding (#11790)", () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(() => {});
  });

  afterEach(() => {
    store.grantCache.dispose();
  });

  function bindLiveExternal(sessionId: string, workspaceId: string): void {
    store.httpSessions.set(sessionId, fakeHttpSession());
    store.sessionOriginMap.set(sessionId, "external");
    store.sessionWorkspaceMap.set(sessionId, workspaceId);
  }

  it("reports a live external session bound to the workspace", () => {
    bindLiveExternal("s1", "ws-a");
    expect(store.hasLiveWorkspaceBinding("ws-a")).toBe(true);
  });

  it("scopes the answer to the asked-for workspace", () => {
    bindLiveExternal("s1", "ws-a");
    expect(store.hasLiveWorkspaceBinding("ws-b")).toBe(false);
  });

  it("answers for an SSE-transport session too, not just Streamable HTTP", () => {
    // Only Streamable HTTP can bind today, but liveness must not be
    // transport-specific — nothing here should need changing when SSE can.
    store.sessions.set("s1", fakeSseSession());
    store.sessionOriginMap.set("s1", "external");
    store.sessionWorkspaceMap.set("s1", "ws-a");

    expect(store.hasLiveWorkspaceBinding("ws-a")).toBe(true);
  });

  it("does not report a workspace routing record whose session is no longer live", () => {
    // Presence in sessionWorkspaceMap is routing, not liveness. Without the
    // liveness half, a dropped session would pin its view against freeze and
    // deprioritize it for eviction for the rest of the app's life.
    store.sessionOriginMap.set("s1", "external");
    store.sessionWorkspaceMap.set("s1", "ws-a");

    expect(store.hasLiveWorkspaceBinding("ws-a")).toBe(false);
  });

  it("does not treat a routing record with no recorded origin as external", () => {
    // getOrigin() defaults an unknown session to "external", so reading through
    // it would let a half-torn-down record — origin already dropped, workspace
    // row not yet — read as a live binding. The origin map is read directly for
    // exactly this case.
    store.httpSessions.set("s1", fakeHttpSession());
    store.sessionWorkspaceMap.set("s1", "ws-a");

    expect(store.getOrigin("s1")).toBe("external");
    expect(store.hasLiveWorkspaceBinding("ws-a")).toBe(false);
  });

  it("ignores a renderer-owned session that somehow carries a workspace row", () => {
    store.httpSessions.set("s1", fakeHttpSession());
    store.sessionOriginMap.set("s1", "help");
    store.sessionWorkspaceMap.set("s1", "ws-a");

    expect(store.hasLiveWorkspaceBinding("ws-a")).toBe(false);
  });

  it("still reports the workspace while a second session is bound to it", () => {
    bindLiveExternal("s1", "ws-a");
    bindLiveExternal("s2", "ws-a");

    store.revokeSession("s1");

    expect(store.hasLiveWorkspaceBinding("ws-a")).toBe(true);
  });

  it("releases the workspace once its last session is revoked", () => {
    bindLiveExternal("s1", "ws-a");
    bindLiveExternal("s2", "ws-a");

    store.revokeSession("s1");
    store.revokeSession("s2");

    expect(store.hasLiveWorkspaceBinding("ws-a")).toBe(false);
  });

  it("releases the workspace on drain", () => {
    bindLiveExternal("s1", "ws-a");

    store.drain();

    expect(store.hasLiveWorkspaceBinding("ws-a")).toBe(false);
  });

  it("releases the workspace when the session idles out", () => {
    vi.useFakeTimers();
    try {
      setAwakeTime(MCP_SSE_IDLE_TIMEOUT_MS + 1);
      bindLiveExternal("s1", "ws-a");
      store.httpSessions.get("s1")!.idleTimer = store.createHttpIdleTimer("s1");

      vi.advanceTimersByTime(MCP_SSE_IDLE_TIMEOUT_MS + 10);

      expect(store.hasLiveWorkspaceBinding("ws-a")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
