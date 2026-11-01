import type { WebContents } from "electron";
import { CHANNELS } from "../ipc/channels.js";
import { getActiveShutdown } from "../lifecycle/shutdownCoordinator.js";
import { projectStore } from "../services/ProjectStore.js";
import type { ProjectFocusOnActivateIntent } from "../../shared/types/ipc/project.js";
import type { Project } from "../../shared/types/project.js";
import {
  findOtherProjectOwner,
  redirectToProjectOwner,
  requestProjectSwitchInWindow,
  revealWindow,
} from "./projectOwnership.js";
import { isViewHydrated, whenViewHydrated } from "./viewHydration.js";
import type { WindowContext, WindowRegistry } from "./WindowRegistry.js";
import { getWindowRegistry } from "./windowRef.js";
import { isWindowOnRemoteHost } from "./windowHost.js";

/**
 * Opens a window on this machine showing the project and resolves with its
 * id, or null when none could open: a display-less Host, a quit, a window
 * that failed. Set by the boot that can create windows.
 */
export type ScheduledRunWindowOpener = (projectId: string) => Promise<number | null>;

/** The run a clicked banner is about. */
export interface ScheduledRunNotificationTarget {
  projectId: string;
  scheduleId: string;
  runId: string;
  /** The run's terminal, or null when it never had one to show. */
  terminalId: string | null;
}

/** How long a window opened for a click may take to hydrate before its landing is dropped. */
export const SCHEDULED_RUN_LANDING_TIMEOUT_MS = 60_000;

let windowOpener: ScheduledRunWindowOpener | null = null;
/** Windows being opened for a project, so a second click waits for the first's. */
const opening = new Map<string, Promise<number | null>>();

export function setScheduledRunWindowOpener(opener: ScheduledRunWindowOpener | null): () => void {
  windowOpener = opener;
  return () => {
    if (windowOpener === opener) windowOpener = null;
  };
}

/** A window on this machine that can switch projects: the primary one first. */
function localWindow(registry: WindowRegistry): WindowContext | null {
  const primary = registry.getPrimary();
  const candidates = primary ? [primary, ...registry.all()] : registry.all();
  for (const context of candidates) {
    try {
      if (context.browserWindow.isDestroyed()) continue;
      if (!context.services.projectViewManager) continue;
      if (isWindowOnRemoteHost(context.windowId)) continue;
      return context;
    } catch {
      // A window tearing down can throw from any of these reads.
    }
  }
  return null;
}

/**
 * Runs `then(true)` once the renderer has hydrated, at once if it has: before
 * that it has no listener for an intent or a switch request, and preload
 * buffers nothing. `then(false)` if it closes, doesn't hydrate within a
 * minute, or Daintree starts quitting first.
 */
function afterHydrated(webContents: WebContents, then: (hydrated: boolean) => void): void {
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
  const timer = setTimeout(dropped, SCHEDULED_RUN_LANDING_TIMEOUT_MS);
  webContents.once("destroyed", dropped);
  // Not hydrated yet (checked above), so this never runs synchronously.
  const cancel = whenViewHydrated(webContents, () => finish(true));
}

function activeWebContents(context: WindowContext): WebContents | null {
  try {
    const webContents = context.services.projectViewManager?.getActiveView()?.webContents;
    return webContents && !webContents.isDestroyed() ? webContents : null;
  } catch {
    return null;
  }
}

/**
 * Lands the intent in the window holding the project; false when none does.
 * A view showing it is sent the intent once it has hydrated, and only if it
 * still shows the project then: a hydrated view is listening even while a
 * cold switch still holds the outgoing view over it, where a parked intent
 * would wait for a later switch. A cached or activating owner gets it through
 * the switch it runs.
 */
