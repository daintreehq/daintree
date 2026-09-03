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
const webContentsDestroyListeners = new Map<
  number,
  { webContents: WebContents; listener: () => void }
>();

// App view tracking: maps BrowserWindow.id → the WebContentsView hosting the React app.
// When no app view is registered (Phase 1 compat), helpers fall back to win.webContents.
const windowToAppView = new Map<number, WebContentsView>();
const appViewDestroyListeners = new Map<
  number,
  {
    webContents: WebContents;
    windowId: number;
    view: WebContentsView;
    listener: () => void;
  }
>();

// Project view tracking: maps webContents.id → projectId for scoped IPC routing.
const viewToProject = new Map<number, string>();
const projectViewDestroyListeners = new Map<
  number,
  { webContents: WebContents; listener: () => void }
>();

// Cached (deactivated) project views. Two kinds of send skip these renderers:
// high-frequency replayable streams (log batches), because a CPU-throttled/
// frozen renderer has no backpressure and pushed messages pile up in its task
// queue; and visibility-scoped effects (sound triggers), where a cached view
// playing along is the bug itself (#12177). State broadcasts and cleanup
// commands must NOT consult this set: cached views have no replay path on warm
// reactivation (#9490).
const cachedViewWebContents = new Set<number>();

// Memoized getAllAppWebContents() result. broadcastToRenderer() calls it on
// every relayed event (terminal data/status/activity, events:push), but the
// recipient set only changes on view register/unregister/destroy — every
// mutation site of windowToAppView / viewToProject invalidates the cache.
let cachedAllAppWebContents: WebContents[] | null = null;

function invalidateAllAppWebContentsCache(): void {
  cachedAllAppWebContents = null;
}

function removeDestroyedListener(registration: {
  webContents: WebContents;
  listener: () => void;
}): void {
  try {
    registration.webContents.removeListener("destroyed", registration.listener);
  } catch {
    // Electron can throw if the WebContents is already torn down.
  }
}

/**
 * Register a webContents → BrowserWindow mapping.
 * Call this when creating a WebContentsView and attaching it to a BrowserWindow.
 * Also call for the BrowserWindow's own webContents (identity mapping).
 */
export function registerWebContents(webContents: WebContents, win: BrowserWindow): void {
  const wcId = webContents.id;
  webContentsToWindow.set(wcId, win);

  if (!webContentsDestroyListeners.has(wcId)) {
    const onDestroyed = () => {
      webContentsToWindow.delete(wcId);
      webContentsDestroyListeners.delete(wcId);
    };
    webContentsDestroyListeners.set(wcId, { webContents, listener: onDestroyed });
    webContents.once("destroyed", onDestroyed);
  }
}

/**
 * Unregister a webContents mapping.
 * Call when destroying a WebContentsView before its webContents fires 'destroyed'.
 */
export function unregisterWebContents(webContents: WebContents): void {
  const wcId = webContents.id;
  webContentsToWindow.delete(wcId);

  const registration = webContentsDestroyListeners.get(wcId);
  if (registration) {
    removeDestroyedListener(registration);
    webContentsDestroyListeners.delete(wcId);
  }
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
  invalidateAllAppWebContentsCache();
  windowToAppView.set(win.id, view);
  registerWebContents(view.webContents, win);

  const wcId = view.webContents.id;
  const existing = appViewDestroyListeners.get(wcId);
  if (existing && (existing.windowId !== win.id || existing.view !== view)) {
    removeDestroyedListener(existing);
    if (windowToAppView.get(existing.windowId) === existing.view) {
      windowToAppView.delete(existing.windowId);
    }
    appViewDestroyListeners.delete(wcId);
  }

  if (!appViewDestroyListeners.has(wcId)) {
    const onDestroyed = () => {
      appViewDestroyListeners.delete(wcId);
      // Only remove if this is still the registered app view (not replaced by a new one)
      if (windowToAppView.get(win.id) === view) {
        windowToAppView.delete(win.id);
      }
      invalidateAllAppWebContentsCache();
    };
    appViewDestroyListeners.set(wcId, {
      webContents: view.webContents,
      windowId: win.id,
      view,
      listener: onDestroyed,
    });
    view.webContents.once("destroyed", onDestroyed);
  }
}

/**
 * Unregister the app view for a window.
 */
export function unregisterAppView(win: BrowserWindow): void {
  const view = windowToAppView.get(win.id);
  if (view) {
    // Electron 41: view.webContents is undefined once the view is destroyed.
    if (view.webContents && !view.webContents.isDestroyed()) {
      unregisterWebContents(view.webContents);
    }
    windowToAppView.delete(win.id);
    invalidateAllAppWebContentsCache();
  }
}

