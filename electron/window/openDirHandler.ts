import type { BrowserWindow } from "electron";
import type {
  OpenFoldersInNewWindow,
  ProjectOpenDisposition,
  ProjectOpenOutcome,
} from "../../shared/types/windowOpen.js";
import type { WindowRegistry } from "./WindowRegistry.js";
import {
  clearPendingOpenDirPaths,
  getPendingOpenDirPaths,
  setOpenDirConsumer,
} from "../setup/environment.js";
import { decideProjectOpenTarget, type ProjectOpenSource } from "./windowOpenPolicy.js";
import { setNewWindowOpener } from "./newWindowOpen.js";
import {
  holdWindowForOpen,
  isWindowBound,
  isWindowReadyForOpens,
  markWindowReadyForOpens,
  snapshotOpenWorld,
  type IsClosedWorkspace,
} from "./windowOpenState.js";

/**
 * The executor for folders opened from outside the app (#12593): Dock drops,
 * Finder "Open With", the warm CLI and `file://` directory arguments. Every one
 * arrives through the `environment.ts` directory consumer or its pre-window
 * queue, and every one is routed by `decideProjectOpenTarget` — an empty window
 * if there is one, otherwise a new window, and a window that already has the
 * project is brought forward instead. An occupied window is never replaced.
 * In-app "open in a new window" requests take the same route (#12594).
 */
export interface OpenDirHandlerDeps {
  /**
   * Resolve (registering if new) the project a folder opens as. Rejects when it
   * can't — the open still goes ahead, so `openDirectory` surfaces the reason
   * (git-init for a folder with no repository) in the window it lands in.
   */
  resolveProject: (dirPath: string) => Promise<{ id: string; path: string }>;
  /** Open a directory as a project in an existing window (handleDirectoryOpen). */
  openDirectory: (dirPath: string, win: BrowserWindow) => Promise<void>;
  /** Create a window bound to this directory; resolves to its id, rejects if none was made. */
  createWindowForPath: (dirPath: string) => Promise<number>;
  getWindowRegistry: () => WindowRegistry | null | undefined;
  getPreference: () => OpenFoldersInNewWindow;
  /** Whether a workspace id names a closed project — its window is showing the picker. */
  isProjectClosed: IsClosedWorkspace;
}

// App-lifetime consumer: macOS `open-file` is app-lifetime, so this wires once.
let openDirConsumerInstalled = false;

// Single serialized chain for every routed open, external and in-app alike.
// Beyond keeping "last opened ends active" deterministic, it is what makes the
// world snapshot trustworthy: the previous open has finished (or holds a
// reservation) before the next one looks for an empty window, so two queued
// folders can't both claim the same one. External opens are fire-and-forget,
// so window setup and the `open-file` listener never block.
let openChain: Promise<void> = Promise.resolve();

function enqueueOpen<T>(task: () => Promise<T>): Promise<T> {
  const run = openChain.then(task);
  openChain = run.then(
    () => undefined,
    (err) => {
      console.error("[MAIN] Failed to open folder:", err);
    }
  );
  return run;
}

// Windows already waiting to take focus on their first show, so repeated opens
// don't stack listeners.
const pendingFirstShowFocus = new WeakSet<BrowserWindow>();

