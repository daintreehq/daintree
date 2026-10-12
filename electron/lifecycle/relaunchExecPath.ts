import { runningAppImage } from "../utils/appImage.js";

/**
 * Options for `app.relaunch()` that survive an AppImage. There, `process.execPath`
 * lives in the image's mount (or its extract-and-run copy), which the AppImage
 * runtime removes as this process exits — before Electron's relauncher starts the
 * new instance, so the restart would launch a path that no longer exists. Going
 * through the image itself (`$APPIMAGE`) mounts it afresh.
 *
 * Electron treats `execPath` as a full argv override, so the current arguments
 * are kept when the caller passes none. Only an APPIMAGE whose mount holds this
 * binary counts; one inherited from another app's terminal is ignored.
 */
export function withRelaunchExecPath(
  options: Electron.RelaunchOptions = {}
): Electron.RelaunchOptions {
  const appImage = process.platform === "linux" ? runningAppImage() : null;
  if (!appImage) return options;
  return { args: process.argv.slice(1), ...options, execPath: appImage };
}
