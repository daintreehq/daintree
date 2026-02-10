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

  it("does not rate-limit retries after a failed wake", async () => {
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

    manager.wake("term-2");
    await Promise.resolve();
    manager.wake("term-2");
    await Promise.resolve();

    expect(wakeMock).toHaveBeenCalledTimes(2);
  });
});
