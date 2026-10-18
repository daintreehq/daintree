import { CHANNELS } from "../../ipc/channels.js";
import { isScheduledQuietNow } from "../../../shared/utils/quietHours.js";
import type { ProjectFocusOnActivateIntent } from "../../../shared/types/ipc/project.js";
import { getWindowRegistry } from "../../window/windowRef.js";
import { isWindowOnRemoteHost } from "../../window/windowHost.js";
import {
  findOtherProjectOwner,
  redirectToProjectOwner,
  revealWindow,
} from "../../window/projectOwnership.js";
import { notificationService } from "../NotificationService.js";
import { agentNotificationService } from "../AgentNotificationService.js";
import { projectStore } from "../ProjectStore.js";

/** An OS banner a plugin asked for with `host.notify({ os: true })` (#13505). */
export interface PluginNotificationPage {
  pluginId: string;
  /** The plugin's bound project, or null for an app-wide plugin. */
  projectId: string | null;
  title: string;
  body: string;
  replaceKey?: string;
  /** Run when the banner is clicked; already in the plugin's instance namespace. */
  firstAction?: { actionId: string; args?: Record<string, unknown> };
}

// The same shape as the renderer's per-source toast bucket: a short burst,
// then one banner every ten seconds.
const PAGE_BUCKET_MAX_TOKENS = 3;
const PAGE_BUCKET_REFILL_MS = 10_000;

const buckets = new Map<string, { tokens: number; at: number }>();

function takePageToken(pluginId: string, now: number): boolean {
  const bucket = buckets.get(pluginId) ?? { tokens: PAGE_BUCKET_MAX_TOKENS, at: now };
  bucket.tokens = Math.min(
    PAGE_BUCKET_MAX_TOKENS,
    bucket.tokens + (now - bucket.at) / PAGE_BUCKET_REFILL_MS
  );
  bucket.at = now;
  buckets.set(pluginId, bucket);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/** Take down a plugin's banner showing under `replaceKey`, if any. */
export function retirePluginNotification(replaceKey: string): void {
  notificationService.closeNotificationByKey(replaceKey);
}

export function _resetPluginNotificationPagerForTests(): void {
  buckets.clear();
}

/**
 * Whether the user is looking at the plugin's project: a view of it is the one
 * its focused window shows. For an app-wide plugin any focused window counts,
 * since its toast reaches whatever the user has in front.
 */
function isPluginSurfaceInFront(projectId: string | null): boolean {
  if (projectId === null) return notificationService.isWindowFocused();
  const registry = getWindowRegistry();
  if (!registry) return false;
  for (const ctx of registry.all()) {
    try {
      const views = ctx.services.projectViewManager?.getAllViews() ?? [];
      for (const view of views) {
        if (view.projectId !== projectId || view.view.webContents.isDestroyed()) continue;
        if (notificationService.isOwnerViewFocused(view.view.webContents.id)) return true;
      }
    } catch {
      // A window tearing down shows nothing.
    }
  }
  return false;
}

/**
 * Bring the plugin's project forward and run the first action there, through
 * the same activation path a cross-window project switch uses, so a cached
 * view is switched to rather than poked behind the user's back. A project with
 * no live view anywhere opens nothing: a banner never wakes a closed project.
 */
function activatePluginNotification(page: PluginNotificationPage): void {
  const intent: ProjectFocusOnActivateIntent | undefined = page.firstAction
    ? {
        intent: "run-plugin-action",
        pluginId: page.pluginId,
        actionId: page.firstAction.actionId,
        ...(page.firstAction.args !== undefined ? { args: page.firstAction.args } : {}),
      }
    : undefined;
  const registry = getWindowRegistry();
  if (!registry) return;

  if (page.projectId !== null) {
    const project = projectStore.getProjectById(page.projectId);
    const owner = project ? findOtherProjectOwner(registry, page.projectId, {}) : null;
    if (!project || !owner) return;
    redirectToProjectOwner(owner, project, intent);
    return;
  }

  // An app-wide plugin's action belongs wherever the user was working: the
  // primary window's project, delivered through the same activation path so
  // a view still switching in receives it once it can. A window showing a
  // remote host's project runs that host's plugins, not this one, so it is
  // only brought forward.
  const primary = registry.getPrimary();
  if (!primary || primary.browserWindow.isDestroyed()) return;
  const activeProjectId = primary.services.projectViewManager?.getActiveProjectId() ?? null;
  const project =
    activeProjectId !== null && !isWindowOnRemoteHost(primary.windowId)
      ? projectStore.getProjectById(activeProjectId)
      : undefined;
  const owner = project ? findOtherProjectOwner(registry, project.id, {}) : null;
  if (project && owner) {
    redirectToProjectOwner(owner, project, intent);
    return;
  }
  revealWindow(primary.browserWindow);
  // A scratch workspace isn't a project, so no owner lookup finds it: its
  // view, already on screen, takes the intent directly.
  if (!intent || activeProjectId === null || isWindowOnRemoteHost(primary.windowId)) return;
  const webContents = primary.services.projectViewManager?.getActiveView()?.webContents;
  if (!webContents || webContents.isDestroyed()) return;
  webContents.focus();
  webContents.send(CHANNELS.PROJECT_FOCUS_ON_ACTIVATE, intent);
}

/**
 * Show a plugin's OS banner if nothing holds it back, and report whether it
 * went up. The caller has already checked the capability and the user's
 * switch. Unlike Canopy's asks, plugin pages respect quiet hours and the
 * session mute, as `showToast` does.
 */
export function pagePluginNotification(page: PluginNotificationPage): boolean {
  if (page.replaceKey !== undefined) retirePluginNotification(page.replaceKey);
  const settings = projectStore.getEffectiveNotificationSettings();
  if (settings.enabled === false) return false;
  if (isScheduledQuietNow(settings) || agentNotificationService.isSessionMuted()) return false;
  if (isPluginSurfaceInFront(page.projectId)) return false;
  if (!takePageToken(page.pluginId, Date.now())) return false;
  notificationService.showNativeNotification(page.title, page.body, {
    category: "info",
    ...(page.replaceKey !== undefined ? { replaceKey: page.replaceKey } : {}),
    onClick: () => activatePluginNotification(page),
  });
  return true;
}
