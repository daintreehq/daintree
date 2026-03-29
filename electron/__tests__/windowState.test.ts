import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("../store.js", () => ({
  store: storeMock,
}));

const screenMock = vi.hoisted(() => ({
  getDisplayMatching: vi.fn(() => ({
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  })),
}));

const constructorCalls: unknown[] = [];
const eventHandlers = new Map<string, (...args: unknown[]) => void>();
const winInstance = {
  getBounds: vi.fn(() => ({ x: 100, y: 100, width: 1200, height: 800 })),
  isMaximized: vi.fn(() => false),
  isDestroyed: vi.fn(() => false),
  maximize: vi.fn(),
  center: vi.fn(),
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    eventHandlers.set(event, handler);
  }),
  id: 1,
};

vi.mock("electron", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock constructor requires any for this binding
  const BW = vi.fn(function (this: any, opts: unknown) {
    constructorCalls.push(opts);
    Object.assign(this, winInstance);
    this.on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      eventHandlers.set(event, handler);
    });
  });
  return { BrowserWindow: BW, screen: screenMock };
});

vi.mock("../services/ProjectStore.js", () => ({
  projectStore: {
    getCurrentProjectId: vi.fn(() => null),
    getProjectById: vi.fn(() => null),
  },
}));

import { createWindowWithState } from "../windowState.js";

describe("createWindowWithState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    constructorCalls.length = 0;
    eventHandlers.clear();
    winInstance.getBounds.mockReturnValue({ x: 100, y: 100, width: 1200, height: 800 });
    winInstance.isMaximized.mockReturnValue(false);
    winInstance.isDestroyed.mockReturnValue(false);
  });

  describe("restore", () => {
    it("restores per-project state when projectPath is provided and state exists", () => {
      const projectBounds = { x: 200, y: 300, width: 1400, height: 900, isMaximized: false };
      storeMock.get.mockImplementation((key: string) => {
        if (key === "windowStates") return { "/home/user/project-a": projectBounds };
        if (key === "windowState") return { width: 1200, height: 800, isMaximized: false };
        return {};
      });

      createWindowWithState({ show: false }, "/home/user/project-a");

      expect(constructorCalls[0]).toEqual(
        expect.objectContaining({ x: 200, y: 300, width: 1400, height: 900 })
      );
    });

    it("falls back to MRU with offset when project state not found", () => {
      const existingBounds = { x: 100, y: 100, width: 1400, height: 900, isMaximized: false };
      storeMock.get.mockImplementation((key: string) => {
        if (key === "windowStates") return { "/home/user/other-project": existingBounds };
        if (key === "windowState") return { width: 1200, height: 800, isMaximized: false };
        return {};
      });

      createWindowWithState({ show: false }, "/home/user/new-project");

      expect(constructorCalls[0]).toEqual(
        expect.objectContaining({ x: 130, y: 130, width: 1400, height: 900 })
      );
    });

    it("falls back to legacy windowState when windowStates is empty", () => {
      storeMock.get.mockImplementation((key: string) => {
        if (key === "windowStates") return {};
        if (key === "windowState")
          return { x: 50, y: 50, width: 1000, height: 700, isMaximized: false };
        return {};
      });

      createWindowWithState({ show: false }, "/home/user/project");

      expect(constructorCalls[0]).toEqual(
        expect.objectContaining({ x: 50, y: 50, width: 1000, height: 700 })
      );
    });

    it("falls back to defaults when no state exists", () => {
      storeMock.get.mockImplementation((key: string) => {
        if (key === "windowStates") return {};
        if (key === "windowState") return { width: 1200, height: 800, isMaximized: false };
        return {};
      });

      createWindowWithState({ show: false });

      expect(constructorCalls[0]).toEqual(expect.objectContaining({ width: 1200, height: 800 }));
    });

    it("does not cascade maximized state from MRU fallback", () => {
      storeMock.get.mockImplementation((key: string) => {
        if (key === "windowStates")
          return {
            "/home/user/other": { x: 0, y: 0, width: 1920, height: 1080, isMaximized: true },
          };
        if (key === "windowState") return { width: 1200, height: 800, isMaximized: false };
        return {};
      });

      createWindowWithState({ show: false }, "/home/user/new-project");

      expect(winInstance.maximize).not.toHaveBeenCalled();
    });
  });

  describe("save", () => {
    it("saves to per-project key using whole-object pattern", () => {
      storeMock.get.mockImplementation((key: string) => {
        if (key === "windowStates") return {};
        if (key === "windowState") return { width: 1200, height: 800, isMaximized: false };
        return {};
      });

      createWindowWithState({ show: false }, "/home/user/project-a");

      const closeHandler = eventHandlers.get("close");
      expect(closeHandler).toBeDefined();
      closeHandler!();

      expect(storeMock.set).toHaveBeenCalledWith(
        "windowStates",
        expect.objectContaining({
          "/home/user/project-a": expect.objectContaining({
            width: expect.any(Number),
            height: expect.any(Number),
            isMaximized: false,
          }),
        })
      );

      expect(storeMock.set).toHaveBeenCalledWith("windowState", expect.any(Object));
    });

    it("saves to __legacy__ key when no project path is available", () => {
      storeMock.get.mockImplementation((key: string) => {
        if (key === "windowStates") return {};
        if (key === "windowState") return { width: 1200, height: 800, isMaximized: false };
        return {};
      });

      createWindowWithState({ show: false });

      const closeHandler = eventHandlers.get("close");
      closeHandler!();

      expect(storeMock.set).toHaveBeenCalledWith(
        "windowStates",
        expect.objectContaining({
          __legacy__: expect.objectContaining({
            width: expect.any(Number),
            height: expect.any(Number),
          }),
        })
      );
    });

    it("preserves other project entries when saving", () => {
      const existingStates = {
        "/home/user/project-b": { x: 50, y: 50, width: 1000, height: 700, isMaximized: false },
      };
      storeMock.get.mockImplementation((key: string) => {
        if (key === "windowStates") return { ...existingStates };
        if (key === "windowState") return { width: 1200, height: 800, isMaximized: false };
        return {};
      });

      createWindowWithState({ show: false }, "/home/user/project-a");

      const closeHandler = eventHandlers.get("close");
      closeHandler!();

      const savedStates = storeMock.set.mock.calls.find((c: unknown[]) => c[0] === "windowStates");
      expect(savedStates).toBeDefined();
      const states = savedStates![1] as Record<string, unknown>;
      expect(states["/home/user/project-b"]).toEqual(existingStates["/home/user/project-b"]);
      expect(states["/home/user/project-a"]).toBeDefined();
    });
  });
});
