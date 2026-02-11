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

describe("TerminalWakeManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false when wake request fails instead of rejecting", async () => {
    wakeMock.mockRejectedValueOnce(new Error("wake failed"));
    const managed = {
      terminal: { rows: 24, refresh: vi.fn() },
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
      terminal: { rows: 24, refresh: vi.fn() },
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
      terminal: { rows: 24, refresh: vi.fn() },
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

  it("deduplicates overlapping wake() triggers while restore is in flight", async () => {
    let resolveWake!: (value: { state: string }) => void;
    const wakePromise = new Promise<{ state: string }>((resolve) => {
      resolveWake = resolve;
    });
    wakeMock.mockReturnValue(wakePromise);

    const managed = {
      terminal: { rows: 24, refresh: vi.fn() },
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
