// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  evaluatePanelLimit,
  shouldShowSoftWarning,
  computeHardwareDefaults,
  preflightSpawnBatchLimit,
  usePanelLimitStore,
  DEFAULT_SOFT_WARNING_LIMIT,
  DEFAULT_CONFIRMATION_LIMIT,
  DEFAULT_HARD_LIMIT,
} from "../panelLimitStore";
import { _resetPersistedStoreRegistryForTests } from "../persistence/persistedStoreRegistry";
import { countPanelLimitUsage } from "../slices/panelRegistry/panelCount";
import {
  getPanelSlotReservations,
  resetPanelSlotReservations,
} from "../slices/panelRegistry/panelSlotReservations";
import { MCP_CONFIRM_HOLD_GRACE_MS } from "@shared/config/mcpConfirmWindow";

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

describe("preflightSpawnBatchLimit", () => {
  // Single-panel adds dropped the blocking confirm (#10547). Batch spawns keep
  // it because adding many panels at once is not trivially reversible — these
  // tests guard that the batch gate survives.
  const originalRequestConfirmation = usePanelLimitStore.getState().requestConfirmation;

  /** Run the gate and hand its slots straight back: these cases read the decision. */
  async function decide(currentCount: number, requestedCount: number) {
    const { grant, ...decision } = await preflightSpawnBatchLimit(
      () => currentCount,
      requestedCount
    );
    expect(grant?.allowed ?? 0).toBe(decision.allowed);
    grant?.release();
    return decision;
  }

  afterEach(() => {
    resetPanelSlotReservations();
    usePanelLimitStore.setState({
      softWarningLimit: DEFAULT_SOFT_WARNING_LIMIT,
      confirmationLimit: DEFAULT_CONFIRMATION_LIMIT,
      hardLimit: DEFAULT_HARD_LIMIT,
      warningsDisabled: false,
      requestConfirmation: originalRequestConfirmation,
    });
  });

  it("returns 0 allowed when no requested panels", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    usePanelLimitStore.setState({ requestConfirmation: confirm });
    expect(await decide(0, 0)).toEqual({ allowed: 0, declined: false });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("does not confirm when the projected total stays at or below the confirm limit", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    usePanelLimitStore.setState({
      confirmationLimit: 20,
      hardLimit: 32,
      warningsDisabled: false,
      requestConfirmation: confirm,
    });
    // 10 + 5 = 15, below the 20 confirm threshold.
    expect(await decide(10, 5)).toEqual({ allowed: 5, declined: false });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("confirms and allows the full batch when the user accepts crossing the confirm limit", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    usePanelLimitStore.setState({
      confirmationLimit: 20,
      hardLimit: 32,
      warningsDisabled: false,
      requestConfirmation: confirm,
    });
    // 18 + 5 = 23, crosses the 20 confirm threshold.
    expect(await decide(18, 5)).toEqual({ allowed: 5, declined: false });
    expect(confirm).toHaveBeenCalledWith({
      currentCount: 18,
      requestedCount: 5,
      allowedCount: 5,
      confirmationLimit: 20,
      hardLimit: 32,
    });
  });

  it("allows nothing when the user declines the confirm", async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    usePanelLimitStore.setState({
      confirmationLimit: 20,
      hardLimit: 32,
      warningsDisabled: false,
      requestConfirmation: confirm,
    });
    // A decline is the user's answer, not the limit refusing — callers report it differently.
    expect(await decide(18, 5)).toEqual({ allowed: 0, declined: true });
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("skips the confirm entirely when warnings are disabled", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    usePanelLimitStore.setState({
      confirmationLimit: 20,
      hardLimit: 32,
      warningsDisabled: true,
      requestConfirmation: confirm,
    });
    expect(await decide(18, 5)).toEqual({ allowed: 5, declined: false });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("clamps the allowed count to the hard ceiling", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    usePanelLimitStore.setState({
      confirmationLimit: 20,
      hardLimit: 32,
      warningsDisabled: false,
      requestConfirmation: confirm,
    });
    // 30 open, 10 requested, only 2 slots before the hard limit of 32.
    expect(await decide(30, 10)).toEqual({ allowed: 2, declined: false });
    // The confirm is told the batch was trimmed, so it can say so.
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ currentCount: 30, requestedCount: 10, allowedCount: 2 })
    );
  });

  it("does not confirm when the projected total lands exactly on the confirm limit", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    usePanelLimitStore.setState({
      confirmationLimit: 20,
      hardLimit: 32,
      warningsDisabled: false,
      requestConfirmation: confirm,
    });
    // 18 + 2 = 20 == confirmationLimit; the gate is strictly `> confirmationLimit`.
    expect(await decide(18, 2)).toEqual({ allowed: 2, declined: false });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("allows nothing without confirming once the hard limit is already reached", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    usePanelLimitStore.setState({
      confirmationLimit: 20,
      hardLimit: 32,
      warningsDisabled: false,
      requestConfirmation: confirm,
    });
    // Already at the hard limit: no slots, short-circuits before any confirm.
    expect(await decide(32, 4)).toEqual({ allowed: 0, declined: false });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("reserves what it grants before returning, so an overlapping gate can't have it too (#15607)", async () => {
    usePanelLimitStore.setState({ confirmationLimit: 20, hardLimit: 12, warningsDisabled: false });
    // Nine panels open; the live count adds whatever is reserved.
    const readUsage = () => 9 + countPanelLimitUsage({ panelsById: {}, panelIds: [] });

    const first = preflightSpawnBatchLimit(readUsage, 3);
    const second = preflightSpawnBatchLimit(readUsage, 3);
    const [granted, refused] = await Promise.all([first, second]);

    expect(granted.allowed).toBe(3);
    expect(refused).toEqual({ allowed: 0, declined: false, grant: null });

    granted.grant?.release();
    const afterRelease = await preflightSpawnBatchLimit(readUsage, 3);
    expect(afterRelease.allowed).toBe(3);
    afterRelease.grant?.release();
  });

  it("holds nothing while the confirm is open, then keeps only what is still free", async () => {
    let answer!: (confirmed: boolean) => void;
    const confirm = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        })
    );
    usePanelLimitStore.setState({
      confirmationLimit: 20,
      hardLimit: 24,
      warningsDisabled: false,
      requestConfirmation: confirm,
    });
    let open = 18;
    const pending = preflightSpawnBatchLimit(() => open, 4);

    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ allowedCount: 4 }));
    expect(getPanelSlotReservations().unclaimed).toBe(0);
    // Another add takes four slots while the user reads the dialog.
    open = 22;
    answer(true);

    const result = await pending;
    expect(result.allowed).toBe(2);
    expect(getPanelSlotReservations().unclaimed).toBe(2);
    result.grant?.release();
    expect(getPanelSlotReservations().unclaimed).toBe(0);
  });

  it("grants against a hard limit lowered while the confirm was open", async () => {
    usePanelLimitStore.setState({
      confirmationLimit: 20,
      hardLimit: 24,
      warningsDisabled: false,
      requestConfirmation: vi.fn(async () => {
        usePanelLimitStore.setState({ hardLimit: 20 });
        return true;
      }),
    });

    const result = await preflightSpawnBatchLimit(() => 18, 4);

    expect(result.allowed).toBe(2);
    expect(getPanelSlotReservations().unclaimed).toBe(2);
    result.grant?.release();
  });

  it("never grants more than the confirm offered, even when room opens up", async () => {
    let open = 22;
    const confirm = vi.fn(async () => {
      open = 10;
      return true;
    });
    usePanelLimitStore.setState({
      confirmationLimit: 20,
      hardLimit: 24,
      warningsDisabled: false,
      requestConfirmation: confirm,
    });

    // Trimmed to 2 when asked; the user agreed to 2, not to the 5 requested.
    const result = await preflightSpawnBatchLimit(() => open, 5);

    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ allowedCount: 2 }));
    expect(result.allowed).toBe(2);
    result.grant?.release();
  });

  it("opens nothing when the confirm is accepted after the last slot went", async () => {
    let open = 18;
    usePanelLimitStore.setState({
      confirmationLimit: 20,
      hardLimit: 24,
      warningsDisabled: false,
      requestConfirmation: vi.fn(async () => {
        open = 24;
        return true;
      }),
    });

    expect(await preflightSpawnBatchLimit(() => open, 4)).toEqual({
      allowed: 0,
      declined: false,
      grant: null,
    });
    expect(getPanelSlotReservations().unclaimed).toBe(0);
  });
});

