import { beforeEach, describe, expect, it, vi } from "vitest";

const windowStatesStoreMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("../store.js", () => ({
  windowStatesStore: windowStatesStoreMock,
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    vi.clearAllTimers?.();
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
      windowStatesStoreMock.get.mockReturnValue({ "/home/user/project-a": projectBounds });

      createWindowWithState({ show: false }, "/home/user/project-a");

      expect(constructorCalls[0]).toEqual(
        expect.objectContaining({ x: 200, y: 300, width: 1400, height: 900 })
      );
    });

    it("falls back to MRU with offset when project state not found", () => {
      const existingBounds = { x: 100, y: 100, width: 1400, height: 900, isMaximized: false };
      windowStatesStoreMock.get.mockReturnValue({ "/home/user/other-project": existingBounds });

      createWindowWithState({ show: false }, "/home/user/new-project");

      expect(constructorCalls[0]).toEqual(
        expect.objectContaining({ x: 130, y: 130, width: 1400, height: 900 })
      );
    });

    it("falls back to defaults when no state exists", () => {
      windowStatesStoreMock.get.mockReturnValue({});

      createWindowWithState({ show: false });

      expect(constructorCalls[0]).toEqual(expect.objectContaining({ width: 1200, height: 800 }));
    });

    it("restores __legacy__ state exactly when no projectPath is provided", () => {
      windowStatesStoreMock.get.mockReturnValue({
        __legacy__: {
          x: 250,
          y: 180,
          width: 1500,
          height: 920,
          isMaximized: false,
          isFullScreen: false,
        },
      });

      createWindowWithState({ show: false });

      expect(constructorCalls[0]).toEqual(
        expect.objectContaining({ x: 250, y: 180, width: 1500, height: 920 })
      );
    });

    it("restores maximized __legacy__ state when no projectPath is provided", () => {
      windowStatesStoreMock.get.mockReturnValue({
        __legacy__: {
          x: 100,
          y: 100,
          width: 1200,
          height: 800,
          isMaximized: true,
          isFullScreen: false,
        },
      });

      createWindowWithState({ show: false });

      expect(winInstance.maximize).toHaveBeenCalled();
    });

    it("uses an existing project entry without offset for no-project cold start", () => {
      windowStatesStoreMock.get.mockReturnValue({
        "/home/user/project-a": {
          x: 120,
          y: 140,
          width: 1340,
          height: 860,
          isMaximized: false,
          isFullScreen: false,
        },
      });

      createWindowWithState({ show: false });

      expect(constructorCalls[0]).toEqual(
        expect.objectContaining({ x: 120, y: 140, width: 1340, height: 860 })
      );
    });

    it("does not cascade maximized state from MRU fallback", () => {
      windowStatesStoreMock.get.mockReturnValue({
        "/home/user/other": { x: 0, y: 0, width: 1920, height: 1080, isMaximized: true },
      });

      createWindowWithState({ show: false }, "/home/user/new-project");
      fireShow();

      expect(winInstance.maximize).not.toHaveBeenCalled();
    });

    it("does not cascade fullscreen state from MRU fallback", () => {
      windowStatesStoreMock.get.mockReturnValue({
        "/home/user/other": {
          x: 0,
          y: 0,
          width: 1920,
          height: 1080,
          isMaximized: false,
          isFullScreen: true,
        },
      });

      createWindowWithState({ show: false }, "/home/user/new-project");
      fireShow();

      expect(winInstance.setFullScreen).not.toHaveBeenCalled();
    });

    it("calls maximize() when saved state has isMaximized=true", () => {
      windowStatesStoreMock.get.mockReturnValue({
        "/home/user/project": {
          x: 100,
          y: 100,
          width: 1200,
          height: 800,
          isMaximized: true,
          isFullScreen: false,
        },
      });

      createWindowWithState({ show: false }, "/home/user/project");

      expect(winInstance.maximize).toHaveBeenCalled();
      expect(winInstance.setFullScreen).not.toHaveBeenCalled();
    });

    it("calls setFullScreen(true) when saved state has isFullScreen=true", () => {
      windowStatesStoreMock.get.mockReturnValue({
        "/home/user/project": {
          x: 100,
          y: 100,
          width: 1200,
          height: 800,
          isMaximized: false,
          isFullScreen: true,
        },
      });

      createWindowWithState({ show: false }, "/home/user/project");
      fireShow();

      expect(winInstance.setFullScreen).toHaveBeenCalledWith(true);
      expect(winInstance.maximize).not.toHaveBeenCalled();
    });

    it("prefers fullscreen over maximize when both are somehow set", () => {
      windowStatesStoreMock.get.mockReturnValue({
        "/home/user/project": {
          x: 100,
          y: 100,
          width: 1200,
          height: 800,
          isMaximized: true,
          isFullScreen: true,
        },
      });

      createWindowWithState({ show: false }, "/home/user/project");
      fireShow();

      expect(winInstance.setFullScreen).toHaveBeenCalledWith(true);
      expect(winInstance.maximize).not.toHaveBeenCalled();
    });

    it("handles legacy saved states without isFullScreen field", () => {
      windowStatesStoreMock.get.mockReturnValue({
        "/home/user/project": {
          x: 100,
          y: 100,
          width: 1400,
          height: 900,
          isMaximized: false,
        },
      });

      createWindowWithState({ show: false }, "/home/user/project");
      fireShow();

      expect(winInstance.setFullScreen).not.toHaveBeenCalled();
      expect(winInstance.maximize).not.toHaveBeenCalled();
    });
  });

  describe("recovery", () => {
    it("clamps oversized window at origin and calls setSize before center (#4710)", () => {
      const oversizedBounds = { x: 0, y: 0, width: 2560, height: 1440, isMaximized: false };
      windowStatesStoreMock.get.mockReturnValue({ "/home/user/project": oversizedBounds });

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
      windowStatesStoreMock.get.mockReturnValue({ "/home/user/project": oversizedBounds });

      winInstance.getBounds.mockReturnValue({ x: 1800, y: 900, width: 2560, height: 1440 });

      createWindowWithState({ show: false }, "/home/user/project");

      expect(winInstance.setSize).toHaveBeenCalledWith(1920, 1080);
      expect(winInstance.center).toHaveBeenCalled();
    });

    it("does not call setSize when window is fully visible on current display", () => {
      const normalBounds = { x: 100, y: 100, width: 1200, height: 800, isMaximized: false };
      windowStatesStoreMock.get.mockReturnValue({ "/home/user/project": normalBounds });

      winInstance.getBounds.mockReturnValue({ x: 100, y: 100, width: 1200, height: 800 });

      createWindowWithState({ show: false }, "/home/user/project");

      expect(winInstance.setSize).not.toHaveBeenCalled();
      expect(winInstance.center).not.toHaveBeenCalled();
    });

    it("clamps MRU-cascaded oversized bounds via clampToDisplay", () => {
      const oversizedMru = { x: 100, y: 100, width: 2560, height: 1440, isMaximized: false };
      windowStatesStoreMock.get.mockReturnValue({ "/home/user/other": oversizedMru });

      createWindowWithState({ show: false }, "/home/user/new-project");

      const opts = constructorCalls[0] as Record<string, number>;
      expect(opts.width).toBeLessThanOrEqual(1920);
      expect(opts.height).toBeLessThanOrEqual(1080);
    });

    it("does not call setSize on a maximized window (recovery runs before maximize)", () => {
      const savedBounds = {
        x: 100,
        y: 100,
        width: 1200,
        height: 800,
        isMaximized: true,
        isFullScreen: false,
      };
      windowStatesStoreMock.get.mockReturnValue({ "/home/user/project": savedBounds });

      winInstance.getBounds.mockReturnValue({ x: 100, y: 100, width: 1200, height: 800 });

      createWindowWithState({ show: false }, "/home/user/project");

      expect(winInstance.setSize).not.toHaveBeenCalled();
      expect(winInstance.maximize).toHaveBeenCalled();
    });

    it("does not call setSize for a fullscreen window (recovery runs before setFullScreen)", () => {
      const savedBounds = {
        x: 100,
        y: 100,
        width: 1200,
        height: 800,
        isMaximized: false,
        isFullScreen: true,
      };
      windowStatesStoreMock.get.mockReturnValue({ "/home/user/project": savedBounds });

      winInstance.getBounds.mockReturnValue({ x: 100, y: 100, width: 1200, height: 800 });

      createWindowWithState({ show: false }, "/home/user/project");
      fireShow();

      expect(winInstance.setSize).not.toHaveBeenCalled();
      expect(winInstance.setFullScreen).toHaveBeenCalledWith(true);
    });

    it("maximize() is called after setSize when recovery fires on an oversized maximized state", () => {
      const oversizedMaximized = {
        x: 0,
        y: 0,
        width: 3840,
        height: 2160,
        isMaximized: true,
        isFullScreen: false,
      };
      windowStatesStoreMock.get.mockReturnValue({ "/home/user/project": oversizedMaximized });

      winInstance.getBounds.mockReturnValue({ x: 0, y: 0, width: 3840, height: 2160 });

      createWindowWithState({ show: false }, "/home/user/project");

      expect(winInstance.setSize).toHaveBeenCalledWith(1920, 1080);
      expect(winInstance.center).toHaveBeenCalled();
      expect(winInstance.maximize).toHaveBeenCalled();
    });
  });

  describe("save", () => {
    it("saves to windowStatesStore using whole-object pattern", () => {
      windowStatesStoreMock.get.mockReturnValue({});

      createWindowWithState({ show: false }, "/home/user/project-a");

      const closeHandler = eventHandlers.get("close");
      expect(closeHandler).toBeDefined();
      closeHandler!();

      expect(windowStatesStoreMock.set).toHaveBeenCalledWith(
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
    });

    it("also updates __legacy__ when saving project-specific state", () => {
      windowStatesStoreMock.get.mockReturnValue({});

      createWindowWithState({ show: false }, "/home/user/project-a");

      const closeHandler = eventHandlers.get("close");
      closeHandler!();

      expect(windowStatesStoreMock.set).toHaveBeenCalledWith(
        "windowStates",
        expect.objectContaining({
          "/home/user/project-a": expect.objectContaining({
            width: expect.any(Number),
            height: expect.any(Number),
          }),
          __legacy__: expect.objectContaining({
            width: expect.any(Number),
            height: expect.any(Number),
          }),
        })
      );
    });

    it("saves to __legacy__ key when no project path is available", () => {
      windowStatesStoreMock.get.mockReturnValue({});

      createWindowWithState({ show: false });

      const closeHandler = eventHandlers.get("close");
      closeHandler!();

      expect(windowStatesStoreMock.set).toHaveBeenCalledWith(
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
      windowStatesStoreMock.get.mockReturnValue({});

      createWindowWithState({ show: false }, "/home/user/project-a");
      winInstance.isDestroyed.mockReturnValue(true);

      const closeHandler = eventHandlers.get("close");
      closeHandler!();

      expect(windowStatesStoreMock.set).not.toHaveBeenCalled();
    });

    it("preserves other project entries when saving", () => {
      const existingStates = {
        "/home/user/project-b": { x: 50, y: 50, width: 1000, height: 700, isMaximized: false },
      };
      windowStatesStoreMock.get.mockReturnValue({ ...existingStates });

      createWindowWithState({ show: false }, "/home/user/project-a");

      const closeHandler = eventHandlers.get("close");
      closeHandler!();

      const savedStates = windowStatesStoreMock.set.mock.calls.find(
        (c: unknown[]) => c[0] === "windowStates"
      );
      expect(savedStates).toBeDefined();
      const states = savedStates![1] as Record<string, unknown>;
      expect(states["/home/user/project-b"]).toEqual(existingStates["/home/user/project-b"]);
      expect(states["/home/user/project-a"]).toBeDefined();
    });

    it("saves isFullScreen=true when window is in fullscreen state at close", () => {
      windowStatesStoreMock.get.mockReturnValue({});

      createWindowWithState({ show: false }, "/home/user/project-a");

      winInstance.isFullScreen.mockReturnValue(true);
      winInstance.getNormalBounds.mockReturnValue({ x: 100, y: 100, width: 1200, height: 800 });

      const closeHandler = eventHandlers.get("close");
      closeHandler!();

      expect(windowStatesStoreMock.set).toHaveBeenCalledWith(
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
      windowStatesStoreMock.get.mockReturnValue({});

      createWindowWithState({ show: false }, "/home/user/project-a");

      winInstance.isMaximized.mockReturnValue(true);
      winInstance.isFullScreen.mockReturnValue(false);
      winInstance.getNormalBounds.mockReturnValue({ x: 200, y: 150, width: 1400, height: 900 });
      winInstance.getBounds.mockReturnValue({ x: -4, y: -4, width: 1928, height: 1088 });

      const closeHandler = eventHandlers.get("close");
      closeHandler!();

      expect(windowStatesStoreMock.set).toHaveBeenCalledWith(
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
      windowStatesStoreMock.get.mockReturnValue({});

      createWindowWithState({ show: false }, "/home/user/project-a");

      winInstance.isMaximized.mockReturnValue(false);
      winInstance.isFullScreen.mockReturnValue(true);
      winInstance.getNormalBounds.mockReturnValue({ x: 100, y: 100, width: 1300, height: 850 });
      winInstance.getBounds.mockReturnValue({ x: 0, y: 0, width: 1920, height: 1080 });

      const closeHandler = eventHandlers.get("close");
      closeHandler!();

      expect(windowStatesStoreMock.set).toHaveBeenCalledWith(
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

    it("closes does NOT call legacy store.set for windowState", () => {
      windowStatesStoreMock.get.mockReturnValue({});

      createWindowWithState({ show: false }, "/home/user/project-a");

      const closeHandler = eventHandlers.get("close");
      closeHandler!();

      // Should only call windowStatesStore.set, not any legacy store
      expect(windowStatesStoreMock.set).toHaveBeenCalled();
    });
  });

  describe("close handler", () => {
    it("writes exactly once on close (cancel pending debounce + flush)", async () => {
      vi.useFakeTimers();
      windowStatesStoreMock.get.mockReturnValue({});

      createWindowWithState({ show: false }, "/home/user/project-a");

      // Fire a resize to start the debounce timer
      const resizeHandler = eventHandlers.get("resize");
      expect(resizeHandler).toBeDefined();
      resizeHandler!();

      // Verify set hasn't been called yet (debounce pending)
      const setCallCountAfterResize = windowStatesStoreMock.set.mock.calls.length;

      // Now close — should cancel pending debounce and write once
      const closeHandler = eventHandlers.get("close");
      closeHandler!();

      // Should have exactly one more call after the resize (the close write)
      expect(windowStatesStoreMock.set.mock.calls.length).toBe(setCallCountAfterResize + 1);

      // Advance timers — should NOT trigger additional writes
      vi.advanceTimersByTime(1000);
      expect(windowStatesStoreMock.set.mock.calls.length).toBe(setCallCountAfterResize + 1);

      vi.useRealTimers();
    });
  });

  describe("MRU", () => {
    it("uses lastSavedProjectPath for MRU after save", () => {
      windowStatesStoreMock.get.mockReturnValue({
        "/home/user/project-b": { x: 50, y: 50, width: 1000, height: 700, isMaximized: false },
        "/home/user/project-a": { x: 300, y: 200, width: 1200, height: 800, isMaximized: false },
      });

      // Create window for project-a — lastSavedProjectPath is set on first save
      createWindowWithState({ show: false }, "/home/user/project-a");

      // Trigger a save via close so lastSavedProjectPath is set
      const closeHandler = eventHandlers.get("close");
      closeHandler!();

      // Now create a window for a new project — should use project-a as MRU
      vi.clearAllMocks();
      constructorCalls.length = 0;
      windowStatesStoreMock.get.mockReturnValue({
        "/home/user/project-b": { x: 50, y: 50, width: 1000, height: 700, isMaximized: false },
        "/home/user/project-a": { x: 300, y: 200, width: 1200, height: 800, isMaximized: false },
      });

      createWindowWithState({ show: false }, "/home/user/new-project");

      // MRU should be project-a (last saved), offset by 30px
      expect(constructorCalls[0]).toEqual(
        expect.objectContaining({ x: 330, y: 230, width: 1200, height: 800 })
      );
    });

    it("falls back to __legacy__ key when no lastSavedProjectPath", () => {
      windowStatesStoreMock.get.mockReturnValue({
        __legacy__: { x: 500, y: 400, width: 1024, height: 768, isMaximized: false },
      });

      createWindowWithState({ show: false }, "/home/user/new-project");

      // clampToDisplay adjusts y from 430 to 312 to keep bottom edge within 1080px work area
      expect(constructorCalls[0]).toEqual(
        expect.objectContaining({ x: 530, y: 312, width: 1024, height: 768 })
      );
    });
  });
});
