// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  evaluatePanelLimit,
  shouldShowSoftWarning,
  computeHardwareDefaults,
  DEFAULT_SOFT_WARNING_LIMIT,
  DEFAULT_CONFIRMATION_LIMIT,
  DEFAULT_HARD_LIMIT,
} from "../panelLimitStore";
import { _resetPersistedStoreRegistryForTests } from "../persistence/persistedStoreRegistry";

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
  it("returns false when count is below soft limit", () => {
    expect(shouldShowSoftWarning(10, 12, false, null)).toBe(false);
  });

  it("returns true when count is at soft limit and no dismiss", () => {
    expect(shouldShowSoftWarning(12, 12, false, null)).toBe(true);
  });

  it("returns false after dismiss until next step threshold", () => {
    expect(shouldShowSoftWarning(12, 12, false, 12)).toBe(false);
    expect(shouldShowSoftWarning(14, 12, false, 12)).toBe(false);
    expect(shouldShowSoftWarning(15, 12, false, 12)).toBe(false);
  });

  it("returns true at next step threshold after dismiss", () => {
    expect(shouldShowSoftWarning(16, 12, false, 12)).toBe(true);
  });

  it("supports multiple dismiss cycles", () => {
    expect(shouldShowSoftWarning(16, 12, false, 12)).toBe(true);
    expect(shouldShowSoftWarning(16, 12, false, 16)).toBe(false);
    expect(shouldShowSoftWarning(19, 12, false, 16)).toBe(false);
    expect(shouldShowSoftWarning(20, 12, false, 16)).toBe(true);
  });

  it("returns false when warnings are disabled", () => {
    expect(shouldShowSoftWarning(100, 12, true, null)).toBe(false);
    expect(shouldShowSoftWarning(50, 12, true, 12)).toBe(false);
  });
});

describe("computeHardwareDefaults", () => {
  const GB = 1024 * 1024 * 1024;

  it("returns conservative defaults for 8GB or less", () => {
    expect(computeHardwareDefaults(8 * GB)).toEqual({ soft: 8, confirm: 16, hard: 24 });
    expect(computeHardwareDefaults(4 * GB)).toEqual({ soft: 8, confirm: 16, hard: 24 });
    expect(computeHardwareDefaults(1 * GB)).toEqual({ soft: 8, confirm: 16, hard: 24 });
  });

  it("returns moderate defaults for 16GB", () => {
    expect(computeHardwareDefaults(16 * GB)).toEqual({ soft: 16, confirm: 30, hard: 48 });
    expect(computeHardwareDefaults(12 * GB)).toEqual({ soft: 16, confirm: 30, hard: 48 });
  });

  it("returns generous defaults for 32GB", () => {
    expect(computeHardwareDefaults(32 * GB)).toEqual({ soft: 24, confirm: 48, hard: 72 });
    expect(computeHardwareDefaults(24 * GB)).toEqual({ soft: 24, confirm: 48, hard: 72 });
  });

  it("returns maximum defaults for 64GB+", () => {
    expect(computeHardwareDefaults(64 * GB)).toEqual({ soft: 32, confirm: 64, hard: 100 });
    expect(computeHardwareDefaults(128 * GB)).toEqual({ soft: 32, confirm: 64, hard: 100 });
  });

  it("handles edge case of 0 bytes", () => {
    expect(computeHardwareDefaults(0)).toEqual({ soft: 8, confirm: 16, hard: 24 });
  });

  it("handles boundary values precisely", () => {
    // Just under 8GB -> still 8GB tier
    expect(computeHardwareDefaults(8 * GB - 1)).toEqual({ soft: 8, confirm: 16, hard: 24 });
    // Just over 8GB -> 16GB tier
    expect(computeHardwareDefaults(8 * GB + 1)).toEqual({ soft: 16, confirm: 30, hard: 48 });
    // Just over 16GB -> 32GB tier
    expect(computeHardwareDefaults(16 * GB + 1)).toEqual({ soft: 24, confirm: 48, hard: 72 });
    // Just over 32GB -> 64GB+ tier
    expect(computeHardwareDefaults(32 * GB + 1)).toEqual({ soft: 32, confirm: 64, hard: 100 });
  });
});

describe("panelLimitStore persist migration", () => {
  const STORAGE_KEY = "daintree-panel-limits";
  let storage: Record<string, string> = {};

  const storageMock = {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => {
      storage[key] = value;
    },
    removeItem: (key: string) => {
      delete storage[key];
    },
    clear: () => {
      storage = {};
    },
    get length() {
      return Object.keys(storage).length;
    },
    key: (index: number) => Object.keys(storage)[index] ?? null,
  };

  function installStorageMock() {
    Object.defineProperty(globalThis, "localStorage", {
      value: storageMock,
      configurable: true,
      writable: true,
    });
  }

  function setStoredState(state: Record<string, unknown>, version: number) {
    storageMock.setItem(STORAGE_KEY, JSON.stringify({ state, version }));
  }

  async function loadStore() {
    const mod = await import("../panelLimitStore");
    const store = mod.usePanelLimitStore;
    await vi.waitFor(() => {
      expect(store.getState().softWarningLimit).toBeDefined();
    });
    return store;
  }

  beforeEach(() => {
    vi.resetModules();
    storage = {};
    installStorageMock();
    _resetPersistedStoreRegistryForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds warningsDisabled, hardwareDefaultsApplied, lastSoftWarningDismissedAt during v0 migration", async () => {
    setStoredState(
      {
        softWarningLimit: 10,
        confirmationLimit: 18,
        hardLimit: 28,
      },
      0
    );
    const store = await loadStore();
    const state = store.getState();
    expect(state.softWarningLimit).toBe(10);
    expect(state.confirmationLimit).toBe(18);
    expect(state.hardLimit).toBe(28);
    expect(state.warningsDisabled).toBe(false);
    expect(state.hardwareDefaultsApplied).toBe(true);
    expect(state.lastSoftWarningDismissedAt).toBeNull();
  });

  it("leaves v1 state unchanged", async () => {
    setStoredState(
      {
        softWarningLimit: 20,
        confirmationLimit: 40,
        hardLimit: 60,
        warningsDisabled: true,
        hardwareDefaultsApplied: true,
        lastSoftWarningDismissedAt: 16,
      },
      1
    );
    const store = await loadStore();
    const state = store.getState();
    expect(state.softWarningLimit).toBe(20);
    expect(state.confirmationLimit).toBe(40);
    expect(state.hardLimit).toBe(60);
    expect(state.warningsDisabled).toBe(true);
    expect(state.hardwareDefaultsApplied).toBe(true);
    expect(state.lastSoftWarningDismissedAt).toBe(16);
  });

  it("uses defaults when storage is empty", async () => {
    const store = await loadStore();
    const state = store.getState();
    expect(state.softWarningLimit).toBe(DEFAULT_SOFT_WARNING_LIMIT);
    expect(state.confirmationLimit).toBe(DEFAULT_CONFIRMATION_LIMIT);
    expect(state.hardLimit).toBe(DEFAULT_HARD_LIMIT);
    expect(state.warningsDisabled).toBe(false);
    expect(state.hardwareDefaultsApplied).toBe(false);
    expect(state.lastSoftWarningDismissedAt).toBeNull();
  });
});
