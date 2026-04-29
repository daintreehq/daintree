import { beforeEach, describe, expect, it, vi } from "vitest";
import { migration020 } from "../020-window-states-store.js";

const windowStatesStoreMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("../../../store.js", () => ({
  windowStatesStore: windowStatesStoreMock,
}));

function makeStoreMock(data: Record<string, unknown>) {
  return {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn(),
    delete: vi.fn((key: string) => {
      delete data[key];
    }),
  } as unknown as Parameters<typeof migration020.up>[0];
}

describe("migration020 — window states store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("moves windowStates to windowStatesStore", () => {
    const windowStates = {
      "/home/user/project-a": { x: 200, y: 300, width: 1400, height: 900, isMaximized: false },
      "/home/user/project-b": { x: 100, y: 100, width: 1200, height: 800, isMaximized: true },
    };
    const store = makeStoreMock({ windowStates: { ...windowStates } });

    windowStatesStoreMock.get.mockReturnValue({});

    migration020.up(store);

    expect(windowStatesStoreMock.set).toHaveBeenCalledWith("windowStates", windowStates);
    expect(store.delete).toHaveBeenCalledWith("windowStates");
    expect(store.delete).toHaveBeenCalledWith("windowState");
  });

  it("seeds __legacy__ from windowState when no per-project entries exist", () => {
    const windowState = { x: 50, y: 50, width: 1000, height: 700, isMaximized: false };
    const store = makeStoreMock({ windowStates: {}, windowState });

    windowStatesStoreMock.get.mockReturnValue({});

    migration020.up(store);

    expect(windowStatesStoreMock.set).toHaveBeenCalledWith("windowStates", {
      __legacy__: {
        x: 50,
        y: 50,
        width: 1000,
        height: 700,
        isMaximized: false,
        isFullScreen: false,
      },
    });
  });

  it("does not seed __legacy__ from windowState when per-project entries already exist", () => {
    const windowStates = {
      "/home/user/project-a": { x: 200, y: 300, width: 1400, height: 900, isMaximized: false },
    };
    const windowState = { x: 50, y: 50, width: 1000, height: 700, isMaximized: false };
    const store = makeStoreMock({ windowStates: { ...windowStates }, windowState });

    windowStatesStoreMock.get.mockReturnValue({});

    migration020.up(store);

    expect(windowStatesStoreMock.set).toHaveBeenCalledWith("windowStates", windowStates);
  });

  it("does not overwrite existing __legacy__ in windowStates", () => {
    const legacyEntry = { x: 999, y: 999, width: 800, height: 600, isMaximized: true };
    const windowStates = {
      __legacy__: legacyEntry,
    };
    const windowState = { x: 50, y: 50, width: 1000, height: 700, isMaximized: false };
    const store = makeStoreMock({ windowStates: { ...windowStates }, windowState });

    windowStatesStoreMock.get.mockReturnValue({});

    migration020.up(store);

    const setCall = windowStatesStoreMock.set.mock.calls.find(
      (c: unknown[]) => c[0] === "windowStates"
    );
    const states = setCall![1] as Record<string, unknown>;
    expect(states.__legacy__).toEqual(legacyEntry);
  });

  it("merges with existing windowStatesStore data", () => {
    const windowStates = {
      "/home/user/project-a": { x: 200, y: 300, width: 1400, height: 900, isMaximized: false },
    };
    const store = makeStoreMock({ windowStates: { ...windowStates } });

    windowStatesStoreMock.get.mockReturnValue({
      "/home/user/existing": { x: 0, y: 0, width: 1024, height: 768, isMaximized: true },
    });

    migration020.up(store);

    expect(windowStatesStoreMock.set).toHaveBeenCalledWith(
      "windowStates",
      expect.objectContaining({
        "/home/user/project-a": windowStates["/home/user/project-a"],
        "/home/user/existing": { x: 0, y: 0, width: 1024, height: 768, isMaximized: true },
      })
    );
  });

  it("handles missing windowStates and windowState gracefully", () => {
    const store = makeStoreMock({});

    windowStatesStoreMock.get.mockReturnValue({});

    migration020.up(store);

    expect(windowStatesStoreMock.set).toHaveBeenCalledWith("windowStates", {});
    expect(store.delete).toHaveBeenCalledWith("windowStates");
    expect(store.delete).toHaveBeenCalledWith("windowState");
  });

  it("has version 20", () => {
    expect(migration020.version).toBe(20);
  });
});
