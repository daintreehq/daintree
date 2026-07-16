import { describe, it, expect } from "vitest";
import {
  computeThresholds,
  getMemoryState,
  computeSlope,
  getTrendDirection,
  formatMemory,
  formatProcessLabel,
  FALLBACK_THRESHOLDS,
} from "../ProjectResourceBadge.utils";

const GB = 1024 * 1024 * 1024;

describe("computeThresholds", () => {
  it("scales thresholds as fractions of total RAM", () => {
    // 8 GB → 20% elevated, 33% critical, expressed in MB.
    const t = computeThresholds(8 * GB);
    expect(t.elevated).toBe(Math.round(8 * 1024 * 0.2));
    expect(t.critical).toBe(Math.round(8 * 1024 * 0.33));
  });

  it("scales up on larger machines so the same MB isn't 'critical' everywhere", () => {
    const small = computeThresholds(8 * GB);
    const large = computeThresholds(64 * GB);
    expect(large.elevated).toBeGreaterThan(small.elevated);
    expect(large.critical).toBeGreaterThan(small.critical);
    // critical must always sit above elevated.
    expect(large.critical).toBeGreaterThan(large.elevated);
    expect(small.critical).toBeGreaterThan(small.elevated);
  });

  it("falls back to fixed MB when total RAM is unknown or invalid", () => {
    expect(computeThresholds(0)).toEqual(FALLBACK_THRESHOLDS);
    expect(computeThresholds(-1)).toEqual(FALLBACK_THRESHOLDS);
    expect(computeThresholds(Number.NaN)).toEqual(FALLBACK_THRESHOLDS);
  });
});

describe("getMemoryState", () => {
  const thresholds = { elevated: 1600, critical: 2700 };

  it("returns normal below the elevated threshold", () => {
    expect(getMemoryState(0, thresholds)).toBe("normal");
    expect(getMemoryState(thresholds.elevated - 1, thresholds)).toBe("normal");
  });

  it("returns elevated between elevated and critical", () => {
    expect(getMemoryState(thresholds.elevated, thresholds)).toBe("elevated");
    expect(getMemoryState(thresholds.critical - 1, thresholds)).toBe("elevated");
  });

  it("returns critical at or above the critical threshold", () => {
    expect(getMemoryState(thresholds.critical, thresholds)).toBe("critical");
    expect(getMemoryState(thresholds.critical * 2, thresholds)).toBe("critical");
  });

  it("tracks the supplied thresholds, not fixed values", () => {
    // 800 MB is critical on the old fixed scale but normal on a big machine.
    const big = computeThresholds(64 * GB);
    expect(getMemoryState(800, big)).toBe("normal");
  });
});

describe("computeSlope", () => {
  it("returns 0 for fewer than 3 samples", () => {
    expect(computeSlope([])).toBe(0);
    expect(computeSlope([100])).toBe(0);
    expect(computeSlope([100, 200])).toBe(0);
  });

  it("computes positive slope for increasing samples", () => {
    expect(computeSlope([100, 110, 120, 130])).toBeCloseTo(10, 5);
  });

  it("computes negative slope for decreasing samples", () => {
    expect(computeSlope([130, 120, 110, 100])).toBeCloseTo(-10, 5);
  });

  it("returns 0 for flat samples", () => {
    expect(computeSlope([100, 100, 100, 100])).toBeCloseTo(0, 5);
  });
});

describe("getTrendDirection", () => {
  const SAMPLES_PER_MIN = 6;

  it("returns stable with fewer than 3 samples", () => {
    expect(getTrendDirection([], SAMPLES_PER_MIN)).toBe("stable");
    expect(getTrendDirection([100, 200], SAMPLES_PER_MIN)).toBe("stable");
  });

  it("returns stable when the per-minute slope is within the deadband", () => {
    // slope ≈ 0.1 MB/sample → 0.6 MB/min → within the 3 MB/min deadband
    expect(getTrendDirection([100, 100.1, 100.2, 100.3], SAMPLES_PER_MIN)).toBe("stable");
  });

  it("returns up when memory is growing past the deadband", () => {
    expect(getTrendDirection([100, 110, 120, 130], SAMPLES_PER_MIN)).toBe("up");
  });

  it("returns down when memory is decreasing past the deadband", () => {
    expect(getTrendDirection([130, 120, 110, 100], SAMPLES_PER_MIN)).toBe("down");
  });

  it("scales the slope by the sample cadence", () => {
    // Same samples, faster cadence crosses the deadband sooner.
    const samples = [100, 100.3, 100.6, 100.9];
    expect(getTrendDirection(samples, 1)).toBe("stable");
    expect(getTrendDirection(samples, 60)).toBe("up");
  });
});

describe("formatMemory", () => {
  it("formats as MB below 1024", () => {
    expect(formatMemory(512)).toBe("512MB");
    expect(formatMemory(0)).toBe("0MB");
    expect(formatMemory(1023)).toBe("1023MB");
  });

  it("formats as GB at 1024+", () => {
    expect(formatMemory(1024)).toBe("1.0GB");
    expect(formatMemory(1536)).toBe("1.5GB");
    expect(formatMemory(2048)).toBe("2.0GB");
  });
});

describe("formatProcessLabel", () => {
  it("falls back to the process name when no project owns the process", () => {
    expect(formatProcessLabel({ name: "GPU Process" })).toBe("GPU Process");
    expect(formatProcessLabel({ name: "Tab", projectNames: [] })).toBe("Tab");
  });

  it("names the owning project instead of the generic process name", () => {
    const label = formatProcessLabel({ name: "Tab", projectNames: ["RuinWeave"] });
    expect(label).toBe("RuinWeave view");
    expect(label).not.toContain("Tab");
  });

  it("reports every project sharing a consolidated renderer, counted first", () => {
    const label = formatProcessLabel({
      name: "Tab",
      projectNames: ["Cedar Forge", "RuinWeave"],
    });
    expect(label).toBe("2 views · Cedar Forge, RuinWeave");
    // The count leads so it survives the row's ~23-char truncation.
    expect(label.slice(0, 23)).toContain("2 views");
  });

  it("counts each additional project sharing the renderer", () => {
    const names = ["Alpha", "Cedar Forge", "RuinWeave"];
    expect(formatProcessLabel({ name: "Tab", projectNames: names })).toBe(
      `${names.length} views · ${names.join(", ")}`
    );
  });

  it("keeps the label free of trailing punctuation", () => {
    for (const projectNames of [undefined, ["RuinWeave"], ["Cedar Forge", "RuinWeave"]]) {
      expect(formatProcessLabel({ name: "Tab", projectNames })).not.toMatch(/\.$/);
    }
  });
});
