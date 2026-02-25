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

describe("TerminalWakeManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false when wake request fails instead of rejecting", async () => {
    wakeMock.mockRejectedValueOnce(new Error("wake failed"));
    const managed = {
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) },
    };
    const deps: WakeManagerDeps = {
      getInstance: vi.fn(() => managed as any),
      hasInstance: vi.fn(() => true),
      restoreFromSerialized: vi.fn(() => true),
      restoreFromSerializedIncremental: vi.fn(async () => true),
    };
    const manager = new TerminalWakeManager(deps);

    await expect(manager.wakeAndRestore("term-1")).resolves.toBe(false);
  });

  it("allows retry after a failed wakeAndRestore call", async () => {
    wakeMock.mockRejectedValue(new Error("wake failed"));
    const managed = {
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) },
    };
    const deps: WakeManagerDeps = {
      getInstance: vi.fn(() => managed as any),
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

    const managed = {
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) },
    };
    const deps: WakeManagerDeps = {
      getInstance: vi.fn(() => managed as any),
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
    const managed = {
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) },
      isAltBuffer: true,
    } as unknown as ManagedTerminal;
    const deps: WakeManagerDeps = {
      getInstance: vi.fn(() => managed),
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
    const managed = {
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) },
      isAltBuffer: true,
    } as unknown as ManagedTerminal;
    const deps: WakeManagerDeps = {
      getInstance: vi.fn(() => managed),
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
    const managed = {
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) },
      isAltBuffer: false,
    } as unknown as ManagedTerminal;
    const deps: WakeManagerDeps = {
      getInstance: vi.fn(() => managed),
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
    const managed = {
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) },
      isAltBuffer: false,
    } as unknown as ManagedTerminal;
    const deps: WakeManagerDeps = {
      getInstance: vi.fn(() => managed),
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

    const managed = {
      terminal: { rows: 24, refresh: vi.fn(), hasSelection: vi.fn(() => false) },
    };
    const deps: WakeManagerDeps = {
      getInstance: vi.fn(() => managed as any),
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
});
