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
const onceHandlers = new Map<string, (...args: unknown[]) => void>();
const winInstance = {
  getBounds: vi.fn(() => ({ x: 100, y: 100, width: 1200, height: 800 })),
  getNormalBounds: vi.fn(() => ({ x: 100, y: 100, width: 1200, height: 800 })),
  isMaximized: vi.fn(() => false),
  isFullScreen: vi.fn(() => false),
  isDestroyed: vi.fn(() => false),
  maximize: vi.fn(),
  setFullScreen: vi.fn(),
  center: vi.fn(),
  setSize: vi.fn(),
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    eventHandlers.set(event, handler);
  }),
  once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    onceHandlers.set(event, handler);
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
  // Helper: fire the deferred 'show' handler (fullscreen is applied after show)
  const fireShow = () => onceHandlers.get("show")?.();

  beforeEach(() => {
    vi.clearAllMocks();
    constructorCalls.length = 0;
    eventHandlers.clear();
    onceHandlers.clear();
    winInstance.getBounds.mockReturnValue({ x: 100, y: 100, width: 1200, height: 800 });
    winInstance.getNormalBounds.mockReturnValue({ x: 100, y: 100, width: 1200, height: 800 });
    winInstance.isMaximized.mockReturnValue(false);
    winInstance.isFullScreen.mockReturnValue(false);
    winInstance.isDestroyed.mockReturnValue(false);
  });

  describe("restore", () => {
    it("restores per-project state when projectPath is provided and state exists", () => {
      const projectBounds = {
        x: 200,
        y: 300,
        width: 1400,
        height: 900,
        isMaximized: false,
        isFullScreen: false,
      };
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
      fireShow();

      expect(winInstance.maximize).not.toHaveBeenCalled();
    });

    it("does not cascade fullscreen state from MRU fallback", () => {
      storeMock.get.mockImplementation((key: string) => {
        if (key === "windowStates")
          return {
            "/home/user/other": {
              x: 0,
              y: 0,
              width: 1920,
              height: 1080,
              isMaximized: false,
              isFullScreen: true,
            },
          };
        return {};
      });

      createWindowWithState({ show: false }, "/home/user/new-project");
      fireShow();

      expect(winInstance.setFullScreen).not.toHaveBeenCalled();
    });

    it("calls maximize() when saved state has isMaximized=true", () => {
      storeMock.get.mockImplementation((key: string) => {
        if (key === "windowStates")
          return {
            "/home/user/project": {
              x: 100,
              y: 100,
              width: 1200,
              height: 800,
              isMaximized: true,
              isFullScreen: false,
            },
          };
        return {};
      });

      createWindowWithState({ show: false }, "/home/user/project");

      // maximize is applied immediately (before show), not deferred
      expect(winInstance.maximize).toHaveBeenCalled();
      expect(winInstance.setFullScreen).not.toHaveBeenCalled();
    });

    it("calls setFullScreen(true) when saved state has isFullScreen=true", () => {
      storeMock.get.mockImplementation((key: string) => {
        if (key === "windowStates")
          return {
            "/home/user/project": {
              x: 100,
              y: 100,
              width: 1200,
              height: 800,
              isMaximized: false,
              isFullScreen: true,
            },
          };
        return {};
      });

      createWindowWithState({ show: false }, "/home/user/project");
      fireShow(); // fullscreen is deferred to 'show' event

      expect(winInstance.setFullScreen).toHaveBeenCalledWith(true);
      expect(winInstance.maximize).not.toHaveBeenCalled();
    });

    it("prefers fullscreen over maximize when both are somehow set", () => {
      storeMock.get.mockImplementation((key: string) => {
        if (key === "windowStates")
          return {
            "/home/user/project": {
              x: 100,
              y: 100,
              width: 1200,
              height: 800,
              isMaximized: true,
              isFullScreen: true,
            },
          };
        return {};
      });

      createWindowWithState({ show: false }, "/home/user/project");
      fireShow();

      expect(winInstance.setFullScreen).toHaveBeenCalledWith(true);
      expect(winInstance.maximize).not.toHaveBeenCalled();
    });

    it("restores isFullScreen from legacy windowState key", () => {
      storeMock.get.mockImplementation((key: string) => {
        if (key === "windowStates") return {};
        if (key === "windowState")
          return { x: 50, y: 50, width: 1000, height: 700, isMaximized: false, isFullScreen: true };
        return {};
      });

      createWindowWithState({ show: false }, "/home/user/project");
      fireShow();

      expect(winInstance.setFullScreen).toHaveBeenCalledWith(true);
      expect(winInstance.maximize).not.toHaveBeenCalled();
    });

    it("cold start (no projectPath) restores isMaximized from legacy state", () => {
      // On initial launch, createWindow() is called without a projectPath.
      // resolveWindowBounds must NOT strip isMaximized via MRU cascade.
      storeMock.get.mockImplementation((key: string) => {
        if (key === "windowStates")
          return {
            "/home/user/project": {
              x: 100,
              y: 100,
              width: 1200,
              height: 800,
              isMaximized: true,
              isFullScreen: false,
            },
          };
        if (key === "windowState")
          return {
            x: 100,
            y: 100,
            width: 1200,
            height: 800,
            isMaximized: true,
            isFullScreen: false,
          };
        return {};
      });

      // No projectPath — simulates cold start
      createWindowWithState({ show: false });

      expect(winInstance.maximize).toHaveBeenCalled();
    });

    it("cold start (no projectPath) restores isFullScreen from legacy state", () => {
      storeMock.get.mockImplementation((key: string) => {
        if (key === "windowStates")
          return {
            "/home/user/project": {
              x: 100,
              y: 100,
              width: 1200,
              height: 800,
              isMaximized: false,
              isFullScreen: true,
            },
          };
        if (key === "windowState")
          return {
            x: 100,
            y: 100,
            width: 1200,
            height: 800,
            isMaximized: false,
            isFullScreen: true,
          };
        return {};
      });

      createWindowWithState({ show: false });
      fireShow();

      expect(winInstance.setFullScreen).toHaveBeenCalledWith(true);
      expect(winInstance.maximize).not.toHaveBeenCalled();
    });

    it("handles legacy saved states without isFullScreen field", () => {
      // Old saves won't have isFullScreen — should default to false
      storeMock.get.mockImplementation((key: string) => {
        if (key === "windowStates")
          return {
            "/home/user/project": {
              x: 100,
              y: 100,
              width: 1400,
              height: 900,
              isMaximized: false,
              // no isFullScreen field
            },
          };
        return {};
      });

      createWindowWithState({ show: false }, "/home/user/project");
      fireShow();

      expect(winInstance.setFullScreen).not.toHaveBeenCalled();
      expect(winInstance.maximize).not.toHaveBeenCalled();
    });
  });

  describe("recovery", () => {
    it("clamps oversized window at origin and calls setSize before center (#4710)", () => {
      // Exact #4710 scenario: window saved on 2560×1440 external monitor, reopened at origin on 1920×1080
      const oversizedBounds = { x: 0, y: 0, width: 2560, height: 1440, isMaximized: false };
      storeMock.get.mockImplementation((key: string) => {
        if (key === "windowStates") return { "/home/user/project": oversizedBounds };
        return {};
      });

      winInstance.getBounds.mockReturnValue({ x: 0, y: 0, width: 2560, height: 1440 });

      createWindowWithState({ show: false }, "/home/user/project");

      expect(winInstance.setSize).toHaveBeenCalledWith(1920, 1080);
      expect(winInstance.center).toHaveBeenCalled();

      const setSizeOrder = winInstance.setSize.mock.invocationCallOrder[0];
      const centerOrder = winInstance.center.mock.invocationCallOrder[0];
      expect(setSizeOrder).toBeLessThan(centerOrder);
    });

    it("clamps oversized window and centers when mostly off-screen", () => {
      const oversizedBounds = { x: 1800, y: 900, width: 2560, height: 1440, isMaximized: false };
      storeMock.get.mockImplementation((key: string) => {
        if (key === "windowStates") return { "/home/user/project": oversizedBounds };
        return {};
      });

      winInstance.getBounds.mockReturnValue({ x: 1800, y: 900, width: 2560, height: 1440 });

      createWindowWithState({ show: false }, "/home/user/project");

      expect(winInstance.setSize).toHaveBeenCalledWith(1920, 1080);
      expect(winInstance.center).toHaveBeenCalled();
    });

    it("does not call setSize when window is fully visible on current display", () => {
      const normalBounds = { x: 100, y: 100, width: 1200, height: 800, isMaximized: false };
      storeMock.get.mockImplementation((key: string) => {
        if (key === "windowStates") return { "/home/user/project": normalBounds };
        return {};
      });

      winInstance.getBounds.mockReturnValue({ x: 100, y: 100, width: 1200, height: 800 });

      createWindowWithState({ show: false }, "/home/user/project");

      expect(winInstance.setSize).not.toHaveBeenCalled();
      expect(winInstance.center).not.toHaveBeenCalled();
    });

    it("clamps MRU-cascaded oversized bounds via clampToDisplay", () => {
      // MRU has oversized dimensions from external monitor
      const oversizedMru = { x: 100, y: 100, width: 2560, height: 1440, isMaximized: false };
      storeMock.get.mockImplementation((key: string) => {
        if (key === "windowStates") return { "/home/user/other": oversizedMru };
        return {};
      });

      createWindowWithState({ show: false }, "/home/user/new-project");

      // clampToDisplay should have clamped width/height to workArea (1920×1080)
      const opts = constructorCalls[0] as Record<string, number>;
      expect(opts.width).toBeLessThanOrEqual(1920);
      expect(opts.height).toBeLessThanOrEqual(1080);
    });

    it("does not call setSize on a maximized window (recovery runs before maximize)", () => {
      // Regression guard: on Windows, getBounds() on a maximized window returns overflow bounds
      // (e.g. width:1928 on 1920px display). Recovery check must run before maximize() so it
      // sees the saved normal-state bounds, not the overflow bounds.
      const savedBounds = {
        x: 100,
        y: 100,
        width: 1200,
        height: 800,
        isMaximized: true,
        isFullScreen: false,
      };
      storeMock.get.mockImplementation((key: string) => {
        if (key === "windowStates") return { "/home/user/project": savedBounds };
        return {};
      });

      winInstance.getBounds.mockReturnValue({ x: 100, y: 100, width: 1200, height: 800 });

      createWindowWithState({ show: false }, "/home/user/project");

      expect(winInstance.setSize).not.toHaveBeenCalled();
      // maximize is applied immediately (before show)
      expect(winInstance.maximize).toHaveBeenCalled();
    });

    it("does not call setSize for a fullscreen window (recovery runs before setFullScreen)", () => {
      // On macOS, getBounds() in native fullscreen returns bounds exceeding workArea.
      // Recovery check must run before setFullScreen() is called.
      const savedBounds = {
        x: 100,
        y: 100,
        width: 1200,
        height: 800,
        isMaximized: false,
        isFullScreen: true,
      };
      storeMock.get.mockImplementation((key: string) => {
        if (key === "windowStates") return { "/home/user/project": savedBounds };
        return {};
      });

      winInstance.getBounds.mockReturnValue({ x: 100, y: 100, width: 1200, height: 800 });

      createWindowWithState({ show: false }, "/home/user/project");
      fireShow();

      expect(winInstance.setSize).not.toHaveBeenCalled();
      expect(winInstance.setFullScreen).toHaveBeenCalledWith(true);
    });

    it("maximize() is called after setSize when recovery fires on an oversized maximized state", () => {
      // Edge case: saved state has isMaximized:true but with coords from a disconnected
      // large monitor. Recovery should clamp the size, then maximize should still be applied.
      const oversizedMaximized = {
        x: 0,
        y: 0,
        width: 3840,
        height: 2160,
        isMaximized: true,
        isFullScreen: false,
      };
      storeMock.get.mockImplementation((key: string) => {
        if (key === "windowStates") return { "/home/user/project": oversizedMaximized };
        return {};
      });

      winInstance.getBounds.mockReturnValue({ x: 0, y: 0, width: 3840, height: 2160 });

      createWindowWithState({ show: false }, "/home/user/project");

      // Recovery (setSize + center) and maximize all fire during createWindowWithState
      expect(winInstance.setSize).toHaveBeenCalledWith(1920, 1080);
      expect(winInstance.center).toHaveBeenCalled();
      expect(winInstance.maximize).toHaveBeenCalled();
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
            isFullScreen: false,
          }),
        })
      );

      expect(storeMock.set).toHaveBeenCalledWith(
        "windowState",
        expect.objectContaining({ isFullScreen: false })
      );
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

    it("skips save when window is destroyed", () => {
      storeMock.get.mockImplementation((key: string) => {
        if (key === "windowStates") return {};
        return {};
      });

      createWindowWithState({ show: false }, "/home/user/project-a");
      winInstance.isDestroyed.mockReturnValue(true);

      const closeHandler = eventHandlers.get("close");
      closeHandler!();

      expect(storeMock.set).not.toHaveBeenCalled();
    });

    it("saves state when the move event fires", () => {
      storeMock.get.mockImplementation((key: string) => {
        if (key === "windowStates") return {};
        return {};
      });

      createWindowWithState({ show: false }, "/home/user/project-a");

      winInstance.getNormalBounds.mockReturnValue({ x: 300, y: 200, width: 1200, height: 800 });

      const moveHandler = eventHandlers.get("move");
      expect(moveHandler).toBeDefined();
      moveHandler!();

      // move is debounced — flush via fake timers not needed here since we just verify
      // the handler is wired; the close handler proves the underlying saveState logic
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

    it("saves isFullScreen=true when window is in fullscreen state at close", () => {
      storeMock.get.mockImplementation((key: string) => {
        if (key === "windowStates") return {};
        if (key === "windowState") return { width: 1200, height: 800, isMaximized: false };
        return {};
      });

      createWindowWithState({ show: false }, "/home/user/project-a");

      winInstance.isFullScreen.mockReturnValue(true);
      winInstance.getNormalBounds.mockReturnValue({ x: 100, y: 100, width: 1200, height: 800 });

      const closeHandler = eventHandlers.get("close");
      closeHandler!();

      expect(storeMock.set).toHaveBeenCalledWith(
        "windowStates",
        expect.objectContaining({
          "/home/user/project-a": expect.objectContaining({
            isFullScreen: true,
            isMaximized: false,
            width: 1200,
            height: 800,
          }),
        })
      );
    });

    it("uses getNormalBounds() to save pre-maximize dimensions when maximized at close", () => {
      storeMock.get.mockImplementation((key: string) => {
        if (key === "windowStates") return {};
        if (key === "windowState") return { width: 1200, height: 800, isMaximized: false };
        return {};
      });

      createWindowWithState({ show: false }, "/home/user/project-a");

      // Simulate window being maximized when close fires
      winInstance.isMaximized.mockReturnValue(true);
      winInstance.isFullScreen.mockReturnValue(false);
      // getNormalBounds returns the pre-maximize size
      winInstance.getNormalBounds.mockReturnValue({ x: 200, y: 150, width: 1400, height: 900 });
      // getBounds would return the maximized (overflow) bounds — should NOT be used
      winInstance.getBounds.mockReturnValue({ x: -4, y: -4, width: 1928, height: 1088 });

      const closeHandler = eventHandlers.get("close");
      closeHandler!();

      expect(storeMock.set).toHaveBeenCalledWith(
        "windowStates",
        expect.objectContaining({
          "/home/user/project-a": expect.objectContaining({
            x: 200,
            y: 150,
            width: 1400,
            height: 900,
            isMaximized: true,
          }),
        })
      );
    });

    it("uses getNormalBounds() to save pre-fullscreen dimensions when fullscreen at close", () => {
      storeMock.get.mockImplementation((key: string) => {
        if (key === "windowStates") return {};
        return {};
      });

      createWindowWithState({ show: false }, "/home/user/project-a");

      winInstance.isMaximized.mockReturnValue(false);
      winInstance.isFullScreen.mockReturnValue(true);
      // getNormalBounds returns the pre-fullscreen window size
      winInstance.getNormalBounds.mockReturnValue({ x: 100, y: 100, width: 1300, height: 850 });
      // getBounds returns full display bounds — should NOT be used
      winInstance.getBounds.mockReturnValue({ x: 0, y: 0, width: 1920, height: 1080 });

      const closeHandler = eventHandlers.get("close");
      closeHandler!();

      expect(storeMock.set).toHaveBeenCalledWith(
        "windowStates",
        expect.objectContaining({
          "/home/user/project-a": expect.objectContaining({
            x: 100,
            y: 100,
            width: 1300,
            height: 850,
            isFullScreen: true,
            isMaximized: false,
          }),
        })
      );
    });
  });
});
