/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useGitHubBadgeFreshness } from "../useGitHubBadgeFreshness";
import * as cache from "@/lib/githubResourceCache";
import type { GitHubResourceCacheEntry } from "@/lib/githubResourceCache";
import { useGitHubRateLimitStore } from "@/store/githubRateLimitStore";
import { usePRCircuitBreakerStore } from "@/store/prCircuitBreakerStore";

function makeCacheEntry(timestamp: number): GitHubResourceCacheEntry {
  return { items: [], endCursor: null, hasNextPage: false, timestamp };
}

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: { currentProject?: { path: string } | null }) => unknown) =>
    selector({ currentProject: { path: "/test/repo" } }),
}));

let mockTick = 0;
vi.mock("@/hooks/useGlobalMinuteTicker", () => ({
  useGlobalMinuteTicker: () => mockTick,
}));

const PR_KEY = "/test/repo:pr:open:created";
const ISSUE_KEY = "/test/repo:issue:open:created";
const STALE_THRESHOLD_MS = 3 * 60 * 1000;
const FIXED_NOW = 10_000_000;

describe("useGitHubBadgeFreshness", () => {
  beforeEach(() => {
    cache._resetForTests();
    useGitHubRateLimitStore.setState({ blocked: false, kind: null, resetAt: null });
    usePRCircuitBreakerStore.setState({ tripped: false });
    mockTick = 1;
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    cache._resetForTests();
    useGitHubRateLimitStore.setState({ blocked: false, kind: null, resetAt: null });
    usePRCircuitBreakerStore.setState({ tripped: false });
    vi.useRealTimers();
  });

  it("returns fresh when row timestamp is undefined", () => {
    const { result } = renderHook(() => useGitHubBadgeFreshness("pr", undefined));
    expect(result.current.freshnessLevel).toBe("fresh");
  });

  it("returns fresh when row timestamp is null (cast)", () => {
    const { result } = renderHook(() =>
      useGitHubBadgeFreshness("pr", null as unknown as number | undefined)
    );
    expect(result.current.freshnessLevel).toBe("fresh");
  });

  it("returns fresh when row was just updated (age 0)", () => {
    const { result } = renderHook(() => useGitHubBadgeFreshness("pr", FIXED_NOW));
    expect(result.current.freshnessLevel).toBe("fresh");
  });

  it("returns fresh when row age is just below threshold", () => {
    const rowTime = FIXED_NOW - (STALE_THRESHOLD_MS - 1);
    const { result } = renderHook(() => useGitHubBadgeFreshness("pr", rowTime));
    expect(result.current.freshnessLevel).toBe("fresh");
  });

  it("returns fresh when row age equals threshold exactly (strict >)", () => {
    const rowTime = FIXED_NOW - STALE_THRESHOLD_MS;
    const { result } = renderHook(() => useGitHubBadgeFreshness("pr", rowTime));
    expect(result.current.freshnessLevel).toBe("fresh");
  });

  it("returns aging when row age is just over threshold", () => {
    const rowTime = FIXED_NOW - (STALE_THRESHOLD_MS + 1);
    const { result } = renderHook(() => useGitHubBadgeFreshness("pr", rowTime));
    expect(result.current.freshnessLevel).toBe("aging");
  });

  it("returns aging when row age is well past threshold", () => {
    const rowTime = FIXED_NOW - 10 * 60 * 1000;
    const { result } = renderHook(() => useGitHubBadgeFreshness("pr", rowTime));
    expect(result.current.freshnessLevel).toBe("aging");
  });

  it("returns fresh when row timestamp is in the future (clock skew)", () => {
    const rowTime = FIXED_NOW + 60_000;
    const { result } = renderHook(() => useGitHubBadgeFreshness("pr", rowTime));
    expect(result.current.freshnessLevel).toBe("fresh");
  });

  it("does not use cache timestamp to determine aging", () => {
    const rowTime = FIXED_NOW - 1000;
    cache.setCache(PR_KEY, makeCacheEntry(FIXED_NOW));

    const { result } = renderHook(() => useGitHubBadgeFreshness("pr", rowTime));
    expect(result.current.freshnessLevel).toBe("fresh");
  });

  it("still returns cacheLastUpdatedAt for tooltip suffix consumers", () => {
    const cacheTime = FIXED_NOW - 5_000;
    cache.setCache(PR_KEY, makeCacheEntry(cacheTime));

    const { result } = renderHook(() => useGitHubBadgeFreshness("pr", FIXED_NOW));
    expect(result.current.cacheLastUpdatedAt).toBe(cacheTime);
  });

  it("returns null cacheLastUpdatedAt when no cache entry exists", () => {
    const { result } = renderHook(() => useGitHubBadgeFreshness("pr", FIXED_NOW));
    expect(result.current.cacheLastUpdatedAt).toBeNull();
  });

  it("returns now reflecting wall-clock time", () => {
    mockTick = 5;
    const { result } = renderHook(() => useGitHubBadgeFreshness("pr", undefined));
    expect(result.current.now).toBe(FIXED_NOW);
  });

  it("treats badges as aging while rate-limit pause is active, even with no cache", () => {
    useGitHubRateLimitStore.setState({
      blocked: true,
      kind: "primary",
      resetAt: Date.now() + 60_000,
    });

    const { result } = renderHook(() => useGitHubBadgeFreshness("pr", Date.now()));
    expect(result.current.freshnessLevel).toBe("aging");
  });

  it("treats badges as aging while rate-limit pause is active, regardless of cache freshness", () => {
    const time = Date.now();
    cache.setCache(PR_KEY, makeCacheEntry(time));
    useGitHubRateLimitStore.setState({
      blocked: true,
      kind: "secondary",
      resetAt: null,
    });

    // Without rate-limit, this would be "fresh" (cache time equals row time).
    const { result } = renderHook(() => useGitHubBadgeFreshness("pr", time));
    expect(result.current.freshnessLevel).toBe("aging");
  });

  it("transitions between fresh and aging as the rate-limit store flips", async () => {
    const { act } = await import("@testing-library/react");
    const time = Date.now();
    cache.setCache(PR_KEY, makeCacheEntry(time));

    const { result, rerender } = renderHook(() => useGitHubBadgeFreshness("pr", time));
    expect(result.current.freshnessLevel).toBe("fresh");

    act(() => {
      useGitHubRateLimitStore.setState({
        blocked: true,
        kind: "primary",
        resetAt: Date.now() + 60_000,
      });
    });
    rerender();
    expect(result.current.freshnessLevel).toBe("aging");

    act(() => {
      useGitHubRateLimitStore.setState({ blocked: false, kind: null, resetAt: null });
    });
    rerender();
    expect(result.current.freshnessLevel).toBe("fresh");
  });

  it("treats PR badges as aging while the circuit breaker is tripped, even with fresh data", () => {
    const time = Date.now();
    cache.setCache(PR_KEY, makeCacheEntry(time));
    usePRCircuitBreakerStore.setState({ tripped: true });

    const { result } = renderHook(() => useGitHubBadgeFreshness("pr", time));
    expect(result.current.freshnessLevel).toBe("aging");
  });

  it("does not downgrade issue badges when the PR circuit breaker is tripped", () => {
    const time = Date.now();
    usePRCircuitBreakerStore.setState({ tripped: true });

    const { result } = renderHook(() => useGitHubBadgeFreshness("issue", time));
    expect(result.current.freshnessLevel).toBe("fresh");
  });

  it("transitions PR freshness as the circuit-breaker store flips", async () => {
    const { act } = await import("@testing-library/react");
    const time = Date.now();
    cache.setCache(PR_KEY, makeCacheEntry(time));

    const { result, rerender } = renderHook(() => useGitHubBadgeFreshness("pr", time));
    expect(result.current.freshnessLevel).toBe("fresh");

    act(() => {
      usePRCircuitBreakerStore.setState({ tripped: true });
    });
    rerender();
    expect(result.current.freshnessLevel).toBe("aging");

    act(() => {
      usePRCircuitBreakerStore.setState({ tripped: false });
    });
    rerender();
    expect(result.current.freshnessLevel).toBe("fresh");
  });

  it("uses the issue cache key when type is 'issue'", () => {
    const cacheTime = FIXED_NOW - 5_000;
    cache.setCache(ISSUE_KEY, makeCacheEntry(cacheTime));
    cache.setCache(PR_KEY, makeCacheEntry(FIXED_NOW - 50_000));

    const { result } = renderHook(() => useGitHubBadgeFreshness("issue", FIXED_NOW));
    expect(result.current.cacheLastUpdatedAt).toBe(cacheTime);
  });

  it("re-evaluates aging as wall-clock time advances past threshold", () => {
    const rowTime = FIXED_NOW - (STALE_THRESHOLD_MS - 1);
    const { result, rerender } = renderHook(({ row }) => useGitHubBadgeFreshness("pr", row), {
      initialProps: { row: rowTime },
    });
    expect(result.current.freshnessLevel).toBe("fresh");

    vi.setSystemTime(FIXED_NOW + 2);
    mockTick = 2;
    rerender({ row: rowTime });

    expect(result.current.freshnessLevel).toBe("aging");
  });

  // -- freshnessCause discriminator --

  it("returns undefined freshnessCause when fresh", () => {
    const { result } = renderHook(() => useGitHubBadgeFreshness("pr", FIXED_NOW));
    expect(result.current.freshnessLevel).toBe("fresh");
    expect(result.current.freshnessCause).toBeUndefined();
  });

  it("returns freshnessCause 'stale' when past age threshold", () => {
    const rowTime = FIXED_NOW - (STALE_THRESHOLD_MS + 1);
    const { result } = renderHook(() => useGitHubBadgeFreshness("pr", rowTime));
    expect(result.current.freshnessLevel).toBe("aging");
    expect(result.current.freshnessCause).toBe("stale");
  });

  it("returns freshnessCause 'rate-limit' while rate-limit pause is active", () => {
    useGitHubRateLimitStore.setState({
      blocked: true,
      kind: "primary",
      resetAt: Date.now() + 60_000,
    });
    const { result } = renderHook(() => useGitHubBadgeFreshness("pr", Date.now()));
    expect(result.current.freshnessCause).toBe("rate-limit");
  });

  it("returns freshnessCause 'circuit-breaker' for PR type when breaker tripped", () => {
    usePRCircuitBreakerStore.setState({ tripped: true });
    const { result } = renderHook(() => useGitHubBadgeFreshness("pr", Date.now()));
    expect(result.current.freshnessCause).toBe("circuit-breaker");
  });

  it("does not return circuit-breaker cause for issue type when breaker tripped", () => {
    usePRCircuitBreakerStore.setState({ tripped: true });
    const { result } = renderHook(() => useGitHubBadgeFreshness("issue", Date.now()));
    expect(result.current.freshnessLevel).toBe("fresh");
    expect(result.current.freshnessCause).toBeUndefined();
  });

  it("rate-limit takes precedence over circuit-breaker for cause", () => {
    useGitHubRateLimitStore.setState({
      blocked: true,
      kind: "primary",
      resetAt: Date.now() + 60_000,
    });
    usePRCircuitBreakerStore.setState({ tripped: true });
    const { result } = renderHook(() => useGitHubBadgeFreshness("pr", Date.now()));
    expect(result.current.freshnessCause).toBe("rate-limit");
  });

  it("rate-limit takes precedence over age threshold for cause", () => {
    const rowTime = FIXED_NOW - (STALE_THRESHOLD_MS + 1);
    useGitHubRateLimitStore.setState({
      blocked: true,
      kind: "secondary",
      resetAt: Date.now() + 60_000,
    });
    const { result } = renderHook(() => useGitHubBadgeFreshness("pr", rowTime));
    expect(result.current.freshnessCause).toBe("rate-limit");
  });

  it("circuit-breaker takes precedence over age threshold for cause", () => {
    const rowTime = FIXED_NOW - (STALE_THRESHOLD_MS + 1);
    usePRCircuitBreakerStore.setState({ tripped: true });
    const { result } = renderHook(() => useGitHubBadgeFreshness("pr", rowTime));
    expect(result.current.freshnessCause).toBe("circuit-breaker");
  });

  // -- rateLimitResetAt passthrough --

  it("returns rateLimitResetAt from the rate-limit store", () => {
    const resetTime = Date.now() + 120_000;
    useGitHubRateLimitStore.setState({
      blocked: true,
      kind: "primary",
      resetAt: resetTime,
    });
    const { result } = renderHook(() => useGitHubBadgeFreshness("pr", Date.now()));
    expect(result.current.rateLimitResetAt).toBe(resetTime);
  });

  it("returns null rateLimitResetAt when rate limit is not blocked", () => {
    const { result } = renderHook(() => useGitHubBadgeFreshness("pr", FIXED_NOW));
    expect(result.current.rateLimitResetAt).toBeNull();
  });
});
