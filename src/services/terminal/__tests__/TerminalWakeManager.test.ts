import { beforeEach, describe, expect, it, vi } from "vitest";

const { wakeMock } = vi.hoisted(() => ({
  wakeMock: vi.fn(),
}));

vi.mock("@/clients", () => ({
  terminalClient: {
    wake: wakeMock,
  },
}));

import { TerminalWakeManager, type WakeManagerDeps } from "../TerminalWakeManager";
import type { ManagedTerminal } from "../types";

type MockManagedTerminal = Pick<ManagedTerminal, "terminal" | "isAltBuffer"> & {
  isOpened?: boolean;
  isAttaching?: boolean;
  isHibernated?: boolean;
};

describe("TerminalWakeManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
