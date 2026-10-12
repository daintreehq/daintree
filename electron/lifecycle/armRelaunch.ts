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

/**
 * The extract-and-run runtime, when it is this process's parent: it waits for
 * Daintree, then deletes the extraction the next run would reuse, so the
 * relaunch has to wait for it too.
 */
function extractionRuntimePid(appImage: string): number | null {
  try {
    const parentExe = fs.realpathSync(`/proc/${process.ppid}/exe`);
    return parentExe === fs.realpathSync(appImage) ? process.ppid : null;
  } catch {
    return null;
  }
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
  const appDir = process.env.APPDIR as string;
  const env: NodeJS.ProcessEnv = { ...process.env };
  // AppRun prefixes these again on the next run; the old mount's entries would pile up.
  stripAppDirPathLists(env, appDir);
  const runtimePid = extractionRuntimePid(appImage);
  // `--appimage-extract-and-run` is consumed by the runtime, so argv can't carry it.
  if (path.basename(appDir).startsWith("appimage_extracted_")) env.APPIMAGE_EXTRACT_AND_RUN = "1";

  const pids = [process.pid, ...(runtimePid ? [runtimePid] : [])].map(String);
  const args = options.args ?? process.argv.slice(1);
  const waiter = spawn(
    "/bin/bash",
    ["-c", WAIT_THEN_RUN_IMAGE, "daintree-relaunch", appImage, ...pids, "--", ...args],
    { detached: true, stdio: "ignore", env }
  );
  waiter.on("error", (error) => {
    // No bash: Electron's relaunch is the only option left, even if it may not come back.
    console.error("[MAIN] Couldn't arm the AppImage relaunch, using Electron's:", error);
    app.relaunch(options);
  });
  waiter.unref();
}
