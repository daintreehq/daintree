/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useGitHubBadgeFreshness } from "../useGitHubBadgeFreshness";
import { useGitHubRateLimitStore } from "@/store/githubRateLimitStore";
import { usePRCircuitBreakerStore } from "@/store/prCircuitBreakerStore";

const FIXED_NOW = 10_000_000;

describe("useGitHubBadgeFreshness", () => {
  beforeEach(() => {
    useGitHubRateLimitStore.setState({ blocked: false, kind: null, resetAt: null });
    usePRCircuitBreakerStore.setState({ tripped: false });
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    useGitHubRateLimitStore.setState({ blocked: false, kind: null, resetAt: null });
    usePRCircuitBreakerStore.setState({ tripped: false });
    vi.useRealTimers();
  });

  it("is fresh by default, with no freshnessCause", () => {
    const { result } = renderHook(() => useGitHubBadgeFreshness("pr"));
    expect(result.current.freshnessLevel).toBe("fresh");
    expect(result.current.freshnessCause).toBeUndefined();
  });

  it("does not age a badge purely because data is old (no age threshold)", () => {
    // No rate-limit, no circuit-breaker — even a long-idle badge stays fresh.
    const { result } = renderHook(() => useGitHubBadgeFreshness("pr"));
    expect(result.current.freshnessLevel).toBe("fresh");
    expect(result.current.freshnessCause).toBeUndefined();
  });

  // -- rate-limit --

  it("ages with cause 'rate-limit' while the rate-limit pause is active", () => {
    useGitHubRateLimitStore.setState({
      blocked: true,
      kind: "primary",
      resetAt: FIXED_NOW + 60_000,
    });
    const { result } = renderHook(() => useGitHubBadgeFreshness("pr"));
    expect(result.current.freshnessLevel).toBe("aging");
    expect(result.current.freshnessCause).toBe("rate-limit");
  });

  it("applies rate-limit to issue badges too", () => {
    useGitHubRateLimitStore.setState({ blocked: true, kind: "secondary", resetAt: null });
    const { result } = renderHook(() => useGitHubBadgeFreshness("issue"));
    expect(result.current.freshnessCause).toBe("rate-limit");
  });

  it("transitions between fresh and aging as the rate-limit store flips", () => {
    const { result, rerender } = renderHook(() => useGitHubBadgeFreshness("pr"));
    expect(result.current.freshnessLevel).toBe("fresh");

    act(() => {
      useGitHubRateLimitStore.setState({
        blocked: true,
        kind: "primary",
        resetAt: FIXED_NOW + 60_000,
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

  // -- circuit-breaker (PR only) --

  it("ages PR badges with cause 'circuit-breaker' when the breaker is tripped", () => {
    usePRCircuitBreakerStore.setState({ tripped: true });
    const { result } = renderHook(() => useGitHubBadgeFreshness("pr"));
    expect(result.current.freshnessLevel).toBe("aging");
    expect(result.current.freshnessCause).toBe("circuit-breaker");
  });

  it("does not downgrade issue badges when the PR circuit breaker is tripped", () => {
    usePRCircuitBreakerStore.setState({ tripped: true });
    const { result } = renderHook(() => useGitHubBadgeFreshness("issue"));
    expect(result.current.freshnessLevel).toBe("fresh");
    expect(result.current.freshnessCause).toBeUndefined();
  });

  it("transitions PR freshness as the circuit-breaker store flips", () => {
    const { result, rerender } = renderHook(() => useGitHubBadgeFreshness("pr"));
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

  // -- precedence --

  it("rate-limit takes precedence over circuit-breaker for cause", () => {
    useGitHubRateLimitStore.setState({
      blocked: true,
      kind: "primary",
      resetAt: FIXED_NOW + 60_000,
    });
    usePRCircuitBreakerStore.setState({ tripped: true });
    const { result } = renderHook(() => useGitHubBadgeFreshness("pr"));
    expect(result.current.freshnessCause).toBe("rate-limit");
  });

  // -- passthrough --

  it("returns rateLimitResetAt from the rate-limit store", () => {
    const resetTime = FIXED_NOW + 120_000;
    useGitHubRateLimitStore.setState({ blocked: true, kind: "primary", resetAt: resetTime });
    const { result } = renderHook(() => useGitHubBadgeFreshness("pr"));
    expect(result.current.rateLimitResetAt).toBe(resetTime);
  });

  it("returns null rateLimitResetAt when rate limit is not blocked", () => {
    const { result } = renderHook(() => useGitHubBadgeFreshness("pr"));
    expect(result.current.rateLimitResetAt).toBeNull();
  });

  it("returns now reflecting wall-clock time", () => {
    const { result } = renderHook(() => useGitHubBadgeFreshness("pr"));
    expect(result.current.now).toBe(FIXED_NOW);
  });
});
