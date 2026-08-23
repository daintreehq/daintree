import { afterEach, describe, expect, it } from "vitest";
import {
  getSystemMemoryThresholds,
  readAvailableSystemMemoryMb,
  readSystemMemorySnapshot,
} from "../systemMemory.js";

describe("systemMemory thresholds", () => {
  it("preserves proportional thresholds on an 8 GB machine", () => {
    expect(getSystemMemoryThresholds(8 * 1024)).toEqual({
      criticalMb: 8 * 1024 * 0.1,
      warningMb: 8 * 1024 * 0.2,
    });
  });

  it("leaves every machine at or below the knee on the raw fractions", () => {
    // Widening the band (#11926) must not have moved the machines the issue
    // was not about: below the point where the critical cap starts winning,
    // both edges are still exactly the fraction.
    for (let totalMb = 512; totalMb <= 10 * 1024; totalMb += 37) {
      expect(getSystemMemoryThresholds(totalMb)).toEqual({
        criticalMb: totalMb * 0.1,
        warningMb: totalMb * 0.2,
      });
    }
  });

  it("holds the critical edge flat above the knee while the warning edge keeps widening", () => {
    // The asymmetry IS the fix. `criticalMb` gates tier-2 collapse, the
    // efficiency latch and OOM classification, and is measured against a
    // `free + purgeable` figure that omits Darwin's file cache — so it stays
    // put. `warningMb` only starts the one-view-per-tick ladder, so it is the
    // edge allowed to scale with the machine.
    const knee = getSystemMemoryThresholds(10 * 1024);
    let previousWarning = knee.warningMb;
    // Strictly increasing only up to the saturation point; past it the band is
    // deliberately flat (covered by "stops widening once the band saturates").
    for (const totalMb of [16, 24, 32, 40].map((gib) => gib * 1024)) {
      const { criticalMb, warningMb } = getSystemMemoryThresholds(totalMb);
      expect(criticalMb).toBe(knee.criticalMb);
      expect(warningMb).toBeGreaterThan(previousWarning);
      previousWarning = warningMb;
    }
    // The flat critical edge holds all the way out, not just to saturation.
    for (const totalMb of [64, 128, 1024].map((gib) => gib * 1024)) {
      expect(getSystemMemoryThresholds(totalMb).criticalMb).toBe(knee.criticalMb);
    }
  });

  it("bounds the widened band well below the raw warning fraction", () => {
    // Uncapped, 20% of 64 GB would arm reclaim at 12.8 GB available, which on
    // a healthy machine is most of the time.
    for (const totalMb of [16, 32, 64, 128, 1024].map((gib) => gib * 1024)) {
      const { warningMb } = getSystemMemoryThresholds(totalMb);
      expect(warningMb).toBeLessThan(totalMb * 0.2);
      expect(warningMb).toBeLessThanOrEqual(3 * 1024);
    }
  });

  it("stops widening once the band saturates", () => {
    const saturated = getSystemMemoryThresholds(64 * 1024);
    expect(getSystemMemoryThresholds(128 * 1024)).toEqual(saturated);
    expect(getSystemMemoryThresholds(1024 * 1024)).toEqual(saturated);
  });

  it("keeps the edges finite, ordered and monotonic from 1 MB to 1 TB", () => {
    // A band whose edges meet degenerates memoryPressureTarget to the
    // pre-#11469 cliff, and a non-finite edge leaks into a pushed policy.
    // Violations are collected rather than asserted per-step so a failure
    // reports the total it first broke at instead of one opaque line.
    const violations: string[] = [];
    let previous = { criticalMb: 0, warningMb: 0 };
    for (let totalMb = 1; totalMb <= 1024 * 1024; totalMb += 13) {
      const { criticalMb, warningMb } = getSystemMemoryThresholds(totalMb);
      if (!Number.isFinite(criticalMb) || !Number.isFinite(warningMb)) {
        violations.push(`${totalMb}: non-finite edge`);
      } else if (criticalMb <= 0) {
        violations.push(`${totalMb}: criticalMb ${criticalMb} not positive`);
      } else if (warningMb <= criticalMb) {
        violations.push(`${totalMb}: degenerate band ${criticalMb}..${warningMb}`);
      } else if (criticalMb < previous.criticalMb || warningMb < previous.warningMb) {
        violations.push(`${totalMb}: band narrowed as RAM grew`);
      }
      previous = { criticalMb, warningMb };
    }
    expect(violations.slice(0, 5)).toEqual([]);
  });

  it("is continuous across the knee and the saturation point", () => {
    // A step at either seam would make the band jump for a 1 MB difference in
    // reported RAM.
    for (const seamMb of [10 * 1024, 42 * 1024]) {
      const below = getSystemMemoryThresholds(seamMb - 1);
      const at = getSystemMemoryThresholds(seamMb);
      const above = getSystemMemoryThresholds(seamMb + 1);
      expect(at.warningMb - below.warningMb).toBeLessThan(1);
      expect(above.warningMb - at.warningMb).toBeLessThan(1);
    }
  });

  it("falls open on a malformed total instead of propagating it", () => {
    // These reach the band as `os.totalmem() / 1024 / 1024`. A NaN edge would
    // silently disable every comparison downstream; the substituted floor keeps
    // the band valid and still below any reading a live machine produces.
    const floor = getSystemMemoryThresholds(1);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 0.5]) {
      expect(getSystemMemoryThresholds(bad)).toEqual(floor);
    }
    expect(floor.warningMb).toBeGreaterThan(floor.criticalMb);
    expect(floor.warningMb).toBeLessThan(1);
  });
});

