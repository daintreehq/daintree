import { describe, it, expect } from "vitest";
import { OutputVolumeDetector } from "../OutputVolumeDetector.js";

describe("OutputVolumeDetector", () => {
  it("returns false when disabled", () => {
    const d = new OutputVolumeDetector({ enabled: false });
    expect(d.update(5000, 1000)).toBe(false);
  });

  describe("enabled (leaky bucket)", () => {
    const config = {
      enabled: true,
      leakRatePerMs: 0.1,
      activationThreshold: 200,
      maxBytesPerFrame: 120,
    };

    it("does not trigger on a single oversized burst (noise gate)", () => {
      // The maxBytesPerFrame cap is the primary defense against single big
      // chunks (status-line writes, OSC variants we don't strip). A 5KB chunk
      // contributes at most maxBytesPerFrame=120 bytes, well below the 200
      // threshold.
      const d = new OutputVolumeDetector(config);
      expect(d.update(5000, 1000)).toBe(false);
    });

    it("triggers on sustained byte production", () => {
      const d = new OutputVolumeDetector(config);
      // Three 100-byte chunks 50ms apart: each contributes 100 (under cap),
      // drain per gap = 5 bytes. After frame 3 level≈290 ≥ 200 → fire.
      expect(d.update(100, 1000)).toBe(false);
      expect(d.update(100, 1050)).toBe(false);
      expect(d.update(100, 1100)).toBe(true);
    });

    it("is sample-cadence invariant: fires at 50ms cadence", () => {
      const d = new OutputVolumeDetector(config);
      // 50-byte chunks at 50ms: drain=5 per gap, net +45/cycle.
      expect(d.update(50, 1000)).toBe(false);
      expect(d.update(50, 1050)).toBe(false);
      expect(d.update(50, 1100)).toBe(false);
      expect(d.update(50, 1150)).toBe(false);
      expect(d.update(50, 1200)).toBe(true);
    });

    it("is sample-cadence invariant: fires at 500ms cadence", () => {
      const d = new OutputVolumeDetector(config);
      // 100-byte chunks at 500ms: drain=50 per gap, net +50/cycle.
      // F1: 100, F2: 50+100=150, F3: 100+100=200 → fire.
      expect(d.update(100, 1000)).toBe(false);
      expect(d.update(100, 1500)).toBe(false);
      expect(d.update(100, 2000)).toBe(true);
    });

    it("drains during idle gaps", () => {
      const d = new OutputVolumeDetector(config);
      d.update(100, 1000);
      // 3000ms gap drains 300 bytes — bucket is now empty.
      expect(d.update(100, 4000)).toBe(false);
      // Subsequent burst at this cadence also doesn't fire from carryover.
      expect(d.update(100, 4050)).toBe(false);
    });

    it("does not trigger on Braille spinner residuals (3 bytes / 100ms)", () => {
      // Even if cosmetic-redraw filtering somehow lets a Braille glyph through,
      // 3-byte chunks at 100ms drain 10 bytes per cycle and contribute 3 —
      // bucket is pinned at zero, never reaches activation.
      const d = new OutputVolumeDetector(config);
      let fired = false;
      for (let i = 0; i < 100; i++) {
        if (d.update(3, 1000 + i * 100)) {
          fired = true;
          break;
        }
      }
      expect(fired).toBe(false);
    });

    it("does not trigger on Braille spinner residuals at 500ms cadence", () => {
      const d = new OutputVolumeDetector(config);
      let fired = false;
      for (let i = 0; i < 100; i++) {
        if (d.update(3, 1000 + i * 500)) {
          fired = true;
          break;
        }
      }
      expect(fired).toBe(false);
    });

    it("resets after firing", () => {
      const d = new OutputVolumeDetector(config);
      d.update(100, 1000);
      d.update(100, 1050);
      expect(d.update(100, 1100)).toBe(true);
      // Bucket reset — the next single small chunk cannot fire on residual.
      expect(d.update(50, 1150)).toBe(false);
    });

    it("reset() clears state", () => {
      const d = new OutputVolumeDetector(config);
      d.update(100, 1000);
      d.update(100, 1050);
      d.reset();
      expect(d.update(50, 1100)).toBe(false);
    });

    it("clamps non-monotonic timestamps to zero elapsed (no negative drain)", () => {
      const d = new OutputVolumeDetector(config);
      // Two small frames with a backward timestamp on the second. The clamp
      // must prevent negative drain from inflating the level above what the
      // raw byte contributions would justify.
      expect(d.update(50, 2000)).toBe(false);
      expect(d.update(50, 1000)).toBe(false);
      // Three 50-byte frames cannot reach activationThreshold=200 even when
      // drain is clamped to zero — the cap on per-frame contribution holds.
      expect(d.update(50, 1500)).toBe(false);
    });

    it("clamps negative dataLength to zero contribution", () => {
      const d = new OutputVolumeDetector(config);
      // Defensive: a caller mistake mustn't blow up the bucket.
      expect(d.update(-50, 1000)).toBe(false);
      expect(d.update(-50, 1050)).toBe(false);
    });
  });

  describe("recencyWindowMs", () => {
    it("derives from activationThreshold / leakRatePerMs", () => {
      const d = new OutputVolumeDetector({
        enabled: true,
        leakRatePerMs: 0.1,
        activationThreshold: 200,
        maxBytesPerFrame: 120,
      });
      expect(d.recencyWindowMs).toBe(2000);
    });

    it("uses defaults when no params are provided", () => {
      // Defaults: activationThreshold=2048, leakRatePerMs=2.048 → 1000ms.
      const d = new OutputVolumeDetector({ enabled: true });
      expect(d.recencyWindowMs).toBe(1000);
    });
  });

  describe("defensive clamps", () => {
    it("clamps non-positive leakRatePerMs to a small finite value", () => {
      const d = new OutputVolumeDetector({
        enabled: true,
        leakRatePerMs: 0,
        activationThreshold: 100,
        maxBytesPerFrame: 50,
      });
      // recencyWindowMs must be finite and bounded — a clamp that yields an
      // absurdly large value (e.g. 100,000ms+) would silently break the
      // hasRecentOutputActivity gate. The 0.001 floor / 100 threshold gives
      // 100,000ms, so the clamp must keep recencyWindowMs ≤ that bound. This
      // assertion catches accidental "tighten the clamp" regressions.
      expect(d.recencyWindowMs).toBeGreaterThan(0);
      expect(d.recencyWindowMs).toBeLessThanOrEqual(100_000);
    });

    it("ignores explicit-undefined config fields and falls through to defaults", () => {
      // Callers that spread a partial options object can pass `{ leakRatePerMs:
      // undefined }`; the spread must not override the default with undefined
      // and trip the clamp fallback.
      const d = new OutputVolumeDetector({
        enabled: true,
        leakRatePerMs: undefined,
        activationThreshold: undefined,
        maxBytesPerFrame: undefined,
      });
      // Default recency = 2048 / 2.048 = 1000ms. A bug here would yield
      // recency = 1 / 0.001 = 1000ms by coincidence — guard with a second
      // assertion that the bucket actually reaches the default threshold.
      expect(d.recencyWindowMs).toBe(1000);
      // A single 1024-byte frame must not fire (confirms activationThreshold
      // was not clamped to 1). Two simultaneous 1024-byte frames sum to
      // exactly 2048 with no drain — fires.
      expect(d.update(1024, 1000)).toBe(false);
      expect(d.update(1024, 1000)).toBe(true);
    });

    it("clamps non-positive activationThreshold to 1 (always fireable)", () => {
      const d = new OutputVolumeDetector({
        enabled: true,
        leakRatePerMs: 0.1,
        activationThreshold: 0,
        maxBytesPerFrame: 50,
      });
      expect(d.update(1, 1000)).toBe(true);
    });

    it("clamps non-positive maxBytesPerFrame to 1", () => {
      const d = new OutputVolumeDetector({
        enabled: true,
        leakRatePerMs: 0.001,
        activationThreshold: 2,
        maxBytesPerFrame: 0,
      });
      // Each frame contributes at most 1 byte; 2 frames at fast cadence trigger.
      d.update(100, 1000);
      // Need a third frame because drain happens between frames; with cap=1
      // and threshold=2, F2 level ≈ 1.95 < 2 → no trigger; F3 level ≈ 2.9.
      d.update(100, 1050);
      expect(d.update(100, 1100)).toBe(true);
    });
  });
});
