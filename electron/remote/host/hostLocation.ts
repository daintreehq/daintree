import { app } from "electron";
import { hostSocketLocation, type HostSocketLocation } from "./hostSocketPath.js";

/**
 * Where this build's Host mode listens and publishes its discovery file.
 * Kept apart from the listener so `--attach-stdio` can find a running host
 * without loading any of it.
 */
export function hostLocation(): HostSocketLocation {
  if (process.platform === "darwin") {
    return hostSocketLocation({ platform: "darwin", userDataDir: app.getPath("userData") });
  }
  return hostSocketLocation({
    platform: "linux",
    uid: process.getuid!(),
    // Dev and packaged builds must not fight over one socket.
    dirName: app.isPackaged ? "daintree" : "daintree-dev",
  });
}

/**
 * The argv that runs this build again: the executable, plus the app folder
 * when unpackaged (a bare Electron binary would open its default app).
 * Published in the discovery file so a Shell can start `--attach-stdio` here.
 */
export function hostLaunchCommand(): string[] | undefined {
  if (app.isPackaged) return [process.execPath];
  const appPath = typeof app.getAppPath === "function" ? app.getAppPath() : "";
  return appPath ? [process.execPath, appPath] : undefined;
}
