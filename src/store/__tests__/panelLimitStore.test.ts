import { describe, it, expect, beforeEach, vi } from "vitest";
import { evaluatePanelLimit, shouldShowSoftWarning, dismissSoftWarning } from "../panelLimitStore";

const DEFAULT_LIMITS = {
  softWarningLimit: 12,
  confirmationLimit: 20,
  hardLimit: 32,
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

describe("usePanelLimitStore", () => {
  it("requestConfirmation resolves when resolveConfirmation is called", async () => {
    const { usePanelLimitStore } = await import("../panelLimitStore");
    const store = usePanelLimitStore.getState();

    const confirmPromise = store.requestConfirmation(25, 512);
    expect(usePanelLimitStore.getState().pendingConfirm).not.toBeNull();

    usePanelLimitStore.getState().resolveConfirmation(true);
    const result = await confirmPromise;
    expect(result).toBe(true);
    expect(usePanelLimitStore.getState().pendingConfirm).toBeNull();
  });

  it("requestConfirmation resolves false when cancelled", async () => {
    const { usePanelLimitStore } = await import("../panelLimitStore");
    const store = usePanelLimitStore.getState();

    const confirmPromise = store.requestConfirmation(25, null);
    usePanelLimitStore.getState().resolveConfirmation(false);
    const result = await confirmPromise;
    expect(result).toBe(false);
  });

  it("second requestConfirmation rejects the first", async () => {
    const { usePanelLimitStore } = await import("../panelLimitStore");
    const store = usePanelLimitStore.getState();

    const first = store.requestConfirmation(20, null);
    const second = usePanelLimitStore.getState().requestConfirmation(25, 1024);

    // First should resolve false (auto-rejected)
    const firstResult = await first;
    expect(firstResult).toBe(false);

    // Second is still pending
    usePanelLimitStore.getState().resolveConfirmation(true);
    const secondResult = await second;
    expect(secondResult).toBe(true);
  });

  it("clamps limits to valid bounds", async () => {
    const { usePanelLimitStore } = await import("../panelLimitStore");

    usePanelLimitStore.getState().setHardLimit(200);
    expect(usePanelLimitStore.getState().hardLimit).toBe(100);

    usePanelLimitStore.getState().setHardLimit(1);
    expect(usePanelLimitStore.getState().hardLimit).toBe(4);
  });
});
