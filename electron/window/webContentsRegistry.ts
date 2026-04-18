/**
 * WebContents → BrowserWindow registry.
 *
 * BrowserWindow.fromWebContents() returns null for WebContentsView's webContents.
 * This registry provides a consistent lookup that works for both BrowserWindow-owned
 * webContents and WebContentsView webContents.
 *
 * Phase 1 of the WebContentsView migration: all IPC handlers use this instead of
 * BrowserWindow.fromWebContents() directly, so Phase 2 can move the app into a
 * WebContentsView without breaking 30+ IPC handlers.
 */

import {
  BrowserWindow,
  WebContentsView,
  webContents as webContentsModule,
  type WebContents,
} from "electron";

const webContentsToWindow = new Map<number, BrowserWindow>();

// App view tracking: maps BrowserWindow.id → the WebContentsView hosting the React app.
// When no app view is registered (Phase 1 compat), helpers fall back to win.webContents.
const windowToAppView = new Map<number, WebContentsView>();

// Project view tracking: maps webContents.id → projectId for scoped IPC routing.
const viewToProject = new Map<number, string>();

/**
 * Register a webContents → BrowserWindow mapping.
 * Call this when creating a WebContentsView and attaching it to a BrowserWindow.
 * Also call for the BrowserWindow's own webContents (identity mapping).
 */
export function registerWebContents(webContents: WebContents, win: BrowserWindow): void {
  webContentsToWindow.set(webContents.id, win);

  webContents.once("destroyed", () => {
    webContentsToWindow.delete(webContents.id);
  });
}

/**
 * Unregister a webContents mapping.
 * Call when destroying a WebContentsView before its webContents fires 'destroyed'.
 */
export function unregisterWebContents(webContents: WebContents): void {
  webContentsToWindow.delete(webContents.id);
}

/**
 * Get the BrowserWindow that owns a webContents.
 * First tries BrowserWindow.fromWebContents() (works for BrowserWindow-owned webContents),
 * then falls back to the registry (works for WebContentsView webContents).
 */
export function getWindowForWebContents(webContents: WebContents): BrowserWindow | null {
  // Fast path: native lookup works for BrowserWindow-owned webContents.
  // Guarded because test environments frequently stub BrowserWindow without
  // the static fromWebContents helper.
  if (typeof BrowserWindow.fromWebContents === "function") {
    const native = BrowserWindow.fromWebContents(webContents);
    if (native) return native;
  }

  // Fallback: registry lookup for WebContentsView webContents
  const registered = webContentsToWindow.get(webContents.id);
  if (registered && !registered.isDestroyed()) return registered;

  return null;
}

/**
 * Register the "app view" — the WebContentsView that hosts the React app — for a window.
 * Also registers its webContents in the main registry so getWindowForWebContents() works.
 */
export function registerAppView(win: BrowserWindow, view: WebContentsView): void {
  windowToAppView.set(win.id, view);
  registerWebContents(view.webContents, win);

  view.webContents.once("destroyed", () => {
    // Only remove if this is still the registered app view (not replaced by a new one)
    if (windowToAppView.get(win.id) === view) {
      windowToAppView.delete(win.id);
    }
  });
}

/**
 * Unregister the app view for a window.
 */
export function unregisterAppView(win: BrowserWindow): void {
  const view = windowToAppView.get(win.id);
  if (view) {
    if (!view.webContents.isDestroyed()) {
      unregisterWebContents(view.webContents);
    }
    windowToAppView.delete(win.id);
  }
}

/**
 * Get the app view's webContents for a BrowserWindow.
 * Falls back to win.webContents if no app view is registered (Phase 1 compat).
 */
export function getAppWebContents(win: BrowserWindow): WebContents {
  const view = windowToAppView.get(win.id);
  if (view && !view.webContents.isDestroyed()) {
    return view.webContents;
  }
  return win.webContents;
}

/**
 * Get the WebContentsView hosting the React app for a window, or null.
 */
export function getAppView(win: BrowserWindow): WebContentsView | null {
  return windowToAppView.get(win.id) ?? null;
}

/**
 * Get all registered app view webContents (for broadcasting).
 */
export function getAllAppWebContents(): WebContents[] {
  const seen = new Set<number>();
  const result: WebContents[] = [];

  // Active app view per window — typically the currently-visible project view.
  for (const [winId, view] of windowToAppView) {
    if (!view.webContents.isDestroyed()) {
      if (!seen.has(view.webContents.id)) {
        seen.add(view.webContents.id);
        result.push(view.webContents);
      }
    } else {
      windowToAppView.delete(winId);
    }
  }

  // Also include any cached project views (rendered but currently inactive)
  // so cross-renderer broadcasts (project added/updated/removed, etc.) reach
  // every renderer that has cached project state, not just the visible one.
  for (const [wcId, _projectId] of viewToProject) {
    if (seen.has(wcId)) continue;
    const wc = webContentsModule.fromId(wcId);
    if (wc && !wc.isDestroyed()) {
      seen.add(wcId);
      result.push(wc);
    } else {
      viewToProject.delete(wcId);
    }
  }

  // Fallback: if nothing is registered, return all BrowserWindow webContents
  if (result.length === 0) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        result.push(win.webContents);
      }
    }
  }
  return result;
}

// ── Project-scoped view tracking ──

/**
 * Associate a webContents with a projectId for scoped IPC routing.
 * Call when a view is created or switched to a project.
 */
export function registerProjectView(projectId: string, webContents: WebContents): void {
  viewToProject.set(webContents.id, projectId);
  webContents.once("destroyed", () => {
    viewToProject.delete(webContents.id);
  });
}

/**
 * Remove a webContents → projectId mapping.
 */
export function unregisterProjectView(webContentsId: number): void {
  viewToProject.delete(webContentsId);
}

/**
 * Get the projectId associated with a webContents.
 */
export function getProjectForWebContents(webContentsId: number): string | null {
  return viewToProject.get(webContentsId) ?? null;
}

/**
 * Get all non-destroyed webContents for a given projectId.
 * Used for project-scoped IPC broadcasts.
 */
export function getWebContentsForProject(projectId: string): WebContents[] {
  const result: WebContents[] = [];
  for (const [wcId, pid] of viewToProject) {
    if (pid !== projectId) continue;
    const wc = webContentsModule.fromId(wcId);
    if (wc && !wc.isDestroyed()) {
      result.push(wc);
    } else {
      viewToProject.delete(wcId);
    }
  }
  return result;
}
