import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getMinimumWindowSize, getPlatformWindowOptions } from "../platformWindowOptions.js";
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

describe("createWindow wires the overlay owner — issue #11766", () => {
  it("seeds the resolved scheme so the first banner report has tokens to blend", async () => {
    // Without the seed, `setTitleBarOverlayBannerSeverity` silently no-ops
    // until some later theme event happens to supply tokens — a failure mode
    // no unit test of the overlay module itself can see, because those seed
    // their own mock windows.
    const source = await fs.readFile(path.resolve(__dirname, "../createWindow.ts"), "utf-8");
    expect(source).toContain("seedTitleBarOverlay(win, scheme.tokens)");
    expect(source).toContain("getPlatformWindowOptions(windowBg)");
    // The seeded tokens must be the same object the constructor colour came
    // from, or the recorded "already applied" colour would be a lie.
    expect(source).toContain('const windowBg = scheme.tokens["surface-canvas"]');
  });
});

describe("every app view hands Cmd+W to its renderer — issue #16618", () => {
  // The Canopy window used to leave Cmd+W to Close Window, so its agent pane
  // could never take it. Its renderer now decides, through the one gate every
  // app view uses (appViewKeyGate.test.ts drives it), with no window kind exempt.
  const read = (file: string) => fs.readFile(path.resolve(__dirname, file), "utf-8");

  it.each(["../createWindow.ts", "../ProjectViewHandlers.ts"])(
    "%s keeps keys from the menu only through gateAppViewKey",
    async (file) => {
      const source = await read(file);
      expect(source).not.toContain("setIgnoreMenuShortcuts");
      expect(source.match(/gateAppViewKey\(/g)).toHaveLength(1);
    }
  );

  it("createWindow gates the app view of every window kind, the Canopy window's included", async () => {
    const source = await read("../createWindow.ts");
    const at = source.indexOf('appWebContents.on("before-input-event"');
    expect(at).toBeGreaterThan(-1);
    // At the setup function's top level, not under a branch on the window's kind.
    expect(source.slice(source.lastIndexOf("\n", at) + 1, at)).toBe("  ");
    const handler = source.slice(at, source.indexOf(");", at));
    expect(handler).toMatch(/=>\s*gateAppViewKey\(appWebContents, event, input\)\s*$/);
  });
});

describe("minimum window size", () => {
  it("lets a Linux tiling window manager's narrow tile fit, instead of clipping an 800px layout", () => {
    expect(getMinimumWindowSize("linux")).toEqual({ minWidth: 400, minHeight: 300 });
  });

  it("keeps 800x600 where the window manager honours a minimum", () => {
    expect(getMinimumWindowSize("darwin")).toEqual({ minWidth: 800, minHeight: 600 });
    expect(getMinimumWindowSize("win32")).toEqual({ minWidth: 800, minHeight: 600 });
  });
});
