import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXTERNAL_PRESSURE_MAX_OWN_MEMORY_RATIO,
  isMemoryPressureExternal,
  WATCHDOG_PRESSURE_STALE_MS,
} from "../watchdogMemoryPressure.js";
import { recordSwapPressure } from "../systemSwapPressure.js";

const TOTAL_MB = 36 * 1024;
const NOW = 1_000_000;

describe("isMemoryPressureExternal (#14367)", () => {
  afterEach(() => recordSwapPressure(false));

  const own =
    (ownMb: number, sampledAt = NOW) =>
    () => ({ ownMb, sampledAt });

  it("is true under confirmed pressure while Daintree holds a small share", () => {
    recordSwapPressure(true, NOW);
    expect(isMemoryPressureExternal(own(512), TOTAL_MB, NOW)).toBe(true);
  });

  it("is false when Daintree's own footprint could account for the pressure", () => {
    recordSwapPressure(true, NOW);
    const atLimit = TOTAL_MB * EXTERNAL_PRESSURE_MAX_OWN_MEMORY_RATIO;
    expect(isMemoryPressureExternal(own(atLimit), TOTAL_MB, NOW)).toBe(false);
    expect(isMemoryPressureExternal(own(atLimit - 1), TOTAL_MB, NOW)).toBe(true);
  });

  it("never reads the footprint without confirmed pressure", () => {
    const read = vi.fn(own(512));
    expect(isMemoryPressureExternal(read, TOTAL_MB, NOW)).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it("is false with no trusted figure, a stale or future-dated one, or no total", () => {
    recordSwapPressure(true, NOW);
    expect(isMemoryPressureExternal(() => null, TOTAL_MB, NOW)).toBe(false);
    expect(
      isMemoryPressureExternal(own(512, NOW - WATCHDOG_PRESSURE_STALE_MS - 1), TOTAL_MB, NOW)
    ).toBe(false);
    expect(isMemoryPressureExternal(own(512, NOW + 1), TOTAL_MB, NOW)).toBe(false);
    expect(isMemoryPressureExternal(own(Number.NaN), TOTAL_MB, NOW)).toBe(false);
    expect(isMemoryPressureExternal(own(512), 0, NOW)).toBe(false);
  });
});
