import path from "path";
import { app, nativeImage, type NativeImage } from "electron";

let cached: NativeImage | null | undefined;

/**
 * The icon for Daintree's windows on Linux. X11 window managers outside GNOME
 * (xfwm4, KWin, i3 bars) draw the title bar, taskbar and Alt+Tab icon from the
 * window's own `_NET_WM_ICON`, which Electron only sets when the window is given
 * an icon; without one they show a generic window. Packaged builds ship it as
 * `resources/icon.png` (electron-builder.config.cjs `linux.extraResources`). Scaled
 * down because the 1024px source would make a 4 MB X property.
 */
export function getLinuxWindowIcon(): NativeImage | undefined {
  if (process.platform !== "linux") return undefined;
  if (cached !== undefined) return cached ?? undefined;
  try {
    const file = app.isPackaged
      ? path.join(process.resourcesPath, "icon.png")
      : path.join(app.getAppPath(), "build", "icon.png");
    const image = nativeImage.createFromPath(file);
    cached = image.isEmpty() ? null : image.resize({ width: 256, height: 256, quality: "best" });
  } catch (error) {
    // A missing icon must never stop a window opening.
    console.warn("[MAIN] Linux window icon unavailable:", error);
    cached = null;
  }
  return cached ?? undefined;
}