function landInOwner(
  registry: WindowRegistry,
  project: Project,
  intent: ProjectFocusOnActivateIntent
): boolean {
  const owner = findOtherProjectOwner(registry, project.id, {});
  if (!owner) return false;
  const webContents = owner.state === "foreground" ? activeWebContents(owner.context) : null;
  if (!webContents) {
    redirectToProjectOwner(owner, project, intent);
    return true;
  }
  const { projectViewManager } = owner;
  revealWindow(owner.context.browserWindow);
  afterHydrated(webContents, (hydrated) => {
    if (!hydrated || webContents.isDestroyed()) return;
    if (projectViewManager.getActiveProjectId() !== project.id) return;
    if (projectViewManager.getActiveView()?.webContents !== webContents) return;
    webContents.focus();
    webContents.send(CHANNELS.PROJECT_FOCUS_ON_ACTIVATE, intent);
  });
  return true;
}

/** Resolves with the window once its view has hydrated, or null when it never does. */
function untilWindowHydrated(windowId: number): Promise<number | null> {
  const context = getWindowRegistry()?.getByWindowId(windowId);
  const webContents = context ? activeWebContents(context) : null;
  if (!webContents) return Promise.resolve(context ? windowId : null);
  return new Promise((resolve) => {
    afterHydrated(webContents, (hydrated) => resolve(hydrated ? windowId : null));
  });
}

function openWindowFor(target: ScheduledRunNotificationTarget): void {
  if (!windowOpener) {
    console.warn("[ScheduledRuns] No window can open for a run's notification");
    return;
  }
  const { projectId } = target;
  const pending = windowOpener(projectId)
    .then((windowId) => (windowId === null ? null : untilWindowHydrated(windowId)))
    .catch((error: unknown) => {
      console.warn("[ScheduledRuns] Couldn't open a window for a run's notification:", error);
      return null;
    })
    .finally(() => opening.delete(projectId));
  opening.set(projectId, pending);
  // Routed again once it is up, so the click lands like any other; a window
  // that didn't open or hydrate ends it, rather than opening another.
  void pending.then((windowId) => {
    if (windowId !== null) openScheduledRunFromNotification(target);
  });
}

/**
 * A click on a scheduled run's banner (#15988): the run's project comes on
 * screen and lands on the run's pane, or its schedule's history when the pane
 * is gone, which the view decides from its own panes. A window already
 * holding the project is brought forward; failing that a window on this
 * machine switches to it once its view can take the request, as picking it
 * there would; with none, one opens. A click while a window opens for a run
 * waits for it, so two clicks never open two windows. The click asked for
 * this project, so one that is closed opens too; one that is gone, or missing
 * on disk, opens nothing.
 */
export function openScheduledRunFromNotification(target: ScheduledRunNotificationTarget): void {
  if (getActiveShutdown() !== null) return;
  const project = projectStore.getProjectById(target.projectId);
  if (!project || project.status === "missing") return;
  const registry = getWindowRegistry();
  if (!registry) return;
  if (opening.size > 0) {
    void Promise.all([...opening.values()]).then(() => openScheduledRunFromNotification(target));
    return;
  }
  const intent: ProjectFocusOnActivateIntent = {
    intent: "focus-scheduled-run",
    runId: target.runId,
    scheduleId: target.scheduleId,
    panelId: target.terminalId,
  };
  if (landInOwner(registry, project, intent)) return;

  const context = localWindow(registry);
  if (!context) {
    openWindowFor(target);
    return;
  }
  const switchIn = (): void => {
    if (context.browserWindow.isDestroyed()) return;
    // Another click, or the user, may have brought the project up meanwhile.
    if (landInOwner(registry, project, intent)) return;
    const projectViewManager = context.services.projectViewManager;
    if (projectViewManager) {
      requestProjectSwitchInWindow(context, projectViewManager, project, intent);
    }
  };
  const webContents = activeWebContents(context);
  if (!webContents) {
    switchIn();
    return;
  }
  afterHydrated(webContents, (hydrated) => {
    if (hydrated) switchIn();
  });
}

/** @internal Tests only. */
export function _resetScheduledRunNotificationNavigationForTesting(): void {
  windowOpener = null;
  opening.clear();
}
