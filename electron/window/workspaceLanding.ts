import type { WebContents } from "electron";
import { CHANNELS } from "../ipc/channels.js";
import { getActiveShutdown } from "../lifecycle/shutdownCoordinator.js";
import type { ProjectFocusOnActivateIntent } from "../../shared/types/ipc/project.js";
import { findOtherProjectOwner, revealWindow, type ProjectOwner } from "./projectOwnership.js";
import { isViewHydrated, whenViewHydrated } from "./viewHydration.js";
import { getAppWebContents } from "./webContentsRegistry.js";
import type { WindowContext, WindowRegistry } from "./WindowRegistry.js";
import { getWindowRegistry } from "./windowRef.js";

/** How long a view may take to hydrate before a landing waiting on it is dropped. */
export const WORKSPACE_LANDING_TIMEOUT_MS = 60_000;

/**
 * Runs `then(true)` once the renderer has hydrated, at once if it has: before
 * that it has no listener for an intent or a switch request, and preload
 * buffers nothing. `then(false)` if it closes, doesn't hydrate within a
 * minute, or Daintree starts quitting first.
 */
export function afterHydrated(
  webContents: WebContents,
  then: (hydrated: boolean) => void
): void {
  if (isViewHydrated(webContents.id)) {
    then(getActiveShutdown() === null);
    return;
  }
  let settled = false;
  const finish = (hydrated: boolean): void => {
    if (settled) return;
    settled = true;
    cancel();
    clearTimeout(timer);
    webContents.removeListener("destroyed", dropped);
    then(hydrated && getActiveShutdown() === null);
  };
  const dropped = (): void => finish(false);
  const timer = setTimeout(dropped, WORKSPACE_LANDING_TIMEOUT_MS);
  webContents.once("destroyed", dropped);
  // Not hydrated yet (checked above), so this never runs synchronously.
  const cancel = whenViewHydrated(webContents, () => finish(true));
}

/**
 * The renderer a window is showing. A window bound to no workspace yet (the
 * project picker) has no active view, and `orStartup` falls back to the
 * renderer it started with, which hydrates like any other.
 */
export function activeWebContents(
  context: WindowContext,
  { orStartup = false }: { orStartup?: boolean } = {}
): WebContents | null {
  try {
    const webContents =
      context.services.projectViewManager?.getActiveView()?.webContents ??
      (orStartup ? getAppWebContents(context.browserWindow) : undefined);
    return webContents && !webContents.isDestroyed() ? webContents : null;
  } catch {
    return null;
  }
}

/**
 * Lands the intent in the window holding the workspace; false when none does.
 * A view showing it is sent the intent once it has hydrated, and only if it
 * still shows the workspace then: a hydrated view is listening even while a
 * cold switch still holds the outgoing view over it, where a parked intent
 * would wait for a later switch. A cached or activating owner is handed to
 * `redirect`, which gets it the intent through the switch it runs: a project
 * and a scratch switch differently.
 */
export function landInOwner(
  registry: WindowRegistry,
  workspaceId: string,
  intent: ProjectFocusOnActivateIntent,
  redirect: (owner: ProjectOwner) => void
): boolean {
  const owner = findOtherProjectOwner(registry, workspaceId, {});
  if (!owner) return false;
  const webContents = owner.state === "foreground" ? activeWebContents(owner.context) : null;
  if (!webContents) {
    redirect(owner);
    return true;
  }
  const { projectViewManager } = owner;
  revealWindow(owner.context.browserWindow);
  afterHydrated(webContents, (hydrated) => {
    if (!hydrated || webContents.isDestroyed()) return;
    if (projectViewManager.getActiveProjectId() !== workspaceId) return;
    if (projectViewManager.getActiveView()?.webContents !== webContents) return;
    webContents.focus();
    webContents.send(CHANNELS.PROJECT_FOCUS_ON_ACTIVATE, intent);
  });
  return true;
}

/** Resolves with the window once its view has hydrated, or null when it never does. */
export function untilWindowHydrated(windowId: number): Promise<number | null> {
  const context = getWindowRegistry()?.getByWindowId(windowId);
  const webContents = context ? activeWebContents(context, { orStartup: true }) : null;
  if (!webContents) return Promise.resolve(context ? windowId : null);
  return new Promise((resolve) => {
    afterHydrated(webContents, (hydrated) => resolve(hydrated ? windowId : null));
  });
}
