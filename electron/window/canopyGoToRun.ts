import { getActiveShutdown } from "../lifecycle/shutdownCoordinator.js";
import { projectStore } from "../services/ProjectStore.js";
import { scratchStore } from "../services/ScratchStore.js";
import { AppError } from "../utils/errorTypes.js";
import type { ProjectFocusOnActivateIntent } from "../../shared/types/ipc/project.js";
import { isScratchWorkspaceId } from "../../shared/utils/workspaceIds.js";
import {
  redirectToProjectOwner,
  requestOwnerAction,
  revealWindow,
  type ProjectOwner,
} from "./projectOwnership.js";
import type { WindowRegistry } from "./WindowRegistry.js";
import { getWindowRegistry } from "./windowRef.js";
import { isWindowOnRemoteHost, switchWindowToLocal } from "./windowHost.js";
import {
  landInOwner,
  untilWindowHydrated,
  WORKSPACE_LANDING_TIMEOUT_MS,
} from "./workspaceLanding.js";

/**
 * Opens a new window on this machine showing the workspace and resolves with
 * its id, or null when none could open: a display-less Host, a quit, a window
 * that failed. Set by the boot that can create windows.
 */
export type CanopyRunWindowOpener = (workspaceId: string) => Promise<number | null>;

/** A run on this machine, as the Canopy window lists it. */
export interface CanopyRunTarget {
  workspaceId: string;
  runId: string;
}

/** How long a window opened for a run may take to open and hydrate. */
export const CANOPY_RUN_OPENING_TIMEOUT_MS = 2 * WORKSPACE_LANDING_TIMEOUT_MS;

let windowOpener: CanopyRunWindowOpener | null = null;
/** Windows being opened for a workspace, so a second Go to pane waits for the first's. */
const opening = new Map<string, Promise<boolean>>();

export function setCanopyRunWindowOpener(opener: CanopyRunWindowOpener | null): () => void {
  windowOpener = opener;
  return () => {
    if (windowOpener === opener) windowOpener = null;
  };
}

function gone(): AppError {
  return new AppError({
    code: "NOT_FOUND",
    message: "The run's workspace no longer exists",
    userMessage: "Its project or scratch has been removed.",
  });
}

function noWindow(): AppError {
  return new AppError({
    code: "PROJECT_OPEN_FAILED",
    message: "No window opened for the run's workspace",
    userMessage: "A window for its project didn't open.",
  });
}

/**
 * A scratch's owner, brought to it the way a project's is. `project.switch`
 * rejects a scratch, so a window holding one in its cache is asked to open the
 * run itself, as its fleet overview would: its renderer saves the layout it
 * leaves and carries the pane to focus. Anywhere else the intent is parked for
 * the switch that lands the scratch. Returns that switch when main makes it, so
 * its failure is the request's.
 */
function redirectToScratchOwner(
  owner: ProjectOwner,
  { workspaceId, runId }: CanopyRunTarget,
  intent: ProjectFocusOnActivateIntent
): Promise<void> | undefined {
  const { context, projectViewManager, state } = owner;
  let switching: Promise<void> | undefined;
  if (state === "cached" && !isWindowOnRemoteHost(context.windowId)) {
    requestOwnerAction(owner, "pilot.openRun", { runId, workspaceId });
  } else {
    projectViewManager.setPendingFocusIntent(workspaceId, intent);
    // On a host now, its renderer would ask the host for a scratch it doesn't
    // have: the window comes back to this machine, onto the scratch.
    if (state === "cached") {
      switching = switchWindowToLocal(context.windowId, workspaceId).then(() => undefined);
    }
  }
  revealWindow(context.browserWindow);
  return switching;
}

type OwnerRedirect = (owner: ProjectOwner) => Promise<void> | undefined;

/**
 * How an owner that isn't showing the run's workspace is brought to it, or a
 * refusal when the workspace is gone. Read before anything moves, so a run in
 * a removed project opens nothing.
 */
