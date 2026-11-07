import type { BrowserWindow } from "electron";
import type { CreateWindowResult } from "./createWindow.js";

const CANOPY_WINDOW_TITLE = "Canopy";

type CanopyBrowserWindowFactory = () => Pick<CreateWindowResult, "win" | "loadRenderer">;

let createBrowserWindow: CanopyBrowserWindowFactory | null = null;
let canopyWindow: BrowserWindow | null = null;
let stopWatchingMode: (() => void) | null = null;

/** Set at boot, which holds the preload's path; handed in so IPC needn't import window setup. */
export function setCanopyBrowserWindowFactory(create: CanopyBrowserWindowFactory): void {
  createBrowserWindow = create;
}

function liveCanopyWindow(): BrowserWindow | null {
  return canopyWindow && !canopyWindow.isDestroyed() ? canopyWindow : null;
}

/** Bring the window forward, if there is one. False means there is none. */
export function focusCanopyWindow(): boolean {
  const win = liveCanopyWindow();
  if (!win) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return true;
}

export function closeCanopyWindow(): void {
  liveCanopyWindow()?.close();
}

/**
 * Open the one Canopy window, or bring it forward. Never registered with the
 * window registry, which is how it stays out of everything that picks a window
 * for a project: an open, a restore, the manifest, a project-scoped action.
 *
 * `watchMode` is told to close the window when Canopy stops being on, and
 * returns how to stop watching; it runs for as long as the window stands.
 */
export function openCanopyWindow(watchMode: (close: () => void) => () => void): void {
  if (focusCanopyWindow()) return;
  if (!createBrowserWindow) throw new Error("The Canopy window opened before the app set it up");

  const { win, loadRenderer } = createBrowserWindow();
  canopyWindow = win;
  win.setTitle(CANOPY_WINDOW_TITLE);
  // The page's own <title> would otherwise replace it on load.
  win.on("page-title-updated", (event) => event.preventDefault());
  stopWatchingMode = watchMode(closeCanopyWindow);
  win.once("closed", () => {
    stopWatchingMode?.();
    stopWatchingMode = null;
    if (canopyWindow === win) canopyWindow = null;
  });
  loadRenderer("canopy window");
}
