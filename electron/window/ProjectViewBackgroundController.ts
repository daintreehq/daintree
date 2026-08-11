import type { WebContentsView } from "electron";
import {
  registerCachedViewWebContents,
  registerProjectView,
  registerWebContents,
} from "./webContentsRegistry.js";
import { createView, loadView } from "./ProjectViewFactory.js";
import { cleanupEntry, deactivateEntry } from "./ProjectViewLifecycleController.js";
import { setupViewHandlers } from "./ProjectViewHandlers.js";
import { evictStaleViews } from "./ProjectViewEvictionController.js";
import type { ProjectViewManager } from "./ProjectViewManager.js";
import type { ViewEntry } from "./ProjectViewManagerTypes.js";

export interface BackgroundViewResult {
  view: WebContentsView;
  isNew: boolean;
}

export async function ensureBackgroundView(
  host: ProjectViewManager,
  projectId: string,
  projectPath: string,
  signal?: AbortSignal
): Promise<BackgroundViewResult> {
  if (host.disposed) throw new Error("Cannot materialize view — manager is disposed");
  if (host.win.isDestroyed()) throw new Error("Cannot materialize view — window is destroyed");
  if (signal?.aborted) throw new Error("Background view materialization cancelled");

  const existing = host.views.get(projectId);
  if (existing && !existing.view.webContents.isDestroyed()) {
    existing.lastUsed = Date.now();
    return { view: existing.view, isNew: false };
  }
  if (existing) cleanupEntry(host, projectId);

  const view = createView(host, projectId);
  const entry: ViewEntry = {
    view,
    projectId,
    projectPath,
    lastUsed: Date.now(),
    state: "loading",
    crashTimestamps: [],
    cleanupHandlers: () => {},
  };
  host.views.set(projectId, entry);
  host.webContentsToProject.set(view.webContents.id, projectId);
  registerProjectView(projectId, view.webContents);
  setupViewHandlers(host, view, entry);
  registerWebContents(view.webContents, host.win);
  host.windowRegistry?.registerAppViewWebContents(host.win.id, view.webContents.id);

  const cancel = () => {
    if (host.views.get(projectId) === entry) cleanupEntry(host, projectId);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    await loadView(view, projectId, {
      softMs: host.viewLoadTimeoutMs,
      hardMs: host.viewLoadHardTimeoutMs,
    });
    if (signal?.aborted) throw new Error("Background view materialization cancelled");
    if (
      host.views.get(projectId) !== entry ||
      view.webContents.isDestroyed() ||
      host.webContentsToProject.get(view.webContents.id) !== projectId
    ) {
      throw new Error("Background view binding changed during materialization");
    }
    view.setVisible(false);
    entry.state = "cached";
    entry.lastUsed = Date.now();
    registerCachedViewWebContents(view.webContents);
    return { view, isNew: true };
  } catch (error) {
    if (host.views.get(projectId) === entry) cleanupEntry(host, projectId);
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

export function finalizeBackgroundView(
  host: ProjectViewManager,
  projectId: string,
  webContentsId: number
): boolean {
  const entry = host.views.get(projectId);
  if (
    !entry ||
    host.activeProjectId === projectId ||
    entry.view.webContents.isDestroyed() ||
    entry.view.webContents.id !== webContentsId
  ) {
    return false;
  }
  deactivateEntry(host, entry);
  setImmediate(() => {
    if (!host.disposed && !host.win.isDestroyed()) evictStaleViews(host, "lru");
  });
  return true;
}
