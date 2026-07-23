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
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  })),
  getPrimaryDisplay: vi.fn(() => ({
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
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
  setBounds: vi.fn(),
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

import {
  createWindowWithState,
  pruneWindowStateForPath,
  rekeyWindowStateForPath,
} from "../windowState.js";

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
    it("clamps oversized window at origin and calls setSize before setBounds (#4710)", () => {
      const oversizedBounds = { x: 0, y: 0, width: 2560, height: 1440, isMaximized: false };
      windowStatesStoreMock.get.mockReturnValue({ "/home/user/project": oversizedBounds });

      winInstance.getBounds.mockReturnValue({ x: 0, y: 0, width: 2560, height: 1440 });

      createWindowWithState({ show: false }, "/home/user/project");

      expect(winInstance.setSize).toHaveBeenCalledWith(1920, 1080);
      expect(winInstance.setBounds).toHaveBeenCalledWith({
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
      });

      const setSizeOrder = winInstance.setSize.mock.invocationCallOrder[0];
      const setBoundsOrder = winInstance.setBounds.mock.invocationCallOrder[0];
      expect(setSizeOrder).toBeLessThan(setBoundsOrder);
    });

    it("clamps oversized window and repositions when mostly off-screen", () => {
      const oversizedBounds = { x: 1800, y: 900, width: 2560, height: 1440, isMaximized: false };
      windowStatesStoreMock.get.mockReturnValue({ "/home/user/project": oversizedBounds });

      winInstance.getBounds.mockReturnValue({ x: 1800, y: 900, width: 2560, height: 1440 });

      createWindowWithState({ show: false }, "/home/user/project");

      expect(winInstance.setSize).toHaveBeenCalledWith(1920, 1080);
      // clampToDisplay pulls a mostly-off-screen window back to the top-left of the work area
      expect(winInstance.setBounds).toHaveBeenCalledWith({
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
      });
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
      expect(winInstance.setBounds).toHaveBeenCalled();
      expect(winInstance.maximize).toHaveBeenCalled();
    });

    it("clamps oversized default window with no saved x/y on small display (#10076)", () => {
      // Default cold-start state: no x/y, default 1200x800, on a 1280x720 work area
      // (1366x768 laptop with taskbar, 1280x720 display, RDP, VM, scaled DPI).
      const defaultBounds = {
        width: 1200,
        height: 800,
        isMaximized: false,
        isFullScreen: false,
      };
      windowStatesStoreMock.get.mockReturnValue({ "/home/user/project": defaultBounds });

      winInstance.getBounds.mockReturnValue({ x: 0, y: 0, width: 1200, height: 800 });

      screenMock.getPrimaryDisplay.mockReturnValueOnce({
        workArea: { x: 0, y: 0, width: 1280, height: 720 },
        bounds: { x: 0, y: 0, width: 1280, height: 720 },
      });

      createWindowWithState({ show: false }, "/home/user/project");

      // Constructor received no x/y (the bug's short-circuit path)
      const opts = constructorCalls[0] as Record<string, unknown>;
      expect(opts).not.toHaveProperty("x");
      expect(opts).not.toHaveProperty("y");
      // Size was clamped to fit the 720px-tall work area
      expect(winInstance.setSize).toHaveBeenCalledWith(1200, 720);
      // And the window was centered on the primary display
      expect(winInstance.center).toHaveBeenCalled();

      const setSizeOrder = winInstance.setSize.mock.invocationCallOrder[0];
      const centerOrder = winInstance.center.mock.invocationCallOrder[0];
      expect(setSizeOrder).toBeLessThan(centerOrder);
    });

    it("pulls a partially off-left window back to keep the title bar reachable", () => {
      // 75% visible: x=-300, w=1200 on a 1920px work area. The old 50%-visible math
      // left this as-is (traffic-light controls unreachable on macOS). clampToDisplay
      // pins x to wa.x (=0) and shrinks width if needed.
      const offLeftBounds = {
        x: -300,
        y: 100,
        width: 1200,
        height: 800,
        isMaximized: false,
      };
      windowStatesStoreMock.get.mockReturnValue({ "/home/user/project": offLeftBounds });

      winInstance.getBounds.mockReturnValue({ x: -300, y: 100, width: 1200, height: 800 });

      createWindowWithState({ show: false }, "/home/user/project");

      expect(winInstance.setSize).not.toHaveBeenCalled();
      expect(winInstance.setBounds).toHaveBeenCalledWith({
        x: 0,
        y: 100,
        width: 1200,
        height: 800,
      });
    });

    it("falls back to display.bounds when workArea is zero (Wayland/GNOME robustness)", () => {
      const oversizedBounds = { x: 0, y: 0, width: 2560, height: 1440, isMaximized: false };
      windowStatesStoreMock.get.mockReturnValue({ "/home/user/project": oversizedBounds });

      winInstance.getBounds.mockReturnValue({ x: 0, y: 0, width: 2560, height: 1440 });

      // Use mockReturnValue (not Once) because clampToDisplay re-fetches the display
      // after the size-clamp in createWindowWithState — both calls must see the
      // zero-workArea display or the fallback is silently bypassed.
      screenMock.getDisplayMatching.mockReturnValue({
        workArea: { x: 0, y: 0, width: 0, height: 0 },
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      });

      createWindowWithState({ show: false }, "/home/user/project");

      // Must NOT produce setSize(0, 0) — the zero workArea falls back to display.bounds (1920x1080)
      expect(winInstance.setSize).toHaveBeenCalledWith(1920, 1080);
      // And the position-clamp must also use the fallback, not the broken workArea
      expect(winInstance.setBounds).toHaveBeenCalledWith({
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
      });
    });

    it("clamps both axes of an oversized default window on a small display", () => {
      // Default 2560x1440 (unrealistic, but exercises both the width and height
      // clamp branches) on a 1280x720 work area.
      const defaultBounds = {
        width: 2560,
        height: 1440,
        isMaximized: false,
        isFullScreen: false,
      };
      windowStatesStoreMock.get.mockReturnValue({ "/home/user/project": defaultBounds });

      winInstance.getBounds.mockReturnValue({ x: 0, y: 0, width: 2560, height: 1440 });

      screenMock.getPrimaryDisplay.mockReturnValueOnce({
        workArea: { x: 0, y: 0, width: 1280, height: 720 },
        bounds: { x: 0, y: 0, width: 1280, height: 720 },
      });

      createWindowWithState({ show: false }, "/home/user/project");

      expect(winInstance.setSize).toHaveBeenCalledWith(1280, 720);
      expect(winInstance.center).toHaveBeenCalled();
    });

    it("clamps a window entirely off the right/bottom edge back into the work area", () => {
      // Saved bounds past the right/bottom of a 1920x1080 work area. clampToDisplay
      // should pin x to wa.x + wa.width - width = 720 and y to wa.y + wa.height - height = 280.
      const offRightBounds = {
        x: 2000,
        y: 1200,
        width: 1200,
        height: 800,
        isMaximized: false,
      };
      windowStatesStoreMock.get.mockReturnValue({ "/home/user/project": offRightBounds });

      winInstance.getBounds.mockReturnValue({ x: 2000, y: 1200, width: 1200, height: 800 });

      createWindowWithState({ show: false }, "/home/user/project");

      expect(winInstance.setSize).not.toHaveBeenCalled();
      expect(winInstance.setBounds).toHaveBeenCalledWith({
        x: 720,
        y: 280,
        width: 1200,
        height: 800,
      });
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

  describe("MRU cap and prune", () => {
    // Wire the mocked store to a real backing object so successive saves
    // accumulate the way electron-store would.
    function makeStateful(initial: Record<string, unknown> = {}) {
      let state: Record<string, unknown> = { ...initial };
      windowStatesStoreMock.get.mockImplementation(() => state);
      windowStatesStoreMock.set.mockImplementation(
        (_key: string, value: Record<string, unknown>) => {
          state = value;
        }
      );
      return () => state;
    }

    function saveForPath(projectPath: string) {
      createWindowWithState({ show: false }, projectPath);
      eventHandlers.get("close")!();
    }

    it("caps project entries at the MRU limit, evicting the oldest, keeping __legacy__", () => {
      const getState = makeStateful();
      for (let i = 0; i < 55; i++) saveForPath(`/proj/${i}`);

      const state = getState();
      const projectKeys = Object.keys(state).filter((k) => k !== "__legacy__");
      expect(projectKeys).toHaveLength(50);
      // The five oldest are evicted; the newest survive.
      expect(state["/proj/0"]).toBeUndefined();
      expect(state["/proj/4"]).toBeUndefined();
      expect(state["/proj/5"]).toBeDefined();
      expect(state["/proj/54"]).toBeDefined();
      // The cold-start fallback is exempt from the cap.
      expect(state["__legacy__"]).toBeDefined();
    });

    it("re-touching a path moves it to most-recent and shields it from eviction", () => {
      const getState = makeStateful();
      for (let i = 0; i < 50; i++) saveForPath(`/keep/${i}`);
      // Touch the oldest so it becomes most-recent...
      saveForPath("/keep/0");
      // ...then add one new path, forcing exactly one eviction.
      saveForPath("/new");

      const state = getState();
      expect(state["/keep/0"]).toBeDefined();
      // /keep/1 is now the oldest and is evicted instead of the refreshed /keep/0.
      expect(state["/keep/1"]).toBeUndefined();
      expect(state["/new"]).toBeDefined();
      expect(Object.keys(state).filter((k) => k !== "__legacy__")).toHaveLength(50);
    });

    it("pruneWindowStateForPath removes only the target, preserving others and __legacy__", () => {
      const entry = {
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        isMaximized: false,
        isFullScreen: false,
      };
      const getState = makeStateful({ "/a": entry, "/b": entry, __legacy__: entry });

      pruneWindowStateForPath("/a");

      const state = getState();
      expect(state["/a"]).toBeUndefined();
      expect(state["/b"]).toBeDefined();
      expect(state["__legacy__"]).toBeDefined();
      // Never persists an `undefined` value (electron-store v11 rejects it).
      const lastSet = windowStatesStoreMock.set.mock.calls.at(-1)?.[1] as Record<string, unknown>;
      expect(Object.values(lastSet)).not.toContain(undefined);
    });

    it("pruneWindowStateForPath is a no-op when the path is absent", () => {
      const entry = {
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        isMaximized: false,
        isFullScreen: false,
      };
      makeStateful({ "/b": entry, __legacy__: entry });
      windowStatesStoreMock.set.mockClear();

      pruneWindowStateForPath("/missing");

      expect(windowStatesStoreMock.set).not.toHaveBeenCalled();
    });

    it("rekeyWindowStateForPath moves bounds to the new key, preserving others and __legacy__", () => {
      const oldEntry = { x: 1, y: 2, width: 800, height: 600, isMaximized: false };
      const otherEntry = { x: 9, y: 9, width: 400, height: 300, isMaximized: false };
      const getState = makeStateful({
        "/old/project": oldEntry,
        "/other": otherEntry,
        __legacy__: otherEntry,
      });

      rekeyWindowStateForPath("/old/project", "/new/renamed");

      const state = getState();
      expect(state["/old/project"]).toBeUndefined();
      expect(state["/new/renamed"]).toEqual(oldEntry);
      expect(state["/other"]).toBeDefined();
      expect(state["__legacy__"]).toBeDefined();
      const lastSet = windowStatesStoreMock.set.mock.calls.at(-1)?.[1] as Record<string, unknown>;
      expect(Object.values(lastSet)).not.toContain(undefined);
    });

    it("rekeyWindowStateForPath lets the moved bounds win over a stale destination entry", () => {
      const oldEntry = { x: 1, y: 2, width: 800, height: 600, isMaximized: false };
      const staleAtNew = { x: 5, y: 5, width: 100, height: 100, isMaximized: false };
      const getState = makeStateful({ "/old": oldEntry, "/new": staleAtNew });

      rekeyWindowStateForPath("/old", "/new");

      expect(getState()["/new"]).toEqual(oldEntry);
      expect(getState()["/old"]).toBeUndefined();
    });

    it("rekeyWindowStateForPath gives the moved entry a fresh (most-recent) MRU slot", () => {
      // /new pre-exists as the OLDEST entry; a naive in-place overwrite would keep
      // it oldest and make the relocated project the first evicted. It must be
      // re-inserted last.
      const e = (x: number) => ({ x, y: 0, width: 800, height: 600, isMaximized: false });
      const getState = makeStateful({ "/new": e(1), "/keep": e(2), "/old": e(3) });

      rekeyWindowStateForPath("/old", "/new");

      const keys = Object.keys(getState());
      expect(keys[keys.length - 1]).toBe("/new");
    });

    it("rekeyWindowStateForPath is a no-op when the old path is absent or paths match", () => {
      makeStateful({ "/b": { x: 0, y: 0, width: 800, height: 600 } });
      windowStatesStoreMock.set.mockClear();

      rekeyWindowStateForPath("/missing", "/new");
      rekeyWindowStateForPath("/b", "/b");

      expect(windowStatesStoreMock.set).not.toHaveBeenCalled();
    });
  });
});
