import { getActiveShutdown } from "../lifecycle/shutdownCoordinator.js";
import { projectStore } from "../services/ProjectStore.js";
import type { ProjectFocusOnActivateIntent } from "../../shared/types/ipc/project.js";
import {
  redirectToProjectOwner,
  requestProjectSwitchInWindow,
  type ProjectOwner,
} from "./projectOwnership.js";
import type { WindowContext, WindowRegistry } from "./WindowRegistry.js";
import { getWindowRegistry } from "./windowRef.js";
import { isWindowOnRemoteHost } from "./windowHost.js";
import {
  activeWebContents,
  afterHydrated,
  landInOwner,
  untilWindowHydrated,
  WORKSPACE_LANDING_TIMEOUT_MS,
} from "./workspaceLanding.js";

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

/** How long a view may take to hydrate before a landing waiting on it is dropped. */
export const SCHEDULED_RUN_LANDING_TIMEOUT_MS = WORKSPACE_LANDING_TIMEOUT_MS;

/** How long a window opened for a click may take to open and hydrate before later clicks stop waiting on it. */
export const SCHEDULED_RUN_OPENING_TIMEOUT_MS = 2 * SCHEDULED_RUN_LANDING_TIMEOUT_MS;

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

function openWindowFor(target: ScheduledRunNotificationTarget): void {
  if (!windowOpener) {
    console.warn("[ScheduledRuns] No window can open for a run's notification");
    return;
  }
  const { projectId } = target;
  const opened = windowOpener(projectId).then((windowId) =>
    windowId === null ? null : untilWindowHydrated(windowId)
  );
  // Bounded from the start: a window whose setup stalls must not hold every
  // later click behind it. One that comes up late is left as it is.
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.warn("[ScheduledRuns] A window opened for a run's notification didn't come up");
      resolve(null);
    }, SCHEDULED_RUN_OPENING_TIMEOUT_MS);
  });
  const pending = Promise.race([opened, timedOut])
    .catch((error: unknown) => {
      console.warn("[ScheduledRuns] Couldn't open a window for a run's notification:", error);
      return null;
    })
    .finally(() => {
      clearTimeout(timer);
      opening.delete(projectId);
    });
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
  const redirect = (owner: ProjectOwner): void => redirectToProjectOwner(owner, project, intent);
  if (landInOwner(registry, project.id, intent, redirect)) return;

  const context = localWindow(registry);
  if (!context) {
    openWindowFor(target);
    return;
  }
  const switchIn = (): void => {
    if (context.browserWindow.isDestroyed()) return;
    // Another click, or the user, may have brought the project up meanwhile.
    if (landInOwner(registry, project.id, intent, redirect)) return;
    const projectViewManager = context.services.projectViewManager;
    if (projectViewManager) {
      requestProjectSwitchInWindow(context, projectViewManager, project, intent);
    }
  };
  const webContents = activeWebContents(context, { orStartup: true });
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
