import { describe, expect, it } from "vitest";
import { msUntilNextLabelChange } from "../GitHubStatsToolbarButton";

describe("msUntilNextLabelChange", () => {
  it("returns 0 when no time remains", () => {
    expect(msUntilNextLabelChange(0)).toBe(0);
    expect(msUntilNextLabelChange(-1)).toBe(0);
    expect(msUntilNextLabelChange(-1_000)).toBe(0);
  });

  it("aligns to the next whole-second boundary in the seconds range", () => {
    expect(msUntilNextLabelChange(1)).toBe(1);
    expect(msUntilNextLabelChange(500)).toBe(500);
    expect(msUntilNextLabelChange(999)).toBe(999);
    expect(msUntilNextLabelChange(1_000)).toBe(1_000);
    expect(msUntilNextLabelChange(1_001)).toBe(1);
    expect(msUntilNextLabelChange(59_999)).toBe(999);
  });

  it("aligns to the next whole-second boundary in the minutes range", () => {
    expect(msUntilNextLabelChange(60_000)).toBe(1_000);
    expect(msUntilNextLabelChange(60_001)).toBe(1);
    expect(msUntilNextLabelChange(120_500)).toBe(500);
    expect(msUntilNextLabelChange(3_599_000)).toBe(1_000);
    expect(msUntilNextLabelChange(3_599_999)).toBe(999);
  });

  it("aligns to the next minute-boundary crossing in the hours range", () => {
    // remainingMs=3_600_000 → totalSeconds=3600 → label "1h"
    // Next change is "1h" → "59m 59s" at remainingMs=3_599_000 (1s away)
    expect(msUntilNextLabelChange(3_600_000)).toBe(1_000);

    // remainingMs=3_660_000 → totalSeconds=3660 → label "1h 1m"
    // Next change is "1h 1m" → "1h" at remainingMs=3_659_000 (1s away)
    expect(msUntilNextLabelChange(3_660_000)).toBe(1_000);

    // remainingMs=3_659_000 → totalSeconds=3659 → label "1h"
    // Next change is "1h" → "59m 59s" at remainingMs=3_599_000 (60s away)
    expect(msUntilNextLabelChange(3_659_000)).toBe(60_000);

    // Mid-minute-window in hours range: from totalSeconds=3700 down to 3659
    expect(msUntilNextLabelChange(3_700_000)).toBe(41_000);

    // Two-hour mark behaves like the one-hour mark
    expect(msUntilNextLabelChange(7_200_000)).toBe(1_000);
    expect(msUntilNextLabelChange(7_199_000)).toBe(60_000);
  });

  it("never returns 0 for positive remaining time (no busy loop)", () => {
    const cases = [1, 500, 1_000, 60_000, 120_000, 3_599_000, 3_600_000, 3_660_000, 7_200_000];
    for (const remainingMs of cases) {
      expect(msUntilNextLabelChange(remainingMs)).toBeGreaterThan(0);
    }
  });
});
