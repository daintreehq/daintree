import { app, BrowserWindow } from "electron";
import { getActiveShutdown } from "./shutdownCoordinator.js";

// Set when the user answers the quit warning with Keep Agents Running, until a
// window is on screen again. The process then stays up with no window on every
// platform, as it does for a Host, so the PTY host and every agent in it keep
// going; closing the last window after that decides afresh.
let keepingAgentsRunning = false;
// Each choice is its own cycle, so a window left over from an earlier one that
// shows late can't end this one.
let cycle = 0;
let stopWatchingForWindow: (() => void) | null = null;

export function isKeepingAgentsRunning(): boolean {
  return keepingAgentsRunning;
}

/** Whether a window is on screen for Keep Agents Running to close. */
export function hasOpenWindows(): boolean {
  return BrowserWindow.getAllWindows().some((win) => !win.isDestroyed());
}

export interface KeepAgentsRunningDeps {
  /** Pins the open-window manifest at the set on screen now, before any of it closes. */
  holdOpenWindows: () => void;
  /**
   * Called when a window is on screen again, by which time a restore has
   * already read the set the manifest was pinned at.
   */
  releaseOpenWindows: () => void;
  /** Makes the next request to see the app bring that set back. */
  armReopen: () => void;
}

/**
 * Close every window and leave the process running. Nothing is torn down: the
 * agents' terminals live in the PTY host, which only the shutdown chain stops,
 * and a project window that opens again reconnects to them.
 */
export function keepAgentsRunningWithoutWindows(deps: KeepAgentsRunningDeps): boolean {
  if (getActiveShutdown() !== null) return false;
  // Before any window closes: off macOS the last one closing would otherwise
  // quit, or ask again.
  keepingAgentsRunning = true;
  cycle += 1;
  const thisCycle = cycle;
  deps.holdOpenWindows();
  deps.armReopen();
  stopWatchingForWindow?.();
  const onWindowShown = (): void => {
    if (thisCycle !== cycle || !keepingAgentsRunning) return;
    keepingAgentsRunning = false;
    stopWatchingForWindow?.();
    deps.releaseOpenWindows();
  };
  // Only a window the user can see means they are back: a hidden one, such
  // as a plugin's PDF render, comes and goes on its own.
  const onWindowCreated = (_event: unknown, win: BrowserWindow): void => {
    if (win.isVisible()) onWindowShown();
    else win.once("show", onWindowShown);
  };
  app.on("browser-window-created", onWindowCreated);
  stopWatchingForWindow = () => {
    app.off("browser-window-created", onWindowCreated);
    stopWatchingForWindow = null;
  };
  // close(), not destroy(): each window goes through its own close handling.
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.close();
  }
  return true;
}

/** Test-only: the module state outlives tests that don't reset modules. */
export function resetBackgroundAgentsForTests(): void {
  stopWatchingForWindow?.();
  keepingAgentsRunning = false;
}
