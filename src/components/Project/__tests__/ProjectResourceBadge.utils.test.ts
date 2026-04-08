import { describe, it, expect } from "vitest";

// Re-implement the pure utility functions for testing since they're not exported
// These mirror the functions in ProjectResourceBadge.tsx exactly

type MemoryState = "normal" | "elevated" | "critical";
type TrendDirection = "up" | "down" | "stable";

const MEMORY_THRESHOLD_ELEVATED = 500;
const MEMORY_THRESHOLD_CRITICAL = 800;
const TREND_DEADBAND_MB_PER_MIN = 3;

function getMemoryState(totalMB: number): MemoryState {
  if (totalMB >= MEMORY_THRESHOLD_CRITICAL) return "critical";
  if (totalMB >= MEMORY_THRESHOLD_ELEVATED) return "elevated";
  return "normal";
}

function computeSlope(samples: number[]): number {
  const n = samples.length;
  if (n < 3) return 0;
  const sumX = (n * (n - 1)) / 2;
  const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
  const sumY = samples.reduce((a, b) => a + b, 0);
  const sumXY = samples.reduce((acc, y, i) => acc + i * y, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

function getTrendDirection(samples: number[]): TrendDirection {
  const slopePerSample = computeSlope(samples);
  const slopePerMin = slopePerSample * 6;
  if (Math.abs(slopePerMin) < TREND_DEADBAND_MB_PER_MIN) return "stable";
  return slopePerMin > 0 ? "up" : "down";
}

function formatMemory(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}GB`;
  return `${mb}MB`;
}

describe("getMemoryState", () => {
  it("returns normal below 500MB", () => {
    expect(getMemoryState(0)).toBe("normal");
    expect(getMemoryState(499)).toBe("normal");
  });

  it("returns elevated at 500-799MB", () => {
    expect(getMemoryState(500)).toBe("elevated");
    expect(getMemoryState(799)).toBe("elevated");
  });

  it("returns critical at 800MB+", () => {
    expect(getMemoryState(800)).toBe("critical");
    expect(getMemoryState(2000)).toBe("critical");
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
  it("returns stable with fewer than 3 samples", () => {
    expect(getTrendDirection([])).toBe("stable");
    expect(getTrendDirection([100, 200])).toBe("stable");
  });

  it("returns stable when slope is within deadband", () => {
    // slope < 0.5 MB/sample → < 3 MB/min → within deadband
    expect(getTrendDirection([100, 100.1, 100.2, 100.3])).toBe("stable");
  });

  it("returns up when memory is growing fast", () => {
    // slope = 10 MB/sample → 60 MB/min → well above deadband
    expect(getTrendDirection([100, 110, 120, 130])).toBe("up");
  });

  it("returns down when memory is decreasing fast", () => {
    expect(getTrendDirection([130, 120, 110, 100])).toBe("down");
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
