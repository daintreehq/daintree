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

  describe("idle backoff", () => {
    it("keeps base interval below the miss threshold", () => {
      const strategy = new AdaptivePollingStrategy({ baseInterval: 2000, maxInterval: 30_000 });

      strategy.recordNoChange();
      strategy.recordNoChange();

      expect(strategy.calculateNextInterval()).toBe(2000);
    });

    it("doubles cadence at three consecutive unchanged polls", () => {
      const strategy = new AdaptivePollingStrategy({ baseInterval: 2000, maxInterval: 30_000 });

      strategy.recordNoChange();
      strategy.recordNoChange();
      strategy.recordNoChange();

      expect(strategy.calculateNextInterval()).toBe(4000);
    });

    it("quadruples cadence at six consecutive unchanged polls", () => {
      const strategy = new AdaptivePollingStrategy({ baseInterval: 2000, maxInterval: 30_000 });

      for (let i = 0; i < 6; i++) strategy.recordNoChange();

      expect(strategy.calculateNextInterval()).toBe(8000);
    });

    it("caps at the 4x ceiling beyond six unchanged polls", () => {
      const strategy = new AdaptivePollingStrategy({ baseInterval: 2000, maxInterval: 30_000 });

      for (let i = 0; i < 100; i++) strategy.recordNoChange();

      expect(strategy.calculateNextInterval()).toBe(8000);
    });

    it("recordStateChange resets the idle counter", () => {
      const strategy = new AdaptivePollingStrategy({ baseInterval: 2000, maxInterval: 30_000 });

      for (let i = 0; i < 6; i++) strategy.recordNoChange();
      expect(strategy.calculateNextInterval()).toBe(8000);

      strategy.recordStateChange();
      expect(strategy.calculateNextInterval()).toBe(2000);
    });

    it("reset() zeroes the idle counter alongside other state", () => {
      const strategy = new AdaptivePollingStrategy({ baseInterval: 2000, maxInterval: 30_000 });

      for (let i = 0; i < 6; i++) strategy.recordNoChange();
      expect(strategy.calculateNextInterval()).toBe(8000);

      strategy.reset();
      expect(strategy.calculateNextInterval()).toBe(2000);
    });

    it("idle multiplier is still bounded by maxInterval", () => {
      const strategy = new AdaptivePollingStrategy({ baseInterval: 2000, maxInterval: 5000 });

      for (let i = 0; i < 6; i++) strategy.recordNoChange();

      // 2000 * 4 = 8000, capped at maxInterval (5000)
      expect(strategy.calculateNextInterval()).toBe(5000);
    });

    it("compounds idle multiplier on top of the adaptive backoff", () => {
      const strategy = new AdaptivePollingStrategy({ baseInterval: 1000, maxInterval: 30_000 });

      strategy.recordSuccess(3000, 500);
      // adaptive: ceil(3500 * 1.5) = 5250
      expect(strategy.calculateNextInterval()).toBe(5250);

      for (let i = 0; i < 3; i++) strategy.recordNoChange();
      // 5250 * 2 = 10500
      expect(strategy.calculateNextInterval()).toBe(10500);
    });
  });
});
