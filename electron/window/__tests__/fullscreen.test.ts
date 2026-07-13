import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toggleWindowFullscreen } from "../fullscreen.js";

function createTarget(state: { simple?: boolean; native?: boolean } = {}) {
  let simple = state.simple ?? false;
  let native = state.native ?? false;
  return {
    isSimpleFullScreen: vi.fn(() => simple),
    setSimpleFullScreen: vi.fn((value: boolean) => {
      simple = value;
    }),
    isFullScreen: vi.fn(() => native),
    setFullScreen: vi.fn((value: boolean) => {
      native = value;
    }),
  };
}

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

describe("toggleWindowFullscreen", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  describe("on macOS", () => {
    beforeEach(() => {
      setPlatform("darwin");
    });

    it("enters simple fullscreen from a windowed window", () => {
      const win = createTarget();

      expect(toggleWindowFullscreen(win)).toBe(true);
      expect(win.setSimpleFullScreen).toHaveBeenCalledWith(true);
      expect(win.setFullScreen).not.toHaveBeenCalled();
    });

    it("leaves simple fullscreen when simple fullscreen is active", () => {
      const win = createTarget({ simple: true });

      expect(toggleWindowFullscreen(win)).toBe(false);
      expect(win.setSimpleFullScreen).toHaveBeenCalledWith(false);
      expect(win.setFullScreen).not.toHaveBeenCalled();
    });

    it("round-trips windowed → simple fullscreen → windowed", () => {
      const win = createTarget();

      expect(toggleWindowFullscreen(win)).toBe(true);
      expect(toggleWindowFullscreen(win)).toBe(false);
      expect(win.setSimpleFullScreen).toHaveBeenNthCalledWith(1, true);
      expect(win.setSimpleFullScreen).toHaveBeenNthCalledWith(2, false);
    });

    // A macOS window reaches native fullscreen via the green traffic-light button,
    // and restoreWindowState reopens a saved-fullscreen window with setFullScreen(true).
    // Toggling out of that must exit native rather than stack simple fullscreen on top.
    it("leaves native fullscreen instead of stacking simple fullscreen on top", () => {
      const win = createTarget({ native: true });

      expect(toggleWindowFullscreen(win)).toBe(false);
      expect(win.setFullScreen).toHaveBeenCalledWith(false);
      expect(win.setSimpleFullScreen).not.toHaveBeenCalled();
    });

    it("exits simple fullscreen without touching native fullscreen when both report active", () => {
      const win = createTarget({ simple: true, native: true });

      expect(toggleWindowFullscreen(win)).toBe(false);
      expect(win.setSimpleFullScreen).toHaveBeenCalledWith(false);
      expect(win.setFullScreen).not.toHaveBeenCalled();
    });
  });

  describe.each(["win32", "linux"] as const)("on %s", (platform) => {
    beforeEach(() => {
      setPlatform(platform);
    });

    it("enters native fullscreen from a windowed window", () => {
      const win = createTarget();

      expect(toggleWindowFullscreen(win)).toBe(true);
      expect(win.setFullScreen).toHaveBeenCalledWith(true);
    });

    it("leaves native fullscreen when native fullscreen is active", () => {
      const win = createTarget({ native: true });

      expect(toggleWindowFullscreen(win)).toBe(false);
      expect(win.setFullScreen).toHaveBeenCalledWith(false);
    });

    it("never calls the macOS-only simple fullscreen APIs", () => {
      const win = createTarget();

      toggleWindowFullscreen(win);
      toggleWindowFullscreen(win);

      expect(win.setSimpleFullScreen).not.toHaveBeenCalled();
      expect(win.isSimpleFullScreen).not.toHaveBeenCalled();
    });
  });

  it("reads process.platform per call rather than capturing it at module load", () => {
    const mac = createTarget();
    setPlatform("darwin");
    toggleWindowFullscreen(mac);

    const win32 = createTarget();
    setPlatform("win32");
    toggleWindowFullscreen(win32);

    expect(mac.setSimpleFullScreen).toHaveBeenCalledWith(true);
    expect(win32.setFullScreen).toHaveBeenCalledWith(true);
    expect(win32.setSimpleFullScreen).not.toHaveBeenCalled();
  });
});
