// eager-import-allow: wipes userData synchronously for --reset-data before the compile cache or Chromium touch it
// The slice of environment setup that bootstrap.ts runs before the compile
// cache is on and before the `--attach-stdio` dispatch. Everything it imports
// is parsed uncached, so it stays on Node built-ins, Electron and pure helpers.
// environment.ts calls the same helpers at its own positions; each runs once.
import fs from "fs";
import path from "path";
import { app, dialog } from "electron";
import { isAttachStdioRequested, HEADLESS_OZONE_SWITCH } from "../boot/hostModeLaunch.js";
import { installHeadlessDialogGuards } from "./headlessDialogs.js";

// Dead-fd errnos that must not propagate on GUI launch (AppImage/Wayland, no
// terminal). EPIPE is a closed pipe (e.g. user quits Terminal.app while
// Daintree runs); EIO is a disconnected pty (the primary errno for AppImage
// desktop launches where fd 2 points to an orphaned pty slave); EBADF is a
// closed fd; ECONNRESET is a socket-backed stdio reset. ENOSPC is
// intentionally NOT swallowed — it's a real error condition.
const STDIO_DEAD_CODES = new Set(["EPIPE", "EIO", "EBADF", "ECONNRESET"]);

let stdioGuardsInstalled = false;
let devUserDataPathApplied = false;
let resetDataHandled = false;

export function installStdioDeadFdGuards(): void {
  if (stdioGuardsInstalled) return;
  stdioGuardsInstalled = true;
  for (const stream of [process.stdout, process.stderr]) {
    if (stream && typeof stream.on === "function") {
      stream.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code && STDIO_DEAD_CODES.has(err.code)) return;
        throw err;
      });
    }
  }
}

// In development, use a separate userData directory so the dev instance
// doesn't conflict with the production app's single-instance lock or storage.
// Skip when --user-data-dir is explicitly set (e.g. E2E tests) so that
// each test run gets its own isolated data directory.
export function applyDevUserDataPath(): void {
  if (devUserDataPathApplied) return;
  devUserDataPathApplied = true;
  const hasExplicitUserDataDir = process.argv.some((a) => a.startsWith("--user-data-dir"));
  if (app.isPackaged || hasExplicitUserDataDir) return;
  const devUserDataDir = process.env.DAINTREE_DEV_USER_DATA_DIR?.trim();
  app.setPath(
    "userData",
    devUserDataDir && path.isAbsolute(devUserDataDir)
      ? devUserDataDir
      : path.join(app.getPath("appData"), "daintree-dev")
  );
}

// Handle --reset-data: wipe userData before Chromium acquires file locks, before
// the compile cache creates its directory there, and before anything reads the
// GPU flag files — otherwise a reset-while-disabled launch would carry the
// stale GPU flag forward by one cycle. Never called for `--attach-stdio`,
// which must not touch the running host's state.
export function resetUserDataIfRequested(): void {
  if (resetDataHandled) return;
  resetDataHandled = true;
  const shouldResetData =
    process.argv.includes("--reset-data") || process.env.DAINTREE_RESET_DATA === "1";
  if (!shouldResetData) return;
  const userDataPath = app.getPath("userData");
  if (!fs.existsSync(userDataPath)) return;
  for (const entry of fs.readdirSync(userDataPath)) {
    try {
      fs.rmSync(path.join(userDataPath, entry), { recursive: true, force: true });
    } catch {
      // Skip locked files
    }
  }
}

/**
 * A windowless Host (or its `--attach-stdio` bridge) on a box with no display
 * runs Chromium headless, with the GPU off since nothing is ever composited.
 * `hardwareAccelerationDisabled` says the crash fallback already turned it off.
 */
export function applyHeadlessOzoneSwitches(options: {
  hardwareAccelerationDisabled: boolean;
}): void {
  installHeadlessDialogGuards(dialog);
  app.commandLine.appendSwitch("ozone-platform", "headless");
  app.commandLine.appendSwitch("disable-gpu");
  if (!options.hardwareAccelerationDisabled) app.disableHardwareAcceleration();
  // `--attach-stdio`'s stdout is the link: its diagnostics go to stderr.
  (isAttachStdioRequested(process.argv) ? console.error : console.log)(
    process.argv.includes(HEADLESS_OZONE_SWITCH)
      ? "[GPU] Headless Host mode: ozone-platform=headless, GPU disabled"
      : `[GPU] No display server: start Host mode with ${HEADLESS_OZONE_SWITCH}, or Chromium aborts looking for X11`
  );
}
