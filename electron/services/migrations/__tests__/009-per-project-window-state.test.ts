import { describe, expect, it, vi } from "vitest";
import { migration009 } from "../009-per-project-window-state.js";

function makeStoreMock(data: Record<string, unknown>) {
  return {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
  } as unknown as Parameters<typeof migration009.up>[0];
}

describe("migration009 — per-project window state", () => {
  it("seeds windowStates from existing non-default windowState", () => {
    const store = makeStoreMock({
      windowState: { x: 200, y: 300, width: 1400, height: 900, isMaximized: true },
    });

    migration009.up(store);

    expect(store.set).toHaveBeenCalledWith("windowStates", {
      __legacy__: { x: 200, y: 300, width: 1400, height: 900, isMaximized: true },
    });
  });

  it("initializes empty windowStates when windowState is at defaults", () => {
    const store = makeStoreMock({
      windowState: { width: 1200, height: 800, isMaximized: false },
    });

    migration009.up(store);

    expect(store.set).toHaveBeenCalledWith("windowStates", {});
  });

  it("initializes empty windowStates when windowState is undefined", () => {
    const store = makeStoreMock({});

    migration009.up(store);

    expect(store.set).toHaveBeenCalledWith("windowStates", {});
  });

  it("seeds from windowState with only x/y set (non-default position)", () => {
    const store = makeStoreMock({
      windowState: { x: 500, y: 200, width: 1200, height: 800, isMaximized: false },
    });

    migration009.up(store);

    expect(store.set).toHaveBeenCalledWith("windowStates", {
      __legacy__: { x: 500, y: 200, width: 1200, height: 800, isMaximized: false },
    });
  });

  it("has version 9", () => {
    expect(migration009.version).toBe(9);
  });
});
