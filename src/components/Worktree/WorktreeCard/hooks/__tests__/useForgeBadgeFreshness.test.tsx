/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useForgeBadgeFreshness } from "../useForgeBadgeFreshness";
import { useForgeProviderHealthStore } from "@/store/forgeProviderHealthStore";
import { usePRCircuitBreakerStore } from "@/store/prCircuitBreakerStore";

const PROVIDER_ID = "test.provider";
const FIXED_NOW = 10_000_000;

vi.mock("@/hooks/useResolvedForgeProvider", () => ({
  useResolvedForgeProvider: () => ({
    entry: { pluginId: "test", contribution: { id: "provider", name: "Test Forge" } },
    providerId: PROVIDER_ID,
    resolvedVia: "hostname",
    loading: false,
    refresh: () => {},
  }),
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: { currentProject: { id: string } }) => unknown) =>
    selector({ currentProject: { id: "proj-1" } }),
}));

function setRateLimit(
  blocked: boolean,
  kind: "primary" | "secondary" | null,
  resetAt: number | null
) {
  useForgeProviderHealthStore.getState().applyRateLimit(PROVIDER_ID, {
    blocked,
    kind,
    resetAt,
  });
}

describe("useForgeBadgeFreshness", () => {
  beforeEach(() => {
    setRateLimit(false, null, null);
    usePRCircuitBreakerStore.setState({ tripped: false });
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    setRateLimit(false, null, null);
    usePRCircuitBreakerStore.setState({ tripped: false });
    vi.useRealTimers();
  });

  it("is fresh by default, with no freshnessCause", () => {
    const { result } = renderHook(() => useForgeBadgeFreshness("pr"));
    expect(result.current.freshnessLevel).toBe("fresh");
    expect(result.current.freshnessCause).toBeUndefined();
  });

  it("does not age a badge purely because data is old (no age threshold)", () => {
    // No rate-limit, no circuit-breaker — even a long-idle badge stays fresh.
    const { result } = renderHook(() => useForgeBadgeFreshness("pr"));
    expect(result.current.freshnessLevel).toBe("fresh");
    expect(result.current.freshnessCause).toBeUndefined();
  });

  // -- rate-limit --

  it("ages with cause 'rate-limit' while the rate-limit pause is active", () => {
    setRateLimit(true, "primary", FIXED_NOW + 60_000);
    const { result } = renderHook(() => useForgeBadgeFreshness("pr"));
    expect(result.current.freshnessLevel).toBe("aging");
    expect(result.current.freshnessCause).toBe("rate-limit");
  });

  it("applies rate-limit to issue badges too", () => {
    setRateLimit(true, "secondary", null);
    const { result } = renderHook(() => useForgeBadgeFreshness("issue"));
    expect(result.current.freshnessCause).toBe("rate-limit");
  });

  it("transitions between fresh and aging as the rate-limit state flips", () => {
    const { result, rerender } = renderHook(() => useForgeBadgeFreshness("pr"));
    expect(result.current.freshnessLevel).toBe("fresh");

    act(() => {
      setRateLimit(true, "primary", FIXED_NOW + 60_000);
    });
    rerender();
    expect(result.current.freshnessLevel).toBe("aging");

    act(() => {
      setRateLimit(false, null, null);
    });
    rerender();
    expect(result.current.freshnessLevel).toBe("fresh");
  });

  // -- circuit-breaker (PR only) --

  it("ages PR badges with cause 'circuit-breaker' when the breaker is tripped", () => {
    usePRCircuitBreakerStore.setState({ tripped: true });
    const { result } = renderHook(() => useForgeBadgeFreshness("pr"));
    expect(result.current.freshnessLevel).toBe("aging");
    expect(result.current.freshnessCause).toBe("circuit-breaker");
  });

  it("does not downgrade issue badges when the PR circuit breaker is tripped", () => {
    usePRCircuitBreakerStore.setState({ tripped: true });
    const { result } = renderHook(() => useForgeBadgeFreshness("issue"));
    expect(result.current.freshnessLevel).toBe("fresh");
    expect(result.current.freshnessCause).toBeUndefined();
  });

  it("transitions PR freshness as the circuit-breaker store flips", () => {
    const { result, rerender } = renderHook(() => useForgeBadgeFreshness("pr"));
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
    setRateLimit(true, "primary", FIXED_NOW + 60_000);
    usePRCircuitBreakerStore.setState({ tripped: true });
    const { result } = renderHook(() => useForgeBadgeFreshness("pr"));
    expect(result.current.freshnessCause).toBe("rate-limit");
  });

  // -- passthrough --

  it("returns rateLimitResetAt from the provider health slice", () => {
    const resetTime = FIXED_NOW + 120_000;
    setRateLimit(true, "primary", resetTime);
    const { result } = renderHook(() => useForgeBadgeFreshness("pr"));
    expect(result.current.rateLimitResetAt).toBe(resetTime);
  });

  it("returns null rateLimitResetAt when rate limit is not blocked", () => {
    const { result } = renderHook(() => useForgeBadgeFreshness("pr"));
    expect(result.current.rateLimitResetAt).toBeNull();
  });

  it("returns now reflecting wall-clock time", () => {
    const { result } = renderHook(() => useForgeBadgeFreshness("pr"));
    expect(result.current.now).toBe(FIXED_NOW);
  });
});
