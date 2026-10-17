import { spawn } from "node:child_process";
import path from "node:path";
import { shell } from "electron";
import { linuxDesktopAppEnv } from "../services/pty/EnvironmentFilter.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

/**
 * How long xdg-open may run before the open counts as launched. It normally
 * hands the file to the desktop and exits within milliseconds; one still
 * running this long is a fallback that runs the app in the foreground.
 */
export const XDG_OPEN_EXIT_WAIT_MS = 5_000;

// xdg-open(1)'s exit statuses.
const XDG_OPEN_FAILURES: Record<number, string> = {
  1: "xdg-open was given an invalid command line",
  2: "The file doesn't exist",
  3: "No tool for opening this file was found",
  4: "No application could open this file",
};

/**
 * Opens `target` in the desktop's default app. Resolves with an error message,
 * or "" when the opener accepted it: `shell.openPath`'s contract.
 *
 * On Linux it runs xdg-open itself. Electron 42's `shell.openPath` never
 * settles there (not for a missing file, not after the opened app exits), so
 * every caller awaiting it waited forever. xdg-open runs detached with no
 * stdio, so the opened app inherits none of Daintree's descriptors, and
 * without what Daintree's own launcher added to the environment. Success is
 * xdg-open's exit status 0, or xdg-open still running after
 * {@link XDG_OPEN_EXIT_WAIT_MS}, which counts as launched.
 */
export function openWithDefaultApp(target: string): Promise<string> {
  if (process.platform !== "linux") return shell.openPath(target);
  return runXdgOpen(target);
}

function runXdgOpen(target: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const env = linuxDesktopAppEnv();
    let settled = false;
    const settle = (error: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(error);
    };

    let child: ReturnType<typeof spawn>;
    try {
      // Absolute, so a relative path that starts with "-" can't read as an option.
      child = spawn("xdg-open", [path.posix.resolve(target)], {
        detached: true,
        stdio: "ignore",
        env,
      });
    } catch (err) {
      resolve(`Couldn't run xdg-open: ${formatErrorMessage(err, "spawn failed")}`);
      return;
    }
    const timer = setTimeout(() => {
      child.unref();
      settle("");
    }, XDG_OPEN_EXIT_WAIT_MS);

    child.once("error", (err: NodeJS.ErrnoException) => {
      settle(
        err.code === "ENOENT"
          ? "xdg-open isn't installed, so there's no default app to open this with"
          : `Couldn't run xdg-open: ${err.message}`
      );
    });
    child.once("exit", (code, signal) => {
      if (code === 0) settle("");
      else if (code !== null)
        settle(XDG_OPEN_FAILURES[code] ?? `xdg-open exited with status ${code}`);
      else settle(`xdg-open was stopped by ${signal}`);
    });
  });
}
