import { describe, expect, it } from "vitest";
import { getSystemMemoryThresholds } from "../systemMemory.js";

describe("systemMemory thresholds", () => {
  it("preserves proportional thresholds on an 8 GB machine", () => {
    expect(getSystemMemoryThresholds(8 * 1024)).toEqual({
      criticalMb: 8 * 1024 * 0.1,
      warningMb: 8 * 1024 * 0.2,
    });
  });

  it("caps thresholds on high-memory machines", () => {
    expect(getSystemMemoryThresholds(64 * 1024)).toEqual({
      criticalMb: 1024,
      warningMb: 2048,
    });
  });
});
