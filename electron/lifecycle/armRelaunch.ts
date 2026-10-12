import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { runningAppImage, stripAppDirPathLists } from "../utils/appImage.js";

/**
 * Closes every descriptor inherited from Daintree, waits for each listed
 * process to be gone, then runs the image. Run by bash from outside the image,
 * so it outlives the mount. A descriptor left open (the old mount's directory,
 * the crashpad socket) would keep the old image mounted and its crash handler
 * running for good, and pass on to the new instance. bash rather than sh: dash
 * can't close a fd above 9. Args: image, pids…, `--`, app args….
 */
export const WAIT_THEN_RUN_IMAGE = [
  'for fd in /proc/$$/fd/*; do fd=${fd##*/}; case $fd in 0|1|2) ;; *) eval "exec $fd>&-" 2>/dev/null ;; esac; done',
  "image=$1; shift",
  'while [ "$#" -gt 0 ] && [ "$1" != -- ]; do while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; shift; done; shift',
  'exec "$image" "$@"',
].join("; ");

function realpathOrNull(file: string): string | null {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

/**
 * The extract-and-run runtime, when it is this process's parent: it waits for
 * Daintree, then deletes the extraction the next run would reuse, so the
 * relaunch has to wait for it too. An update has already deleted or replaced
 * the image by the time it relaunches, which the kernel marks on the link.
 */
function extractionRuntimePid(appImage: string): number | null {
  try {
    const parentExe = fs.readlinkSync(`/proc/${process.ppid}/exe`).replace(/ \(deleted\)$/, "");
    return parentExe === appImage || parentExe === realpathOrNull(appImage) ? process.ppid : null;
  } catch {
    return null;
  }
}

/** Starts the waiter that runs `image` once this AppImage instance has exited. */
function spawnWaiter(
  runningImage: string,
  image: string,
  args: readonly string[],
  fallback: () => void
): void {
  const appDir = process.env.APPDIR as string;
  const env: NodeJS.ProcessEnv = { ...process.env };
  // AppRun prefixes these again on the next run; the old mount's entries would pile up.
  stripAppDirPathLists(env, appDir);
  const runtimePid = extractionRuntimePid(runningImage);
  // `--appimage-extract-and-run` is consumed by the runtime, so argv can't carry it.
  if (path.basename(appDir).startsWith("appimage_extracted_")) env.APPIMAGE_EXTRACT_AND_RUN = "1";

  const pids = [process.pid, ...(runtimePid ? [runtimePid] : [])].map(String);
  const waiter = spawn(
    "/bin/bash",
    ["-c", WAIT_THEN_RUN_IMAGE, "daintree-relaunch", image, ...pids, "--", ...args],
    { detached: true, stdio: "ignore", env }
  );
  waiter.on("error", (error) => {
    console.error("[MAIN] Couldn't arm the AppImage relaunch:", error);
    fallback();
  });
  waiter.unref();
}

/**
 * `app.relaunch()` that also works from an AppImage. Electron's relauncher is a
 * helper process running this executable, which in an AppImage lives in the
 * image's mount (or its extract-and-run copy); the runtime removes that as the
 * app exits, and the helper goes with it before it starts the new instance —
 * a restart from the AppImage quit and never came back. There, a detached
 * shell outside the image waits for this process to exit and runs the image
 * itself, which mounts it afresh. Like `app.relaunch()`, it takes effect when
 * the app exits; the current args are kept when the caller passes none. Only
 * an APPIMAGE whose mount holds this binary counts.
 */
export function armRelaunch(options: Electron.RelaunchOptions = {}): void {
  const appImage = process.platform === "linux" ? runningAppImage() : null;
  if (!appImage) {
    app.relaunch(options);
    return;
  }
  // No bash: Electron's relaunch is the only option left, even if it may not come back.
  spawnWaiter(appImage, appImage, options.args ?? process.argv.slice(1), () =>
    app.relaunch(options)
  );
}

/**
 * Runs `image`, the AppImage an update has just put in place (possibly under a
 * new name), once this instance has exited, through the same waiter as
 * `armRelaunch`. False, arming nothing, when this process wasn't started from
 * an AppImage. `fallback` runs if the waiter can't start.
 */
export function armAppImageRelaunch(
  image: string,
  args: readonly string[],
  fallback: () => void
): boolean {
  const appImage = process.platform === "linux" ? runningAppImage() : null;
  if (!appImage) return false;
  spawnWaiter(appImage, image, args, fallback);
  return true;
}
