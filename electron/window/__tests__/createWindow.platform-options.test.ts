import { afterEach, describe, expect, it } from "vitest";
import { getPlatformWindowOptions } from "../platformWindowOptions.js";
import {
  WINDOWS_CAPTION_SYMBOL_COLOR,
  WINDOWS_TITLEBAR_HEIGHT_PX,
} from "../../../shared/config/windowChrome.js";

/**
 * Platform-specific BrowserWindow constructor options (#7939).
 *
 * This exercises the production helper `createWindow.ts` actually calls. It
 * used to replicate the options object by hand, which silently drifted — the
 * replica still asserted a 36px overlay long after production moved to 48px
 * (#11766).
 */

const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
});

describe("platform BrowserWindow options (#7939)", () => {
  it("macOS gets hiddenInset titleBarStyle and trafficLightPosition, no autoHideMenuBar", () => {
    setPlatform("darwin");
    const opts = getPlatformWindowOptions("#1a1a1a");
    expect(opts.titleBarStyle).toBe("hiddenInset");
    expect(opts.trafficLightPosition).toEqual({ x: 12, y: 18 });
    expect(opts.acceptFirstMouse).toBe(true);
    expect(opts.autoHideMenuBar).toBeUndefined();
    expect(opts.titleBarOverlay).toBeUndefined();
  });

  it("Windows gets hidden titleBarStyle + titleBarOverlay + autoHideMenuBar: true", () => {
    setPlatform("win32");
    const opts = getPlatformWindowOptions("#1a1a1a");
    expect(opts.titleBarStyle).toBe("hidden");
    expect(opts.autoHideMenuBar).toBe(true);
    expect(opts.trafficLightPosition).toBeUndefined();
  });

  it("paints the caption strip with the window background it was created for", () => {
    setPlatform("win32");
    // The overlay has to start life matching the window it sits on; drift here
    // is the pale-rectangle bug from #11766 at first paint.
    expect(getPlatformWindowOptions("#1a1a1a").titleBarOverlay?.color).toBe("#1a1a1a");
    expect(getPlatformWindowOptions("#fbfbfb").titleBarOverlay?.color).toBe("#fbfbfb");
  });

  it("sizes and styles the overlay from the shared window-chrome constants", () => {
    setPlatform("win32");
    const overlay = getPlatformWindowOptions("#1a1a1a").titleBarOverlay;
    // Bound to the same source the renderer's inset reads, so the native strip
    // and the space reserved for it cannot disagree.
    expect(overlay?.height).toBe(WINDOWS_TITLEBAR_HEIGHT_PX);
    expect(overlay?.symbolColor).toBe(WINDOWS_CAPTION_SYMBOL_COLOR);
  });

  it("Linux gets autoHideMenuBar: true with no titleBarStyle override", () => {
    setPlatform("linux");
    const opts = getPlatformWindowOptions("#1a1a1a");
    expect(opts.autoHideMenuBar).toBe(true);
    expect(opts.titleBarStyle).toBeUndefined();
    expect(opts.titleBarOverlay).toBeUndefined();
    expect(opts.trafficLightPosition).toBeUndefined();
  });
});
