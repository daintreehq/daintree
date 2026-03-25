// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  evaluatePanelLimit,
  shouldShowSoftWarning,
  dismissSoftWarning,
  DEFAULT_SOFT_WARNING_LIMIT,
  DEFAULT_CONFIRMATION_LIMIT,
  DEFAULT_HARD_LIMIT,
} from "../panelLimitStore";

const DEFAULT_LIMITS = {
  softWarningLimit: DEFAULT_SOFT_WARNING_LIMIT,
  confirmationLimit: DEFAULT_CONFIRMATION_LIMIT,
  hardLimit: DEFAULT_HARD_LIMIT,
};

describe("evaluatePanelLimit", () => {
  it("returns 'ok' when count is below soft limit", () => {
    expect(evaluatePanelLimit(0, DEFAULT_LIMITS)).toBe("ok");
    expect(evaluatePanelLimit(11, DEFAULT_LIMITS)).toBe("ok");
  });

  it("returns 'soft' when count is at or above soft limit but below confirmation", () => {
    expect(evaluatePanelLimit(12, DEFAULT_LIMITS)).toBe("soft");
    expect(evaluatePanelLimit(19, DEFAULT_LIMITS)).toBe("soft");
  });

  it("returns 'confirm' when count is at or above confirmation but below hard limit", () => {
    expect(evaluatePanelLimit(20, DEFAULT_LIMITS)).toBe("confirm");
    expect(evaluatePanelLimit(31, DEFAULT_LIMITS)).toBe("confirm");
  });

  it("returns 'hard' when count is at or above hard limit", () => {
    expect(evaluatePanelLimit(32, DEFAULT_LIMITS)).toBe("hard");
    expect(evaluatePanelLimit(100, DEFAULT_LIMITS)).toBe("hard");
  });

  it("works with custom limits", () => {
    const custom = { softWarningLimit: 5, confirmationLimit: 10, hardLimit: 15 };
    expect(evaluatePanelLimit(4, custom)).toBe("ok");
    expect(evaluatePanelLimit(5, custom)).toBe("soft");
    expect(evaluatePanelLimit(10, custom)).toBe("confirm");
    expect(evaluatePanelLimit(15, custom)).toBe("hard");
  });
});

describe("shouldShowSoftWarning", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("returns false when count is below soft limit", () => {
    expect(shouldShowSoftWarning(10, 12)).toBe(false);
  });

  it("returns true when count is at soft limit and no dismiss", () => {
    expect(shouldShowSoftWarning(12, 12)).toBe(true);
  });

  it("returns false after dismiss until next step threshold", () => {
    dismissSoftWarning(12);
    expect(shouldShowSoftWarning(12, 12)).toBe(false);
    expect(shouldShowSoftWarning(14, 12)).toBe(false);
    expect(shouldShowSoftWarning(15, 12)).toBe(false);
  });

  it("returns true at next step threshold after dismiss", () => {
    dismissSoftWarning(12);
    expect(shouldShowSoftWarning(16, 12)).toBe(true);
  });

  it("supports multiple dismiss cycles", () => {
    dismissSoftWarning(12);
    expect(shouldShowSoftWarning(16, 12)).toBe(true);
    dismissSoftWarning(16);
    expect(shouldShowSoftWarning(16, 12)).toBe(false);
    expect(shouldShowSoftWarning(19, 12)).toBe(false);
    expect(shouldShowSoftWarning(20, 12)).toBe(true);
  });
});
