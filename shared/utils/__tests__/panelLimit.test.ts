import { describe, it, expect } from "vitest";
import { getPanelLimitOrderingIssues } from "../panelLimit.js";

const limits = (softWarningLimit: number, confirmationLimit: number, hardLimit: number) => ({
  softWarningLimit,
  confirmationLimit,
  hardLimit,
});

describe("getPanelLimitOrderingIssues", () => {
  it("reports nothing while both thresholds sit below the hard limit", () => {
    expect(getPanelLimitOrderingIssues(limits(12, 20, 32))).toEqual({
      softAtOrAboveHard: false,
      confirmationAtOrAboveHard: false,
    });
    expect(getPanelLimitOrderingIssues(limits(31, 31, 32))).toEqual({
      softAtOrAboveHard: false,
      confirmationAtOrAboveHard: false,
    });
  });

  it("flags a soft warning at or above the hard limit on its own", () => {
    expect(getPanelLimitOrderingIssues(limits(32, 20, 32)).softAtOrAboveHard).toBe(true);
    expect(getPanelLimitOrderingIssues(limits(40, 20, 32))).toEqual({
      softAtOrAboveHard: true,
      confirmationAtOrAboveHard: false,
    });
  });

  it("flags a confirmation at or above the hard limit on its own", () => {
    expect(getPanelLimitOrderingIssues(limits(12, 32, 32)).confirmationAtOrAboveHard).toBe(true);
    expect(getPanelLimitOrderingIssues(limits(12, 60, 32))).toEqual({
      softAtOrAboveHard: false,
      confirmationAtOrAboveHard: true,
    });
  });

  it("flags both when both are too high", () => {
    expect(getPanelLimitOrderingIssues(limits(50, 60, 32))).toEqual({
      softAtOrAboveHard: true,
      confirmationAtOrAboveHard: true,
    });
  });

  it("does not hold a soft warning above the confirmation to be misplaced", () => {
    expect(getPanelLimitOrderingIssues(limits(25, 20, 32))).toEqual({
      softAtOrAboveHard: false,
      confirmationAtOrAboveHard: false,
    });
  });
});
