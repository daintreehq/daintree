import { describe, it, expect } from "vitest";
import { formatElapsedDuration } from "../formatElapsedDuration";

describe("formatElapsedDuration", () => {
  it("returns '0s' for zero", () => {
    expect(formatElapsedDuration(0)).toBe("0s");
  });

  it("returns '0s' for negative values", () => {
    expect(formatElapsedDuration(-5000)).toBe("0s");
  });

  it("returns '0s' for non-finite values", () => {
    expect(formatElapsedDuration(NaN)).toBe("0s");
    expect(formatElapsedDuration(Infinity)).toBe("0s");
    expect(formatElapsedDuration(-Infinity)).toBe("0s");
  });

  it("returns seconds for sub-minute durations", () => {
    expect(formatElapsedDuration(1000)).toBe("1s");
    expect(formatElapsedDuration(45_000)).toBe("45s");
    expect(formatElapsedDuration(59_999)).toBe("59s");
  });

  it("returns minutes without seconds once >= 1 minute", () => {
    expect(formatElapsedDuration(60_000)).toBe("1m");
    expect(formatElapsedDuration(5 * 60_000)).toBe("5m");
    expect(formatElapsedDuration(5 * 60_000 + 30_000)).toBe("5m");
    expect(formatElapsedDuration(59 * 60_000 + 59_000)).toBe("59m");
  });

  it("returns hours and minutes for >= 1 hour", () => {
    expect(formatElapsedDuration(3600_000)).toBe("1h 0m");
    expect(formatElapsedDuration(2 * 3600_000 + 14 * 60_000)).toBe("2h 14m");
    expect(formatElapsedDuration(23 * 3600_000 + 59 * 60_000)).toBe("23h 59m");
  });

  it("returns days and hours for >= 1 day", () => {
    expect(formatElapsedDuration(86_400_000)).toBe("1d 0h");
    expect(formatElapsedDuration(2 * 86_400_000 + 5 * 3600_000)).toBe("2d 5h");
    expect(formatElapsedDuration(7 * 86_400_000 + 12 * 3600_000)).toBe("7d 12h");
  });

  describe("subSecond", () => {
    const precise = (ms: number) => formatElapsedDuration(ms, { subSecond: true });

    it("keeps one decimal under 10ms and whole milliseconds under a second", () => {
      expect(precise(0)).toBe("0.0ms");
      expect(precise(3.24)).toBe("3.2ms");
      expect(precise(9.94)).toBe("9.9ms");
      expect(precise(812.4)).toBe("812ms");
      expect(precise(999.4)).toBe("999ms");
    });

    it("switches to tenths of a second before rounding would print 1000ms", () => {
      expect(precise(999.6)).toBe("1.0s");
      expect(precise(1540)).toBe("1.5s");
      expect(precise(9.96)).toBe("10ms");
      expect(precise(59_940)).toBe("59.9s");
      expect(precise(59_960)).toBe("59s");
    });

    it("matches the default output from a minute up and for invalid input", () => {
      expect(precise(60_000)).toBe("1m");
      expect(precise(2 * 3600_000 + 14 * 60_000)).toBe("2h 14m");
      expect(precise(-5)).toBe("0s");
      expect(precise(NaN)).toBe("0s");
    });
  });
});
