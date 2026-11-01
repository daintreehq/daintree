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
 * Hands the intent to the window showing the project. A renderer that hasn't
 * hydrated yet has no listener for it (preload buffers nothing), so a window
 * opened for this click is waited on, and the intent goes once it has, if it
 * still shows the project then.
 */
function landWhenHydrated(
  registry: WindowRegistry,
  project: Project,
  intent: ProjectFocusOnActivateIntent
): void {
  const owner = findOtherProjectOwner(registry, project.id, {});
  if (!owner) return;
  const webContents = owner.projectViewManager.getActiveView()?.webContents;
  if (
    owner.state !== "foreground" ||
    !webContents ||
    webContents.isDestroyed() ||
    isViewHydrated(webContents.id)
  ) {
    redirectToProjectOwner(owner, project, intent);
    return;
  }
  revealWindow(owner.context.browserWindow);
  const stop = (): void => {
    cancel();
    clearTimeout(timer);
    webContents.removeListener("destroyed", stop);
  };
  const timer = setTimeout(stop, SCHEDULED_RUN_LANDING_TIMEOUT_MS);
  webContents.once("destroyed", stop);
  // Not hydrated yet (checked above), so this never runs `then` synchronously.
  const cancel = whenViewHydrated(webContents, () => {
    stop();
    if (getActiveShutdown() !== null) return;
    const current = findOtherProjectOwner(registry, project.id, {});
    if (current) redirectToProjectOwner(current, project, intent);
  });
}

function openWindowFor(project: Project, intent: ProjectFocusOnActivateIntent): void {
  const registry = getWindowRegistry();
  let pending = opening.get(project.id);
  if (!pending) {
    if (!windowOpener || !registry) {
      console.warn("[ScheduledRuns] No window can open for a run's notification");
      return;
    }
    pending = windowOpener(project.id)
      .catch((error: unknown) => {
        console.warn("[ScheduledRuns] Couldn't open a window for a run's notification:", error);
        return null;
      })
      .finally(() => opening.delete(project.id));
    opening.set(project.id, pending);
  }
  void pending.then((windowId) => {
    if (windowId === null || !registry || getActiveShutdown() !== null) return;
    landWhenHydrated(registry, project, intent);
  });
}

/**
 * A click on a scheduled run's banner (#15988): the run's project comes on
 * screen and lands on the run's pane, or its schedule's history when the pane
 * is gone, which the view decides from its own panes. A window already
 * holding the project is brought forward; failing that a window on this
 * machine switches to it, as picking it there would; with none, one opens.
 * The click asked for this project, so one that is closed opens too; one that
 * is gone, or missing on disk, opens nothing.
 */
export function openScheduledRunFromNotification(target: ScheduledRunNotificationTarget): void {
  if (getActiveShutdown() !== null) return;
  const project = projectStore.getProjectById(target.projectId);
  if (!project || project.status === "missing") return;
  const intent: ProjectFocusOnActivateIntent = {
    intent: "focus-scheduled-run",
    runId: target.runId,
    scheduleId: target.scheduleId,
    panelId: target.terminalId,
  };

  const registry = getWindowRegistry();
  if (registry && !opening.has(project.id)) {
    const owner = findOtherProjectOwner(registry, project.id, {});
    if (owner) {
      landWhenHydrated(registry, project, intent);
      return;
    }
    const context = localWindow(registry);
    const projectViewManager = context?.services.projectViewManager;
    if (context && projectViewManager) {
      requestProjectSwitchInWindow(context, projectViewManager, project, intent);
      return;
    }
  }
  openWindowFor(project, intent);
}

/** @internal Tests only. */
export function _resetScheduledRunNotificationNavigationForTesting(): void {
  windowOpener = null;
  opening.clear();
}
