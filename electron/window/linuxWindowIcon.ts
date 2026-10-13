import path from "path";
import { app, nativeImage, type NativeImage } from "electron";

let cached: NativeImage | null | undefined;

/**
 * Daintree's icon file on Linux: `resources/icon.png` in packaged builds
 * (electron-builder.config.cjs `linux.extraResources`), the build source in dev.
 * macOS and Windows take their icon from the app bundle and get `undefined`.
 */
export function getLinuxAppIconPath(): string | undefined {
  if (process.platform !== "linux") return undefined;
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.join(app.getAppPath(), "build", "icon.png");
}

/**
 * The icon for Daintree's windows and native notifications on Linux. X11 window
 * managers outside GNOME (xfwm4, KWin, i3 bars) draw the title bar, taskbar and
 * Alt+Tab icon from the window's own `_NET_WM_ICON`, which Electron only sets
 * when the window is given an icon; without one they show a generic window.
 * Notification daemons likewise show a generic icon unless the notification
 * carries an image. Scaled down because the 1024px source would make a 4 MB X
 * property (and a 4 MB D-Bus message per notification).
 */
export function getLinuxWindowIcon(): NativeImage | undefined {
  const file = getLinuxAppIconPath();
  if (!file) return undefined;
  if (cached !== undefined) return cached ?? undefined;
  try {
    const image = nativeImage.createFromPath(file);
    cached = image.isEmpty() ? null : image.resize({ width: 256, height: 256, quality: "best" });
  } catch (error) {
    // A missing icon must never stop a window opening.
    console.warn("[MAIN] Linux window icon unavailable:", error);
    cached = null;
  }
  return cached ?? undefined;
}

/**
 * The window constructor's `icon` option, present only when there is an icon.
 * An `icon: undefined` key still reaches Electron's NativeImage converter, which
 * logs "Argument must be a file path or a NativeImage" for every window.
 */
export function getLinuxWindowIconOption(): { icon?: NativeImage } {
  const icon = getLinuxWindowIcon();
  return icon ? { icon } : {};
}
