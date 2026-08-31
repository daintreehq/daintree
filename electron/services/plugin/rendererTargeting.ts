import { getWindowRegistry, getProjectViewManager } from "../../window/windowRef.js";
import {
  getWebContentsForProject,
  isCachedViewWebContents,
} from "../../window/webContentsRegistry.js";
import { AppError } from "../../utils/errorTypes.js";

/**
 * The renderer a plugin host round-trip should land in, when the plugin is
 * bound to a project. `null`/`undefined` means the plugin is unbound
 * (installed/builtin) and the ambient focused view is the target.
 */
export type PluginTargetProjectId = string | null | undefined;

/**
 * The focused project view, then any live window's, then the process-wide
 * `ProjectViewManager`.
 *
 * Deliberately ambient: an unbound (installed/builtin) plugin has no project of
 * its own, so "whatever the user is looking at" is the only target it can mean.
 * Plugin round-trips also carry no source window, so the focused window is
 * consulted first — otherwise every call lands in the oldest window's view.
 * A project-bound plugin must never reach this function; see
 * {@link resolveTargetWebContents}.
 */
export function resolveAmbientWebContents(): Electron.WebContents | null {
  const registry = getWindowRegistry();
  if (registry) {
    const primary = registry.getPrimary();
    if (primary && !primary.browserWindow.isDestroyed()) {
      const primaryWc = primary.services.projectViewManager?.getActiveView()?.webContents;
      if (primaryWc && !primaryWc.isDestroyed()) {
        return primaryWc;
      }
    }
    for (const ctx of registry.all()) {
      if (ctx.browserWindow.isDestroyed()) continue;
      const webContents = ctx.services.projectViewManager?.getActiveView()?.webContents;
      if (webContents && !webContents.isDestroyed()) {
        return webContents;
      }
    }
  }
  const fallback = getProjectViewManager()?.getActiveView()?.webContents;
  if (fallback && !fallback.isDestroyed()) {
    return fallback;
  }
  return null;
}

/**
 * The renderer owned by `projectId`, or `null` when that project has no live
 * view. Never consults focus and never returns another project's view — the
 * app-global `webContents.id → projectId` map is the only source.
 *
 * Cached (evicted-but-retained) views still have a live renderer and count, but
 * a visible one wins when the project is open in more than one window, so a
 * prompt lands where the user can already see it. A cached view is CPU-throttled
 * and may not answer inside a dispatch's timeout — it is still the right target,
 * because "the project is open, just backgrounded" is not the same failure as
 * "the project has no renderer".
 */
export function resolveProjectWebContents(projectId: string): Electron.WebContents | null {
  let cached: Electron.WebContents | null = null;
  for (const wc of getWebContentsForProject(projectId)) {
    if (wc.isDestroyed()) continue;
    if (!isCachedViewWebContents(wc.id)) return wc;
    cached ??= wc;
  }
  return cached;
}

/**
 * The `PROJECT_VIEW_UNAVAILABLE` failure for a project-bound host call.
 * `detail` names the call so a plugin author can tell a dispatch from a prompt.
 */
export function projectViewUnavailable(projectId: string, detail: string): AppError {
  return new AppError({
    code: "PROJECT_VIEW_UNAVAILABLE",
    message: `${detail}: project ${projectId} has no live renderer`,
    context: { projectId },
  });
}

/**
 * Resolve the renderer for a plugin host round-trip.
 *
 * Unbound (`projectId` null/undefined): the ambient focused view, or `null`
 * when nothing is open — callers degrade as they always have.
 *
 * Bound: that project's renderer, or a thrown `PROJECT_VIEW_UNAVAILABLE`.
 * Falling back to the focused view here would hand project A's plugin project
 * B's renderer, which is the confused-deputy bug this path exists to prevent,
 * so it fails visibly instead. Call sites invoke this inside a Promise
 * executor, where the throw surfaces as a rejection.
 */
export function resolveTargetWebContents(
  projectId: PluginTargetProjectId,
  detail: string
): Electron.WebContents | null {
  // Nullish, not falsy: an empty-string project id is a caller bug, and treating
  // it as "unbound" would silently hand the call the focused project's view.
  if (projectId == null) return resolveAmbientWebContents();
  const webContents = resolveProjectWebContents(projectId);
  if (!webContents) throw projectViewUnavailable(projectId, detail);
  return webContents;
}