describe("preflightSpawnBatchLimit behind a dispatch deadline (#15648)", () => {
  const pending = () => usePanelLimitStore.getState().pendingConfirm;

  beforeEach(() => {
    vi.useFakeTimers();
    usePanelLimitStore.setState({ confirmationLimit: 20, hardLimit: 32, warningsDisabled: false });
  });

  afterEach(() => {
    usePanelLimitStore.getState().resolveConfirmation(false);
    resetPanelSlotReservations();
    usePanelLimitStore.setState({ ...DEFAULT_LIMITS, warningsDisabled: false });
    vi.useRealTimers();
  });

  it("takes its dialog down a grace period before the deadline, holding nothing", async () => {
    const deadlineAt = Date.now() + 30_000;
    const result = preflightSpawnBatchLimit(() => 18, 3, { deadlineAt });
    expect(pending()?.request).toMatchObject({ currentCount: 18, allowedCount: 3 });

    await vi.advanceTimersByTimeAsync(30_000 - MCP_CONFIRM_HOLD_GRACE_MS - 1);
    expect(pending()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);

    expect(await result).toEqual({ allowed: 0, declined: false, expired: true, grant: null });
    expect(pending()).toBeNull();
    expect(getPanelSlotReservations().unclaimed).toBe(0);
  });

  it("counts a yes that lands after the close as expired, even before its timer fires", async () => {
    const deadlineAt = Date.now() + 30_000;
    const result = preflightSpawnBatchLimit(() => 18, 3, { deadlineAt });

    // A background view's timer can run late; the click gets in first.
    vi.setSystemTime(deadlineAt - MCP_CONFIRM_HOLD_GRACE_MS);
    usePanelLimitStore.getState().resolveConfirmation(true);

    expect(await result).toMatchObject({ allowed: 0, expired: true, grant: null });
    expect(getPanelSlotReservations().unclaimed).toBe(0);
  });

  it("asks nobody when there is no time left to answer", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    usePanelLimitStore.setState({ requestConfirmation: confirm });
    try {
      const result = await preflightSpawnBatchLimit(() => 18, 3, {
        deadlineAt: Date.now() + MCP_CONFIRM_HOLD_GRACE_MS,
      });

      expect(result).toMatchObject({ allowed: 0, expired: true });
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      usePanelLimitStore.setState({
        requestConfirmation: usePanelLimitStore.getInitialState().requestConfirmation,
      });
    }
  });

  it("grants as before when the person answers in time", async () => {
    const result = preflightSpawnBatchLimit(() => 18, 3, { deadlineAt: Date.now() + 30_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    usePanelLimitStore.getState().resolveConfirmation(true);

    const decision = await result;
    expect(decision).toMatchObject({ allowed: 3, declined: false });
    expect(decision).not.toHaveProperty("expired");
    expect(getPanelSlotReservations().unclaimed).toBe(3);
    decision.grant?.release();
    // The close timer went with the answer: nothing fires into the next request.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a no inside the window as the person's decline", async () => {
    const result = preflightSpawnBatchLimit(() => 18, 3, { deadlineAt: Date.now() + 30_000 });
    usePanelLimitStore.getState().resolveConfirmation(false);

    expect(await result).toEqual({ allowed: 0, declined: true, grant: null });
  });

  it("withdraws only the request it names, never a newer one on screen", async () => {
    const { requestConfirmation, withdrawConfirmation } = usePanelLimitStore.getState();
    const base = { currentCount: 18, requestedCount: 3, allowedCount: 3 };
    const limits = { confirmationLimit: 20, hardLimit: 32 };
    const first = { ...base, ...limits };
    const second = { ...base, ...limits };
    const firstAnswer = requestConfirmation(first);
    const secondAnswer = requestConfirmation(second);
    expect(await firstAnswer).toBe(false);

    withdrawConfirmation(first);
    expect(pending()?.request).toBe(second);

    withdrawConfirmation(second);
    expect(pending()).toBeNull();
    expect(await secondAnswer).toBe(false);
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

  describe("requestSeq (ErrorBoundary reset signal, #9918)", () => {
    const REQUEST = {
      currentCount: 18,
      requestedCount: 4,
      allowedCount: 4,
      confirmationLimit: 20,
      hardLimit: 32,
    };

    it("strictly increases on each request, including back-to-back supersede", async () => {
      const store = await loadStore();
      const before = store.getState().requestSeq;

      store.getState().requestConfirmation(REQUEST);
      const afterFirst = store.getState().requestSeq;
      expect(afterFirst).toBeGreaterThan(before);

      store.getState().requestConfirmation({ ...REQUEST, currentCount: 19 });
      const afterSecond = store.getState().requestSeq;
      expect(afterSecond).toBeGreaterThan(afterFirst);

      store.getState().resolveConfirmation(false);
    });

    it("is transient runtime state — never persisted via partialize", async () => {
      const store = await loadStore();
      store.getState().requestConfirmation(REQUEST);
      expect(store.getState().requestSeq).toBeGreaterThan(0);

      const persisted = JSON.parse(storageMock.getItem(STORAGE_KEY) ?? "{}");
      expect(persisted.state).not.toHaveProperty("requestSeq");
      expect(persisted.state).not.toHaveProperty("pendingConfirm");

      store.getState().resolveConfirmation(false);
    });
  });
});

/**
 * Cross-view write-merge coverage for the shared localStorage partition
 * (issue #11351). The limit fields aren't project-scoped, but they're set from
 * multiple independent surfaces across views — and the store's transient setters
 * (`requestConfirmation` bumping `requestSeq`) trigger a persist write of the
 * unchanged limits, so a stale view would otherwise clobber a sibling's edit.
 */
describe("panelLimitStore cross-view write merge (#11351)", () => {
  const STORAGE_KEY = "daintree-panel-limits";
  const VERSION = 1;
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

  type PersistedBlob = { version: number; state: Record<string, unknown> };

  function installLocalStorage(initial: Record<string, string>): Map<string, string> {
    const backing = new Map<string, string>(Object.entries(initial));
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (key: string) => backing.get(key) ?? null,
        setItem: (key: string, value: string) => {
          backing.set(key, value);
        },
        removeItem: (key: string) => {
          backing.delete(key);
        },
      },
      configurable: true,
      writable: true,
    });
    return backing;
  }

  function restoreLocalStorage(): void {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, "localStorage", originalDescriptor);
      return;
    }
    delete (globalThis as Partial<typeof globalThis>).localStorage;
  }

  function readBlob(backing: Map<string, string>): PersistedBlob {
    const blob: PersistedBlob = JSON.parse(backing.get(STORAGE_KEY)!);
    return blob;
  }

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    restoreLocalStorage();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("a fresh view's limit change preserves a sibling's other limit fields", async () => {
    const backing = installLocalStorage({});
    const { usePanelLimitStore: store } = await import("../panelLimitStore");

    backing.set(
      STORAGE_KEY,
      JSON.stringify({ version: VERSION, state: { confirmationLimit: 25, warningsDisabled: true } })
    );

    store.getState().setSoftWarningLimit(15);

    const written = readBlob(backing);
    expect(written.state.softWarningLimit).toBe(15); // this view's change
    expect(written.state.confirmationLimit).toBe(25); // sibling's field survived
    expect(written.state.warningsDisabled).toBe(true); // sibling's field survived
  });

  it("independent threshold edits from two views both survive", async () => {
    const backing = installLocalStorage({});
    const { usePanelLimitStore: store } = await import("../panelLimitStore");

    store.getState().setSoftWarningLimit(15);

    const disk = readBlob(backing);
    disk.state.hardLimit = 50;
    backing.set(STORAGE_KEY, JSON.stringify(disk));

    store.getState().setConfirmationLimit(25);

    const written = readBlob(backing);
    expect(written.state.softWarningLimit).toBe(15);
    expect(written.state.confirmationLimit).toBe(25); // this view's change
    expect(written.state.hardLimit).toBe(50); // sibling's change survived
  });

  it("a transient confirmation-state write does not clobber a sibling's edited limit", async () => {
    const backing = installLocalStorage({});
    const { usePanelLimitStore: store } = await import("../panelLimitStore");

    // A sibling edits the hard limit on disk.
    backing.set(STORAGE_KEY, JSON.stringify({ version: VERSION, state: { hardLimit: 50 } }));

    // A transient, non-persisted state change (requestSeq/pendingConfirm) still
    // triggers a persist write of this stale view's unchanged limits.
    void store.getState().requestConfirmation({
      currentCount: 8,
      requestedCount: 2,
      allowedCount: 2,
      confirmationLimit: 8,
      hardLimit: 32,
    });

    const written = readBlob(backing);
    expect(written.state.hardLimit).toBe(50); // sibling's edit not clobbered

    store.getState().resolveConfirmation(false); // settle the pending promise
  });
});
