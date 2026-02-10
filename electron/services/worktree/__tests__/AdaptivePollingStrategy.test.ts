import { describe, expect, it } from "vitest";
import { AdaptivePollingStrategy } from "../AdaptivePollingStrategy.js";

describe("AdaptivePollingStrategy", () => {
  it("uses base interval when no activity has been recorded", () => {
    const strategy = new AdaptivePollingStrategy({ baseInterval: 1500, maxInterval: 10_000 });

    expect(strategy.calculateNextInterval()).toBe(1500);
  });

  it("applies adaptive backoff from recorded durations and queue delay", () => {
    const strategy = new AdaptivePollingStrategy({ baseInterval: 1000, maxInterval: 10_000 });

    strategy.recordSuccess(3000, 500);

    expect(strategy.calculateNextInterval()).toBe(5250);
  });

  it("caps adaptive interval at maxInterval", () => {
    const strategy = new AdaptivePollingStrategy({ baseInterval: 1000, maxInterval: 3000 });

    strategy.recordSuccess(10_000);

    expect(strategy.calculateNextInterval()).toBe(3000);
  });

  it("trips circuit breaker only after threshold failures", () => {
    const strategy = new AdaptivePollingStrategy({ circuitBreakerThreshold: 3 });

    expect(strategy.recordFailure(100)).toBe(false);
    expect(strategy.recordFailure(100)).toBe(false);
    expect(strategy.recordFailure(100)).toBe(true);
    expect(strategy.isCircuitBreakerTripped()).toBe(true);
  });

  it("keeps interval finite when success inputs are invalid", () => {
    const strategy = new AdaptivePollingStrategy({ baseInterval: 2000, maxInterval: 8000 });

    strategy.recordSuccess(Number.NaN, Number.POSITIVE_INFINITY);
    const metrics = strategy.getMetrics();

    expect(metrics.lastOperationDuration).toBe(0);
    expect(metrics.lastQueueDelay).toBe(0);
    expect(Number.isFinite(metrics.currentInterval)).toBe(true);
    expect(metrics.currentInterval).toBe(2000);
  });

  it("ignores invalid interval and threshold updates", () => {
    const strategy = new AdaptivePollingStrategy({ baseInterval: 2000, maxInterval: 7000 });

    strategy.setBaseInterval(Number.NaN);
    strategy.updateConfig(undefined, Number.NEGATIVE_INFINITY, 0);
    strategy.recordSuccess(3000);

    expect(strategy.calculateNextInterval()).toBe(4500);

    // Threshold should still be the default (3), so first two failures do not trip
    expect(strategy.recordFailure(100)).toBe(false);
    expect(strategy.recordFailure(100)).toBe(false);
    expect(strategy.recordFailure(100)).toBe(true);
  });

  it("maintains invariant that current interval is finite and >= 1", () => {
    const strategy = new AdaptivePollingStrategy({
      baseInterval: Number.POSITIVE_INFINITY,
      maxInterval: Number.NaN,
      circuitBreakerThreshold: Number.NEGATIVE_INFINITY,
    });

    strategy.recordSuccess(Number.POSITIVE_INFINITY, Number.NaN);
    strategy.setBaseInterval(-100);
    strategy.updateConfig(true, Number.NaN, Number.NaN);

    const interval = strategy.calculateNextInterval();
    expect(Number.isFinite(interval)).toBe(true);
    expect(interval).toBeGreaterThanOrEqual(1);
  });
});