function revealWindow(win: BrowserWindow): void {
  // A window still setting up can be behind createWindow's paint gate, and
  // showing it now would map it blank: take focus once the gate shows it. One
  // that has finished setting up and still reads invisible is hidden with the
  // app (Cmd+H), which show() brings back.
  if (!win.isVisible() && !win.isMinimized() && !isWindowReadyForOpens(win)) {
    if (pendingFirstShowFocus.has(win)) return;
    pendingFirstShowFocus.add(win);
    win.once("show", () => {
      pendingFirstShowFocus.delete(win);
      if (!win.isDestroyed()) win.focus();
    });
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Who asked for a routed open, and where they asked for it to land. */
export interface ProjectOpenRouting {
  source: ProjectOpenSource;
  disposition: ProjectOpenDisposition;
  /** The window the request came from. Null for opens from outside the app. */
  initiatingWindowId: number | null;
}

const EXTERNAL_OPEN: ProjectOpenRouting = {
  source: "external",
  disposition: "default",
  initiatingWindowId: null,
};

export function routeExternalOpen(
  dirPath: string,
  deps: OpenDirHandlerDeps
): Promise<ProjectOpenOutcome> {
  return routeProjectOpen(dirPath, EXTERNAL_OPEN, deps);
}

export async function routeProjectOpen(
  dirPath: string,
  routing: ProjectOpenRouting,
  deps: OpenDirHandlerDeps
): Promise<ProjectOpenOutcome> {
  const project = await deps.resolveProject(dirPath).catch(() => null);
  // A folder that resolves to no project is still keyed by its path, so a
  // second open of it finds the window already holding it.
  const targetPath = project?.path ?? dirPath;
  const registry = deps.getWindowRegistry();

  // Synchronous from the snapshot to the reservation: nothing may change the
  // world between deciding on a window and claiming it.
  const decision = decideProjectOpenTarget(
    {
      projectId: project?.id ?? null,
      projectPath: targetPath,
      source: routing.source,
      intent: "open",
      disposition: routing.disposition,
      initiatingWindowId: routing.initiatingWindowId,
    },
    snapshotOpenWorld(registry, deps.getPreference(), deps.isProjectClosed)
  );

  const win =
    decision.kind === "create"
      ? undefined
      : registry?.getByWindowId(decision.windowId)?.browserWindow;
  // A window the snapshot listed can only be missing here if the registry lost
  // it mid-read — nothing has awaited since. Opening somewhere beats dropping
  // the folder.
  if (decision.kind === "create" || !win || win.isDestroyed()) {
    return { kind: "created", windowId: await deps.createWindowForPath(targetPath) };
  }

  if (decision.kind === "focus") {
    revealWindow(win);
    return { kind: "focused", windowId: decision.windowId };
  }

  const { windowId } = decision;
  await holdWindowForOpen(
    windowId,
    { projectId: project?.id ?? null, projectPath: targetPath },
    async () => {
      revealWindow(win);
      await deps.openDirectory(targetPath, win);
    },
    () => isWindowBound(registry, windowId, deps.isProjectClosed)
  );
  return { kind: "activated", windowId };
}

/**
 * Install the live directory consumer (idempotent). Each folder is routed at
 * execution time, inside the serialized chain, so it sees the windows as they
 * are once the opens ahead of it have landed.
 */
export function installOpenDirConsumer(deps: OpenDirHandlerDeps): void {
  if (openDirConsumerInstalled) return;
  openDirConsumerInstalled = true;
  setOpenDirConsumer((dirPath) => {
    void enqueueOpen(() => routeExternalOpen(dirPath, deps));
  });
  // Open Project in New Window…, a Cmd-click in Open Recent, and every in-app
  // flow told "New window" (#12594). Routed like an external open, on the same
  // chain, but the window that asked is never the one it lands in: an empty
  // window elsewhere is reused, otherwise a new one is made, and a window
  // already showing the project is brought forward instead (#12596).
  setNewWindowOpener((dirPath, initiatingWindowId) =>
    enqueueOpen(() =>
      routeProjectOpen(dirPath, { source: "in-app", disposition: "new", initiatingWindowId }, deps)
    )
  );
}

/**
 * Called once per window at the end of its setup. Marks the window as eligible
 * to be reused as an empty window, then routes any folders queued before a
 * window existed — each on its own, so three queued folders open in three
 * windows rather than replacing one another in this one.
 */
export function drainPendingOpenDirs(win: BrowserWindow, deps: OpenDirHandlerDeps): void {
  markWindowReadyForOpens(win);
  const pending = getPendingOpenDirPaths();
  if (pending.length === 0) return;
  clearPendingOpenDirPaths();
  for (const dirPath of pending) {
    void enqueueOpen(() => routeExternalOpen(dirPath, deps));
  }
}

/** Test-only: reset the install-once guard and the open chain between cases. */
export function _resetOpenDirConsumerForTest(): void {
  openDirConsumerInstalled = false;
  setNewWindowOpener(null);
  openChain = Promise.resolve();
}
