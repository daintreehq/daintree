import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalScrollbackRestoreError } from "@shared/types/panel";

const { wakeMock, setScrollbackRestoreErrorMock, clearScrollbackRestoreErrorMock } = vi.hoisted(
  () => ({
    wakeMock: vi.fn(),
    setScrollbackRestoreErrorMock: vi.fn(),
    clearScrollbackRestoreErrorMock: vi.fn(),
  })
);

vi.mock("@/clients", () => ({
  terminalClient: {
    wake: wakeMock,
  },
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({
      setScrollbackRestoreError: setScrollbackRestoreErrorMock,
      clearScrollbackRestoreError: clearScrollbackRestoreErrorMock,
    }),
  },
}));

import { TerminalWakeManager, type WakeManagerDeps } from "../TerminalWakeManager";
import type { ManagedTerminal } from "../types";

type MockManagedTerminal = Pick<ManagedTerminal, "terminal" | "isAltBuffer"> & {
  isOpened?: boolean;
  isAttaching?: boolean;
  isHibernated?: boolean;
  lastScrollbackRestoreError?: TerminalScrollbackRestoreError;
};

describe("TerminalWakeManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setScrollbackRestoreErrorMock.mockReset();
    clearScrollbackRestoreErrorMock.mockReset();
  });

  it("returns false when wake request fails instead of rejecting", async () => {
    wakeMock.mockRejectedValueOnce(new Error("wake failed"));
    const managed: MockManagedTerminal = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
    };
    const deps: WakeManagerDeps = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
      hasInstance: vi.fn(() => true),
      restoreFromSerialized: vi.fn(() => true),
      restoreFromSerializedIncremental: vi.fn(async () => true),
    };
    const manager = new TerminalWakeManager(deps);

    await expect(manager.wakeAndRestore("term-1")).resolves.toBe(false);
  });

  it("allows retry after a failed wakeAndRestore call", async () => {
    wakeMock.mockRejectedValue(new Error("wake failed"));
    const managed: MockManagedTerminal = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
    };
    const deps: WakeManagerDeps = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
      hasInstance: vi.fn(() => true),
      restoreFromSerialized: vi.fn(() => true),
      restoreFromSerializedIncremental: vi.fn(async () => true),
    };
    const manager = new TerminalWakeManager(deps);

    await manager.wakeAndRestore("term-2");
    await manager.wakeAndRestore("term-2");

    expect(wakeMock).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent wakeAndRestore calls per terminal", async () => {
    let resolveWake!: (value: { state: string }) => void;
    const wakePromise = new Promise<{ state: string }>((resolve) => {
      resolveWake = resolve;
    });
    wakeMock.mockReturnValue(wakePromise);

    const managed: MockManagedTerminal = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
    };
    const deps: WakeManagerDeps = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
      hasInstance: vi.fn(() => true),
      restoreFromSerialized: vi.fn(() => true),
      restoreFromSerializedIncremental: vi.fn(async () => true),
    };
    const manager = new TerminalWakeManager(deps);

    const first = manager.wakeAndRestore("term-3");
    const second = manager.wakeAndRestore("term-3");
    expect(wakeMock).toHaveBeenCalledTimes(1);

    resolveWake({ state: "serialized-state" });

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(deps.restoreFromSerialized).toHaveBeenCalledTimes(1);
  });

  it("skips serialized state restore for alt-screen terminals", async () => {
    wakeMock.mockResolvedValueOnce({ state: "serialized-state" });
    const managed: MockManagedTerminal = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
      isAltBuffer: true,
    };
    const deps: WakeManagerDeps = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
      hasInstance: vi.fn(() => true),
      restoreFromSerialized: vi.fn(() => true),
      restoreFromSerializedIncremental: vi.fn(async () => true),
    };
    const manager = new TerminalWakeManager(deps);

    const result = await manager.wakeAndRestore("term-alt");

    expect(result).toBe(true);
    expect(deps.restoreFromSerialized).not.toHaveBeenCalled();
    expect(deps.restoreFromSerializedIncremental).not.toHaveBeenCalled();
  });

  it("treats alt-screen wake as successful even when serialized state is missing", async () => {
    wakeMock.mockResolvedValueOnce({ state: null });
    const managed: MockManagedTerminal = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
      isAltBuffer: true,
    };
    const deps: WakeManagerDeps = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
      hasInstance: vi.fn(() => true),
      restoreFromSerialized: vi.fn(() => true),
      restoreFromSerializedIncremental: vi.fn(async () => true),
    };
    const manager = new TerminalWakeManager(deps);

    const result = await manager.wakeAndRestore("term-alt-null-state");

    expect(result).toBe(true);
    expect(deps.restoreFromSerialized).not.toHaveBeenCalled();
    expect(deps.restoreFromSerializedIncremental).not.toHaveBeenCalled();
  });

  it("restores serialized state for non-alt-screen terminals", async () => {
    wakeMock.mockResolvedValueOnce({ state: "serialized-state" });
    const managed: MockManagedTerminal = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
      isAltBuffer: false,
    };
    const deps: WakeManagerDeps = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
      hasInstance: vi.fn(() => true),
      restoreFromSerialized: vi.fn(() => true),
      restoreFromSerializedIncremental: vi.fn(async () => true),
    };
    const manager = new TerminalWakeManager(deps);

    const result = await manager.wakeAndRestore("term-normal");

    expect(result).toBe(true);
    expect(deps.restoreFromSerialized).toHaveBeenCalledWith("term-normal", "serialized-state");
  });

  it("fails wake for non-alt-screen terminals when serialized state is missing", async () => {
    wakeMock.mockResolvedValueOnce({ state: null });
    const managed: MockManagedTerminal = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
      isAltBuffer: false,
    };
    const deps: WakeManagerDeps = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
      hasInstance: vi.fn(() => true),
      restoreFromSerialized: vi.fn(() => true),
      restoreFromSerializedIncremental: vi.fn(async () => true),
    };
    const manager = new TerminalWakeManager(deps);

    const result = await manager.wakeAndRestore("term-normal-null-state");

    expect(result).toBe(false);
    expect(deps.restoreFromSerialized).not.toHaveBeenCalled();
    expect(deps.restoreFromSerializedIncremental).not.toHaveBeenCalled();
  });

  it("deduplicates overlapping wake() triggers while restore is in flight", async () => {
    let resolveWake!: (value: { state: string }) => void;
    const wakePromise = new Promise<{ state: string }>((resolve) => {
      resolveWake = resolve;
    });
    wakeMock.mockReturnValue(wakePromise);

    const managed: MockManagedTerminal = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
    };
    const deps: WakeManagerDeps = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
      hasInstance: vi.fn(() => true),
      restoreFromSerialized: vi.fn(() => true),
      restoreFromSerializedIncremental: vi.fn(async () => true),
    };
    const manager = new TerminalWakeManager(deps);

    manager.wake("term-4");
    manager.wake("term-4");

    expect(wakeMock).toHaveBeenCalledTimes(1);

    resolveWake({ state: "serialized-state" });
    await wakePromise;
  });

  describe("rate-limit coalescing (#8562)", () => {
    function makeDeps(managed: MockManagedTerminal): WakeManagerDeps {
      return {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
        hasInstance: vi.fn(() => true),
        restoreFromSerialized: vi.fn(() => true),
        restoreFromSerializedIncremental: vi.fn(async () => true),
      };
    }

    it("schedules a trailing-edge wake when called inside the rate-limit window", async () => {
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValue({ state: "serialized-state" });
        const managed: MockManagedTerminal = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
          terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        };
        const manager = new TerminalWakeManager(makeDeps(managed));

        // First wake fires immediately
        manager.wake("term-rl-1");
        await vi.advanceTimersByTimeAsync(0);
        expect(wakeMock).toHaveBeenCalledTimes(1);

        // Allow first wake to resolve and record lastWakeTime
        await vi.advanceTimersByTimeAsync(0);

        // Second wake within rate-limit window MUST NOT be dropped silently —
        // it schedules a trailing-edge timer for the end of the window.
        vi.setSystemTime(Date.now() + 200);
        manager.wake("term-rl-1");
        // Trailing-edge timer hasn't fired yet
        expect(wakeMock).toHaveBeenCalledTimes(1);

        // Advance past the window and the trailing wake fires
        await vi.advanceTimersByTimeAsync(1000);
        expect(wakeMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("collapses repeated calls inside the window to a single trailing wake", async () => {
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValue({ state: "serialized-state" });
        const managed: MockManagedTerminal = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
          terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        };
        const manager = new TerminalWakeManager(makeDeps(managed));

        manager.wake("term-rl-2");
        await vi.advanceTimersByTimeAsync(0);
        expect(wakeMock).toHaveBeenCalledTimes(1);

        // Three more calls during the window — should collapse to one trailing
        vi.setSystemTime(Date.now() + 100);
        manager.wake("term-rl-2");
        vi.setSystemTime(Date.now() + 100);
        manager.wake("term-rl-2");
        vi.setSystemTime(Date.now() + 100);
        manager.wake("term-rl-2");

        expect(wakeMock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1500);
        expect(wakeMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels pending rate-limited wake when clearWakeState is called", async () => {
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValue({ state: "serialized-state" });
        const managed: MockManagedTerminal = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
          terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        };
        const manager = new TerminalWakeManager(makeDeps(managed));

        manager.wake("term-rl-3");
        await vi.advanceTimersByTimeAsync(0);
        expect(wakeMock).toHaveBeenCalledTimes(1);

        vi.setSystemTime(Date.now() + 200);
        manager.wake("term-rl-3");

        // Clear state cancels the pending trailing wake
        manager.clearWakeState("term-rl-3");

        await vi.advanceTimersByTimeAsync(2000);
        expect(wakeMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("dispose cancels all pending rate-limited wakes", async () => {
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValue({ state: "serialized-state" });
        const managed: MockManagedTerminal = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
          terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        };
        const manager = new TerminalWakeManager(makeDeps(managed));

        manager.wake("term-rl-4");
        await vi.advanceTimersByTimeAsync(0);
        manager.wake("term-rl-5");
        await vi.advanceTimersByTimeAsync(0);
        expect(wakeMock).toHaveBeenCalledTimes(2);

        vi.setSystemTime(Date.now() + 100);
        manager.wake("term-rl-4");
        manager.wake("term-rl-5");

        manager.dispose();

        await vi.advanceTimersByTimeAsync(2000);
        // No additional wakes fired after dispose
        expect(wakeMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("cancelPendingWake (#9906)", () => {
    function makeDeps(managed: MockManagedTerminal, hasInstance = true): WakeManagerDeps {
      return {
        getInstance: vi.fn(() =>
          hasInstance ? (managed as unknown as ManagedTerminal) : undefined
        ),
        hasInstance: vi.fn(() => hasInstance),
        restoreFromSerialized: vi.fn(() => true),
        restoreFromSerializedIncremental: vi.fn(async () => true),
      };
    }

    it("stops a trailing-edge rate-limited wake from firing its IPC", async () => {
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValue({ state: "serialized-state" });
        const managed: MockManagedTerminal = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
          terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        };
        const manager = new TerminalWakeManager(makeDeps(managed));

        // First wake fires immediately and records lastWakeTime.
        manager.wake("term-cancel-1");
        await vi.advanceTimersByTimeAsync(0);
        expect(wakeMock).toHaveBeenCalledTimes(1);

        // Second wake inside the window schedules a trailing-edge timer.
        vi.setSystemTime(Date.now() + 200);
        manager.wake("term-cancel-1");
        expect(manager.hasPendingWake("term-cancel-1")).toBe(true);

        // The terminal is backgrounded: cancel the pending wake before it fires.
        manager.cancelPendingWake("term-cancel-1");
        expect(manager.hasPendingWake("term-cancel-1")).toBe(false);

        // Advancing past the window must NOT fire the cancelled trailing wake —
        // this is the stale `wake-terminal` IPC the fix prevents.
        await vi.advanceTimersByTimeAsync(2000);
        expect(wakeMock).toHaveBeenCalledTimes(1);

        manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels an instance-retry pending wake", () => {
      vi.useFakeTimers();
      try {
        const managed: MockManagedTerminal = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
          terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        };
        // No instance yet → wake() schedules a retry.
        const manager = new TerminalWakeManager(makeDeps(managed, false));

        manager.wake("term-cancel-2");
        expect(manager.hasPendingWake("term-cancel-2")).toBe(true);

        manager.cancelPendingWake("term-cancel-2");
        expect(manager.hasPendingWake("term-cancel-2")).toBe(false);

        manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("preserves the rate-limit window (lastWakeTime) so a follow-up wake still coalesces", async () => {
      // Unlike clearWakeState, cancelPendingWake must NOT reset lastWakeTime —
      // a quick background→foreground within the 1s window should still be
      // rate-limited (scheduled as trailing), not fire a fresh wake immediately.
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValue({ state: "serialized-state" });
        const managed: MockManagedTerminal = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
          terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        };
        const manager = new TerminalWakeManager(makeDeps(managed));

        manager.wake("term-cancel-3");
        await vi.advanceTimersByTimeAsync(0);
        expect(wakeMock).toHaveBeenCalledTimes(1);

        // Schedule a trailing wake, then cancel it (background transition).
        vi.setSystemTime(Date.now() + 200);
        manager.wake("term-cancel-3");
        manager.cancelPendingWake("term-cancel-3");
        expect(wakeMock).toHaveBeenCalledTimes(1);

        // Foreground again still inside the original 1s window: because
        // lastWakeTime survived, this must coalesce into a trailing wake rather
        // than fire immediately.
        vi.setSystemTime(Date.now() + 100);
        manager.wake("term-cancel-3");
        expect(wakeMock).toHaveBeenCalledTimes(1);
        expect(manager.hasPendingWake("term-cancel-3")).toBe(true);

        await vi.advanceTimersByTimeAsync(2000);
        expect(wakeMock).toHaveBeenCalledTimes(2);

        manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("background guard on scheduled wake (#9906)", () => {
    it("does not fire a trailing-edge wake if the terminal is backgrounded when the timer fires", async () => {
      // Covers the hysteresis window: the wake was scheduled before the user
      // backgrounded the pane, and the debounced BACKGROUND tier apply (which
      // calls cancelPendingWake) hasn't run yet — but backgroundedTerminals is
      // already true. The timer must check it and skip the stale IPC.
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValue({ state: "serialized-state" });
        let backgrounded = false;
        const managed: MockManagedTerminal = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
          terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        };
        const deps: WakeManagerDeps = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
          hasInstance: vi.fn(() => true),
          restoreFromSerialized: vi.fn(() => true),
          restoreFromSerializedIncremental: vi.fn(async () => true),
          isBackgrounded: () => backgrounded,
        };
        const manager = new TerminalWakeManager(deps);

        manager.wake("term-bg-guard");
        await vi.advanceTimersByTimeAsync(0);
        expect(wakeMock).toHaveBeenCalledTimes(1);

        // Schedule a trailing wake, then background the pane before it fires.
        vi.setSystemTime(Date.now() + 200);
        manager.wake("term-bg-guard");
        backgrounded = true;

        await vi.advanceTimersByTimeAsync(2000);
        // The trailing wake's IPC was suppressed by the background guard.
        expect(wakeMock).toHaveBeenCalledTimes(1);

        manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("skips an instance-retry wake that resolves while backgrounded", () => {
      vi.useFakeTimers();
      try {
        let hasInstance = false;
        let backgrounded = false;
        const managed: MockManagedTerminal = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
          terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        };
        const deps: WakeManagerDeps = {
          getInstance: vi.fn(() =>
            hasInstance ? (managed as unknown as ManagedTerminal) : undefined
          ),
          hasInstance: vi.fn(() => hasInstance),
          restoreFromSerialized: vi.fn(() => true),
          restoreFromSerializedIncremental: vi.fn(async () => true),
          isBackgrounded: () => backgrounded,
        };
        const manager = new TerminalWakeManager(deps);

        // No instance yet → schedules a retry.
        manager.wake("term-retry-bg");
        // The instance appears but the pane is backgrounded before the retry.
        hasInstance = true;
        backgrounded = true;

        vi.advanceTimersByTime(500);
        expect(wakeMock).not.toHaveBeenCalled();

        manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("hasInFlightWake", () => {
    it("is true only while a wakeAndRestore is in flight", async () => {
      let resolveWake!: (value: { state: string }) => void;
      wakeMock.mockReturnValue(
        new Promise<{ state: string }>((resolve) => {
          resolveWake = resolve;
        })
      );
      const managed: MockManagedTerminal = {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
        terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
      };
      const deps: WakeManagerDeps = {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
        hasInstance: vi.fn(() => true),
        restoreFromSerialized: vi.fn(() => true),
        restoreFromSerializedIncremental: vi.fn(async () => true),
      };
      const manager = new TerminalWakeManager(deps);

      expect(manager.hasInFlightWake("term-if")).toBe(false);

      const wake = manager.wakeAndRestore("term-if");
      expect(manager.hasInFlightWake("term-if")).toBe(true);

      resolveWake({ state: "serialized-state" });
      await wake;
      // The in-flight entry is removed in a finally on the wake promise —
      // give that continuation one microtask turn.
      await Promise.resolve();
      expect(manager.hasInFlightWake("term-if")).toBe(false);
    });
  });

  describe("hasPendingWake", () => {
    function makePendingDeps(hasInstance: boolean): WakeManagerDeps {
      const managed: MockManagedTerminal = {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
        terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
      };
      return {
        getInstance: vi.fn(() =>
          hasInstance ? (managed as unknown as ManagedTerminal) : undefined
        ),
        hasInstance: vi.fn(() => hasInstance),
        restoreFromSerialized: vi.fn(() => true),
        restoreFromSerializedIncremental: vi.fn(async () => true),
      };
    }

    it("reflects a rate-limit-coalesced wake until it fires", async () => {
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValue({ state: "serialized-state" });
        const manager = new TerminalWakeManager(makePendingDeps(true));

        manager.wake("term-pw");
        await vi.advanceTimersByTimeAsync(0);
        expect(manager.hasPendingWake("term-pw")).toBe(false);

        // Second wake inside the 1s rate-limit window is coalesced.
        manager.wake("term-pw");
        expect(manager.hasPendingWake("term-pw")).toBe(true);

        await vi.advanceTimersByTimeAsync(1000);
        expect(manager.hasPendingWake("term-pw")).toBe(false);

        manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("reflects an instance-retry wake", () => {
      vi.useFakeTimers();
      try {
        const manager = new TerminalWakeManager(makePendingDeps(false));

        manager.wake("term-pr");
        expect(manager.hasPendingWake("term-pr")).toBe(true);

        manager.clearWakeState("term-pr");
        expect(manager.hasPendingWake("term-pr")).toBe(false);

        manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("replay failure surfaces classified error (#9896)", () => {
    const longState = "x".repeat(2_000_000); // > INCREMENTAL_RESTORE_CONFIG.indicatorThresholdBytes

    function makeFailureDeps(
      managed: MockManagedTerminal,
      options: {
        smallOk: boolean;
        incrementalOk: boolean;
      }
    ): WakeManagerDeps {
      return {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
        hasInstance: vi.fn(() => true),
        restoreFromSerialized: vi.fn(() => options.smallOk),
        restoreFromSerializedIncremental: vi.fn(async () => options.incrementalOk),
      };
    }

    it("returns false and publishes the classified error to the panel store on small-path replay failure", async () => {
      wakeMock.mockResolvedValueOnce({ state: "small-state" });
      const restoreError: TerminalScrollbackRestoreError = {
        type: "parse",
        message: "Parser error at offset 0",
        timestamp: 123,
      };
      const managed: MockManagedTerminal = {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
        terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        isAltBuffer: false,
        lastScrollbackRestoreError: restoreError,
      };
      const manager = new TerminalWakeManager(
        makeFailureDeps(managed, { smallOk: false, incrementalOk: true })
      );

      const result = await manager.wakeAndRestore("term-fail-small");

      expect(result).toBe(false);
      expect(setScrollbackRestoreErrorMock).toHaveBeenCalledTimes(1);
      expect(setScrollbackRestoreErrorMock).toHaveBeenCalledWith("term-fail-small", restoreError);
      // The buffer refresh that success would perform is skipped on failure.
      expect(managed.terminal.refresh).not.toHaveBeenCalled();
    });

    it("returns false and publishes the classified error on incremental-path replay failure", async () => {
      wakeMock.mockResolvedValueOnce({ state: longState });
      const restoreError: TerminalScrollbackRestoreError = {
        type: "timeout",
        message: "Write timeout",
        timestamp: 456,
      };
      const managed: MockManagedTerminal = {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
        terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        isAltBuffer: false,
        lastScrollbackRestoreError: restoreError,
      };
      const manager = new TerminalWakeManager(
        makeFailureDeps(managed, { smallOk: true, incrementalOk: false })
      );

      const result = await manager.wakeAndRestore("term-fail-incr");

      expect(result).toBe(false);
      expect(setScrollbackRestoreErrorMock).toHaveBeenCalledTimes(1);
      expect(setScrollbackRestoreErrorMock).toHaveBeenCalledWith("term-fail-incr", restoreError);
    });

    it("does not call setScrollbackRestoreError when the restore succeeds", async () => {
      wakeMock.mockResolvedValueOnce({ state: "serialized-state" });
      const managed: MockManagedTerminal = {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
        terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        isAltBuffer: false,
      };
      const manager = new TerminalWakeManager(
        makeFailureDeps(managed, { smallOk: true, incrementalOk: true })
      );

      const result = await manager.wakeAndRestore("term-success");

      expect(result).toBe(true);
      expect(setScrollbackRestoreErrorMock).not.toHaveBeenCalled();
      expect(managed.terminal.refresh).toHaveBeenCalledWith(0, 23);
    });

    it("returns false without touching the panel store if no classified error was stashed", async () => {
      // Defensive: a restore method returning false with no lastScrollbackRestoreError
      // shouldn't crash or publish a banner — just fail the wake.
      wakeMock.mockResolvedValueOnce({ state: "serialized-state" });
      const managed: MockManagedTerminal = {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
        terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        isAltBuffer: false,
      };
      const manager = new TerminalWakeManager(
        makeFailureDeps(managed, { smallOk: false, incrementalOk: true })
      );

      const result = await manager.wakeAndRestore("term-fail-no-error");

      expect(result).toBe(false);
      expect(setScrollbackRestoreErrorMock).not.toHaveBeenCalled();
    });

    it("does not record lastWakeTime when the wake fails (rate limit window stays open)", async () => {
      // A failed wake must return false so the upstream triggerWake callback
      // deletes any stale lastWakeTime entry, letting a follow-up wake fire
      // immediately (no rate-limit coalescing for a known-failed replay).
      // We verify the boolean return is what triggerWake observes, not the
      // private lastWakeTime map (which is implementation detail).
      vi.useFakeTimers();
      try {
        wakeMock.mockResolvedValue({ state: "serialized-state" });
        const restoreError: TerminalScrollbackRestoreError = {
          type: "error",
          message: "boom",
          timestamp: 1,
        };
        const managed: MockManagedTerminal = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
          terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
          isAltBuffer: false,
          lastScrollbackRestoreError: restoreError,
        };
        const restoreFn = vi.fn(() => false);
        const deps: WakeManagerDeps = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          getInstance: vi.fn(() => managed as unknown as ManagedTerminal),
          hasInstance: vi.fn(() => true),
          restoreFromSerialized: restoreFn,
          restoreFromSerializedIncremental: vi.fn(async () => true),
        };
        const manager = new TerminalWakeManager(deps);

        const first = manager.wakeAndRestore("term-rate-fail");
        await vi.advanceTimersByTimeAsync(0);
        const firstResult = await first;
        expect(firstResult).toBe(false); // signals failure to triggerWake

        // Second wake fires immediately (no rate-limit coalescing) because
        // triggerWake observed `false` and did not record lastWakeTime.
        const second = manager.wakeAndRestore("term-rate-fail");
        await vi.advanceTimersByTimeAsync(0);
        await second;
        expect(restoreFn).toHaveBeenCalledTimes(2);
        expect(wakeMock).toHaveBeenCalledTimes(2);

        manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears any prior banner on successful restore (recovery without manual dismiss)", async () => {
      // Mirror of hydration's retry path (#8535): a previous failed wake may
      // have left a banner in the panel store. Once the wake succeeds, the
      // banner must be cleared so the user doesn't see a stale error after
      // the replay has recovered.
      wakeMock.mockResolvedValueOnce({ state: "serialized-state" });
      const managed: MockManagedTerminal = {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
        terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        isAltBuffer: false,
      };
      const manager = new TerminalWakeManager(
        makeFailureDeps(managed, { smallOk: true, incrementalOk: true })
      );

      const result = await manager.wakeAndRestore("term-recover");

      expect(result).toBe(true);
      expect(setScrollbackRestoreErrorMock).not.toHaveBeenCalled();
      expect(clearScrollbackRestoreErrorMock).toHaveBeenCalledTimes(1);
      expect(clearScrollbackRestoreErrorMock).toHaveBeenCalledWith("term-recover");
    });

    it("does not clear a banner when the wake fails (failure is preserved)", async () => {
      wakeMock.mockResolvedValueOnce({ state: "serialized-state" });
      const restoreError: TerminalScrollbackRestoreError = {
        type: "parse",
        message: "Parser error",
        timestamp: 1,
      };
      const managed: MockManagedTerminal = {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any
        terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) } as any,
        isAltBuffer: false,
        lastScrollbackRestoreError: restoreError,
      };
      const manager = new TerminalWakeManager(
        makeFailureDeps(managed, { smallOk: false, incrementalOk: true })
      );

      const result = await manager.wakeAndRestore("term-fail-no-clear");

      expect(result).toBe(false);
      expect(clearScrollbackRestoreErrorMock).not.toHaveBeenCalled();
    });
  });
});
