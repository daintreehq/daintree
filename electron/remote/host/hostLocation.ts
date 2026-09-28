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
 * On macOS the socket lives in userData, so the bridge is told this host's:
 * one started with its own `--user-data-dir` (or a dev build's) is otherwise
 * looked for in the default profile and never found.
 */
export function hostLaunchCommand(): string[] | undefined {
  const userDataFlag =
    process.platform === "darwin" ? [`${USER_DATA_DIR_FLAG}${app.getPath("userData")}`] : [];
  if (app.isPackaged) return [process.execPath, ...userDataFlag];
  const appPath = typeof app.getAppPath === "function" ? app.getAppPath() : "";
  return appPath ? [process.execPath, appPath, ...userDataFlag] : undefined;
}

/** The one option a published launch command may carry besides paths. */
export const USER_DATA_DIR_FLAG = "--user-data-dir=";
