import { afterEach, describe, expect, it } from "vitest";
import {
  KERNEL_CRITICAL_CLEAR_READINGS,
  KERNEL_PRESSURE_STALE_MS,
  getLastKernelPressureReadingAt,
  isKernelPressureCritical,
  recordKernelPressureLevel,
  resetKernelPressureForTesting,
} from "../systemKernelPressure.js";

afterEach(() => {
  resetKernelPressureForTesting();
});

describe("systemKernelPressure", () => {
  it("is not critical before any reading", () => {
    expect(isKernelPressureCritical(1_000)).toBe(false);
    expect(getLastKernelPressureReadingAt()).toBeNull();
  });

  it("latches critical on a single critical reading", () => {
    recordKernelPressureLevel(4, 1_000);
    expect(isKernelPressureCritical(1_000)).toBe(true);
  });

  it("holds critical until enough consecutive readings below it", () => {
    recordKernelPressureLevel(4, 1_000);
    for (let i = 1; i < KERNEL_CRITICAL_CLEAR_READINGS; i++) {
      recordKernelPressureLevel(i % 2 === 0 ? 1 : 2, 1_000 + i);
      expect(isKernelPressureCritical(1_000 + i)).toBe(true);
    }
    recordKernelPressureLevel(1, 2_000);
    expect(isKernelPressureCritical(2_000)).toBe(false);
  });

  it("restarts the clearing run when the level returns to critical", () => {
    recordKernelPressureLevel(4, 1_000);
    for (let i = 1; i < KERNEL_CRITICAL_CLEAR_READINGS; i++) {
      recordKernelPressureLevel(2, 1_000 + i);
    }
    recordKernelPressureLevel(4, 1_100);
    for (let i = 1; i < KERNEL_CRITICAL_CLEAR_READINGS; i++) {
      recordKernelPressureLevel(1, 1_100 + i);
    }
    expect(isKernelPressureCritical(1_200)).toBe(true);
  });

  it("ignores a failed reading", () => {
    recordKernelPressureLevel(4, 1_000);
    for (let i = 0; i < KERNEL_CRITICAL_CLEAR_READINGS + 1; i++) {
      recordKernelPressureLevel(null, 1_001 + i);
    }
    expect(isKernelPressureCritical(1_010)).toBe(true);
    expect(getLastKernelPressureReadingAt()).toBe(1_000);
  });

  it("never latches on warning or normal readings", () => {
    recordKernelPressureLevel(2, 1_000);
    recordKernelPressureLevel(1, 1_001);
    expect(isKernelPressureCritical(1_001)).toBe(false);
  });

  it("ages a verdict nobody has refreshed", () => {
    recordKernelPressureLevel(4, 1_000);
    expect(isKernelPressureCritical(1_000 + KERNEL_PRESSURE_STALE_MS)).toBe(true);
    expect(isKernelPressureCritical(1_001 + KERNEL_PRESSURE_STALE_MS)).toBe(false);
    // Aged out for good, not just for that read.
    expect(isKernelPressureCritical(1_000)).toBe(false);
  });

  it("treats a clock that stepped backwards as stale", () => {
    recordKernelPressureLevel(4, 10_000);
    expect(isKernelPressureCritical(9_000)).toBe(false);
  });
});
