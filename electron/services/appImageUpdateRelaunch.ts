import path from "node:path";
import { armAppImageRelaunch } from "../lifecycle/armRelaunch.js";
import { runningAppImage } from "../utils/appImage.js";

type SpawnLog = (cmd: string, args?: string[], env?: unknown, stdio?: unknown) => Promise<boolean>;

/**
 * Runs `install` (electron-updater's `quitAndInstall`) with AppImageUpdater's
 * launch of the new image handed to the relaunch waiter.
 *
 * AppImageUpdater.doInstall deletes the running image, moves the download
 * beside it with `mv -f` (under the update's own name when the old name
 * carried a version), emits `appimage-filename-updated`, and on the
 * run-after-install path `quitAndInstall()` takes ends with
 * `spawnLog(destination, [], env)`: the new instance started straight from
 * this one. It inherited every descriptor Daintree holds without close-on-exec
 * (the old mount's directory, cache files, the crashpad socket) and the
 * environment AppRun prefixed with the old AppDir, so the old image stayed
 * mounted, and its runtime and crash handler running, for as long as the new
 * instance ran. It also started while this one still held the single-instance
 * lock.
 *
 * That spawn is the install's last step, reached only once the move has
 * succeeded, so the destination it names is complete; an install that fails
 * throws or returns before it and arms nothing. The waiter runs that file once
 * this process has exited. Anything else, and every other platform or
 * package, goes through untouched.
 */
export function routeAppImageRelaunchThroughWaiter<T>(updater: object, install: () => T): T {
  const runningImage = process.platform === "linux" ? runningAppImage() : null;
  const target = updater as { spawnLog?: SpawnLog };
  const original = target.spawnLog;
  if (!runningImage || typeof original !== "function") return install();

  const hadOwn = Object.hasOwn(target, "spawnLog");
  target.spawnLog = (cmd, args = [], env, stdio) => {
    const spawnDirectly = () => original.call(target, cmd, args, env, stdio);
    // The updater puts the new image in the running one's directory.
    if (path.isAbsolute(cmd) && path.dirname(cmd) === path.dirname(runningImage)) {
      const armed = armAppImageRelaunch(cmd, args, () => {
        spawnDirectly().catch((error: unknown) => {
          console.error("[MAIN] Couldn't start the updated AppImage:", error);
        });
      });
      if (armed) return Promise.resolve(true);
    }
    return spawnDirectly();
  };
  try {
    return install();
  } finally {
    if (hadOwn) target.spawnLog = original;
    else delete target.spawnLog;
  }
}
