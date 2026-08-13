import {
  WINDOWS_CAPTION_SYMBOL_COLOR,
  WINDOWS_TITLEBAR_HEIGHT_PX,
} from "../../shared/config/windowChrome.js";

export interface PlatformWindowOptions {
  titleBarStyle?: "hidden" | "hiddenInset";
  titleBarOverlay?: { color: string; symbolColor: string; height: number };
  trafficLightPosition?: { x: number; y: number };
  acceptFirstMouse?: boolean;
  autoHideMenuBar?: boolean;
}

/**
 * Platform-specific slice of the main BrowserWindow's constructor options.
 *
 * Lives in its own module (rather than inline in `createWindow.ts`) so tests
 * can exercise the real branching without pulling in Electron and the whole
 * window-creation graph — the previous hand-maintained replica had already
 * drifted from production (36px vs 48px overlay height).
 */
export function getPlatformWindowOptions(windowBg: string): PlatformWindowOptions {
  if (process.platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 18 },
      // Deliver the window-activating click to the content instead of
      // swallowing it (macOS default), so clicking a panel in an inactive
      // window focuses that panel. Propagates to all child WebContentsViews.
      // Matches VS Code (clickThroughInactive) and iTerm2.
      acceptFirstMouse: true,
    };
  }

  if (process.platform === "win32") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: windowBg,
        symbolColor: WINDOWS_CAPTION_SYMBOL_COLOR,
        height: WINDOWS_TITLEBAR_HEIGHT_PX,
      },
      // Hide the native menu bar so the custom toolbar is the only chrome; Alt
      // still reveals the menu. Must be set in the constructor — calling
      // setAutoHideMenuBar after creation can cause Window Controls Overlay
      // layout shifts.
      autoHideMenuBar: true,
    };
  }

  return { autoHideMenuBar: true };
}