/**
 * Get the app view's webContents for a BrowserWindow.
 * Falls back to win.webContents if no app view is registered (Phase 1 compat).
 */
export function getAppWebContents(win: BrowserWindow): WebContents {
  const view = windowToAppView.get(win.id);
  // Electron 41: view.webContents is undefined once the view is destroyed, but
  // the windowToAppView entry can linger until the `destroyed` event fires.
  // Guard the property and prune the stale entry so the fallback is reached.
  if (view) {
    if (view.webContents && !view.webContents.isDestroyed()) {
      return view.webContents;
    }
    windowToAppView.delete(win.id);
    invalidateAllAppWebContentsCache();
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
  if (cachedAllAppWebContents) return cachedAllAppWebContents;

  const seen = new Set<number>();
  const result: WebContents[] = [];

  // Active app view per window — typically the currently-visible project view.
  // Electron 41: view.webContents is undefined once the view is destroyed.
  for (const [winId, view] of windowToAppView) {
    if (view.webContents && !view.webContents.isDestroyed()) {
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
      cachedViewWebContents.delete(wcId);
    }
  }

  // Fallback: if nothing is registered, return all BrowserWindow webContents.
  // Never cached — new windows don't pass through any register* function, so
  // there is no invalidation hook for this branch.
  if (result.length === 0) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        result.push(win.webContents);
      }
    }
    return result;
  }

  cachedAllAppWebContents = result;
  return result;
}

// ── Project-scoped view tracking ──

/**
 * Associate a webContents with a projectId for scoped IPC routing.
 * Call when a view is created or switched to a project.
 */
export function registerProjectView(projectId: string, webContents: WebContents): void {
  const wcId = webContents.id;
  viewToProject.set(wcId, projectId);
  invalidateAllAppWebContentsCache();

  if (!projectViewDestroyListeners.has(wcId)) {
    const onDestroyed = () => {
      viewToProject.delete(wcId);
      cachedViewWebContents.delete(wcId);
      projectViewDestroyListeners.delete(wcId);
      invalidateAllAppWebContentsCache();
    };
    projectViewDestroyListeners.set(wcId, { webContents, listener: onDestroyed });
    webContents.once("destroyed", onDestroyed);
  }
}

/**
 * Remove a webContents → projectId mapping.
 */
export function unregisterProjectView(webContentsId: number): void {
  viewToProject.delete(webContentsId);
  cachedViewWebContents.delete(webContentsId);
  invalidateAllAppWebContentsCache();

  const registration = projectViewDestroyListeners.get(webContentsId);
  if (registration) {
    removeDestroyedListener(registration);
    projectViewDestroyListeners.delete(webContentsId);
  }
}

/**
 * Mark a project view's webContents as cached (deactivated). Maintained by
 * every ProjectViewManager instance, so the set spans all windows.
 */
export function registerCachedViewWebContents(webContents: WebContents): void {
  cachedViewWebContents.add(webContents.id);
}

/**
 * Clear the cached mark — call on reactivation. Idempotent.
 */
export function unregisterCachedViewWebContents(webContentsId: number): void {
  cachedViewWebContents.delete(webContentsId);
}

/**
 * Whether a webContents is a cached (deactivated) project view.
 */
export function isCachedViewWebContents(webContentsId: number): boolean {
  return cachedViewWebContents.has(webContentsId);
}

/**
 * Get the projectId associated with a webContents.
 */
export function getProjectForWebContents(webContentsId: number): string | null {
  return viewToProject.get(webContentsId) ?? null;
}

/**
 * Whether any project views are registered at all. Project-scoped broadcasts
 * fall back to a full broadcast when this is false (startup / windows that
 * don't route through ProjectViewManager).
 */
export function hasRegisteredProjectViews(): boolean {
  return viewToProject.size > 0;
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
      cachedViewWebContents.delete(wcId);
      invalidateAllAppWebContentsCache();
    }
  }
  return result;
}

/**
 * Every live project view paired with the project that owns it, across all
 * windows. Cached (deactivated) views are included — they keep a live renderer
 * process. Prunes stale entries like getWebContentsForProject().
 */
export function getRegisteredProjectViews(): Array<{
  webContents: WebContents;
  projectId: string;
}> {
  const result: Array<{ webContents: WebContents; projectId: string }> = [];
  for (const [wcId, projectId] of viewToProject) {
    const wc = webContentsModule.fromId(wcId);
    if (wc && !wc.isDestroyed()) {
      result.push({ webContents: wc, projectId });
    } else {
      // Full unregister, not a bare map delete: a view pruned here never fired
      // "destroyed", so its listener registration would retain the WebContents.
      unregisterProjectView(wcId);
    }
  }
  return result;
}