describe("readSystemMemorySnapshot", () => {
  const proc = process as unknown as {
    getSystemMemoryInfo?: () => { free: number; purgeable?: number; total: number };
  };
  const original = proc.getSystemMemoryInfo;

  function stub(value: unknown) {
    Object.defineProperty(process, "getSystemMemoryInfo", { configurable: true, value });
  }

  afterEach(() => {
    Object.defineProperty(process, "getSystemMemoryInfo", {
      configurable: true,
      value: original,
    });
  });

  it("treats a zero total as an API artifact rather than critical pressure", () => {
    // A transiently zeroed struct must not read as "no memory available" — that
    // would collapse every cached view and downgrade the profile on a glitch.
    stub(() => ({ free: 0, purgeable: 0, total: 8 * 1024 * 1024 }));
    expect(readAvailableSystemMemoryMb()).toBeNull();
  });

  it("rejects a malformed reading instead of coercing the missing field to zero", () => {
    // `free: -1` with a plausible purgeable would otherwise sum back into a
    // healthy-looking figure.
    stub(() => ({ free: -1024, purgeable: 4096, total: 8 * 1024 * 1024 }));
    expect(readAvailableSystemMemoryMb()).toBeNull();

    for (const bad of [{}, { free: "lots" }, { free: Number.NaN }]) {
      stub(() => bad);
      expect(readAvailableSystemMemoryMb()).toBeNull();
    }
    stub(undefined);
    expect(readAvailableSystemMemoryMb()).toBeNull();
    stub(() => {
      throw new Error("boom");
    });
    expect(readAvailableSystemMemoryMb()).toBeNull();
  });

  it("adds purgeable to free and ignores a malformed purgeable figure", () => {
    // macOS holds reclaimable pages as purgeable rather than free, so dropping
    // it would fire false positives on every healthy Mac.
    stub(() => ({ free: 512 * 1024, purgeable: 256 * 1024, total: 8 * 1024 * 1024 }));
    // totalMb comes from os.totalmem(), not the stubbed struct, so only the
    // derived components are assertable here.
    const snapshot = readSystemMemorySnapshot();
    expect(snapshot).toMatchObject({ freeMb: 512, purgeableMb: 256, availableMb: 768 });
    expect(readAvailableSystemMemoryMb()).toBe(768);

    stub(() => ({ free: 512 * 1024, purgeable: Number.NaN, total: 8 * 1024 * 1024 }));
    expect(readAvailableSystemMemoryMb()).toBe(512);
  });
});
