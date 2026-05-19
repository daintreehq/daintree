import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCP_SSE_IDLE_TIMEOUT_MS, type McpSseSession, type McpHttpSession } from "../shared.js";

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

    store.drain();

    expect(store.sessions.size).toBe(0);
    expect(store.httpSessions.size).toBe(0);
    expect(store.sessionTierMap.size).toBe(0);
    expect(store.sessionWebContentsMap.size).toBe(0);
  });

  it("SSE idle-timer expiry deletes the session's pin so an evicted session does not leak the WebContents id", () => {
    setAwakeTime(MCP_SSE_IDLE_TIMEOUT_MS);
    const session = fakeSseSession();
    const sessionId = "sse-1";
    store.sessions.set(sessionId, session);
    store.sessionTierMap.set(sessionId, "action");
    store.sessionWebContentsMap.set(sessionId, 42);

    clearTimeout(session.idleTimer);
    session.idleTimer = store.createIdleTimer(sessionId);

    // Advance past the idle window only — running every timer would
    // re-fire the GrantCache sweep interval indefinitely.
    vi.advanceTimersByTime(MCP_SSE_IDLE_TIMEOUT_MS + 1);

    expect(store.sessions.has(sessionId)).toBe(false);
    expect(store.sessionTierMap.has(sessionId)).toBe(false);
    expect(store.sessionWebContentsMap.has(sessionId)).toBe(false);
    expect(resourceCleanups).toContain(sessionId);
  });

  it("Streamable-HTTP idle-timer expiry deletes the session's pin", () => {
    setAwakeTime(MCP_SSE_IDLE_TIMEOUT_MS);
    const session = fakeHttpSession();
    const sessionId = "http-1";
    store.httpSessions.set(sessionId, session);
    store.sessionTierMap.set(sessionId, "action");
    store.sessionWebContentsMap.set(sessionId, 99);

    clearTimeout(session.idleTimer);
    session.idleTimer = store.createHttpIdleTimer(sessionId);

    // Advance past the idle window only — running every timer would
    // re-fire the GrantCache sweep interval indefinitely.
    vi.advanceTimersByTime(MCP_SSE_IDLE_TIMEOUT_MS + 1);

    expect(store.httpSessions.has(sessionId)).toBe(false);
    expect(store.sessionTierMap.has(sessionId)).toBe(false);
    expect(store.sessionWebContentsMap.has(sessionId)).toBe(false);
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

    const result = store.revokeSession("sse-1");

    expect(result).toBe(true);
    expect(store.sessions.has("sse-1")).toBe(false);
    expect(store.sessionTierMap.has("sse-1")).toBe(false);
    expect(store.sessionWebContentsMap.has("sse-1")).toBe(false);
    expect(store.sessionContextMap.has("sse-1")).toBe(false);
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
});
