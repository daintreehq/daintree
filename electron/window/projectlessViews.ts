import type { BrowserWindow, WebContents } from "electron";

/**
 * The windows that hold no project, each by its one app view. Their view hears
 * what every view hears, but a project's push, a project open and a
 * single-listener effect all look past it. It stands alone, importing nothing,
 * so the broadcast helpers can ask without knowing who made the window.
 */
const projectlessViews = new Map<number, BrowserWindow>();

/** Mark a window's only view as belonging to no project, for as long as it lives. */
export function markProjectlessView(webContents: WebContents, win: BrowserWindow): void {
  const webContentsId = webContents.id;
  projectlessViews.set(webContentsId, win);
  webContents.once("destroyed", () => projectlessViews.delete(webContentsId));
}

export function isProjectlessAppView(webContentsId: number): boolean {
  return projectlessViews.has(webContentsId);
}

export function isProjectlessWindow(win: BrowserWindow): boolean {
  for (const held of projectlessViews.values()) if (held === win) return true;
  return false;
}

/** The windows no project lives in, which the window registry never lists. */
export function getProjectlessWindows(): BrowserWindow[] {
  return [...projectlessViews.values()].filter((win) => !win.isDestroyed());
}