function ownerRedirect(
  target: CanopyRunTarget,
  intent: ProjectFocusOnActivateIntent
): { redirect: OwnerRedirect; canOpen: boolean } {
  if (isScratchWorkspaceId(target.workspaceId)) {
    if (!scratchStore.getScratchById(target.workspaceId)) throw gone();
    return { redirect: (owner) => redirectToScratchOwner(owner, target, intent), canOpen: true };
  }
  const project = projectStore.getProjectById(target.workspaceId);
  if (!project) throw gone();
  return {
    redirect: (owner) => {
      redirectToProjectOwner(owner, project, intent);
      return undefined;
    },
    // A window already showing a project whose folder has gone still reaches
    // the pane; a new one would open on nothing.
    canOpen: project.status !== "missing",
  };
}

/**
 * Lands the intent in the window holding the workspace; false when none does.
 * Settles once a switch main makes to get it there has.
 */
async function landInHolder(
  registry: WindowRegistry,
  workspaceId: string,
  intent: ProjectFocusOnActivateIntent,
  redirect: OwnerRedirect
): Promise<boolean> {
  const pending: { switching?: Promise<void> } = {};
  const landed = landInOwner(registry, workspaceId, intent, (owner) => {
    pending.switching = redirect(owner);
  });
  await pending.switching;
  return landed;
}

function openWindowFor(workspaceId: string): Promise<boolean> {
  const pending = opening.get(workspaceId);
  if (pending) return pending;
  const opener = windowOpener;
  if (!opener) return Promise.resolve(false);
  // Bounded from the start: a window whose setup stalls must not hold every
  // later Go to pane behind it. One that comes up late is left as it is.
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), CANOPY_RUN_OPENING_TIMEOUT_MS);
  });
  const opened = opener(workspaceId).then((windowId) =>
    windowId === null ? null : untilWindowHydrated(windowId)
  );
  const settled: Promise<boolean> = Promise.race([opened, timedOut])
    .then((windowId) => windowId !== null)
    .catch((error: unknown) => {
      console.warn("[CanopyWindow] Couldn't open a window for a run:", error);
      return false;
    })
    .finally(() => {
      clearTimeout(timer);
      if (opening.get(workspaceId) === settled) opening.delete(workspaceId);
    });
  opening.set(workspaceId, settled);
  return settled;
}

/**
 * Go to pane from the Canopy window (#16337), for a run on this machine. The
 * Canopy window shows no project, so the run is reached where it lives: a
 * window holding its workspace comes forward, activating it there if it is
 * cached, and focuses the pane; with none, a new window opens on it and
 * focuses the pane once its view has hydrated. No other window is moved. A Go
 * to pane while a window opens for the same workspace waits for it, so it
 * opens no second window and lands after the one that opened it, never
 * before. Resolves once the run is on its way; rejects with why when it can't
 * be reached.
 */
export async function goToCanopyRun(target: CanopyRunTarget): Promise<void> {
  const { workspaceId } = target;
  const inFlight = opening.get(workspaceId);
  if (inFlight) await inFlight;
  if (getActiveShutdown() !== null) return;
  const registry = getWindowRegistry();
  if (!registry) throw noWindow();
  const intent: ProjectFocusOnActivateIntent = { intent: "focus-panel", panelId: target.runId };
  const { redirect, canOpen } = ownerRedirect(target, intent);
  if (await landInHolder(registry, workspaceId, intent, redirect)) return;
  if (!canOpen) {
    throw new AppError({
      code: "NOT_FOUND",
      message: "The run's project folder is missing",
      userMessage: "Its project's folder is missing.",
    });
  }

  const opened = await openWindowFor(workspaceId);
  if (getActiveShutdown() !== null) return;
  if (!opened) throw noWindow();
  // Routed again once it is up, so the pane is focused in the window that
  // shows the workspace now, as it is for one that already did.
  if (
    !(await landInHolder(registry, workspaceId, intent, ownerRedirect(target, intent).redirect))
  ) {
    throw noWindow();
  }
}

/** @internal Tests only. */
export function _resetCanopyGoToRunForTesting(): void {
  windowOpener = null;
  opening.clear();
}
