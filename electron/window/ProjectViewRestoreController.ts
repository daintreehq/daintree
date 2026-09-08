/**
 * Background project restore for ProjectViewManager (#12320) — bring a project
 * back live, agents and all, without putting it on screen.
 *
 * A restored project is a real, fully registered `WebContentsView` that is
 * never attached to the window's content view. That is not an optimisation, it
 * is the only shape that works here:
 *
 *  - The `--resume` respawn is renderer-driven. Main captures each agent's
 *    session id at quit, but nothing replays it: the view's own hydration reads
 *    the persisted panel snapshot and issues `TERMINAL_SPAWN` itself. There is
 *    no main-process shortcut, so a real renderer has to boot.
 *  - It must never be attached. `pruneOrphanedChildren` deactivates any
 *    attached child that is neither the active view nor a paint-gate bridge, so
 *    an attached background view would be parked mid-load by the next switch.
 *  - It must never be activated, and so never gets a PTY MessagePort: the port
 *    is one per *window* (`distributePortsToView` closes the previous pair), so
 *    handing one to a hidden view would sever the visible project's terminals.
 *    Spawning does not need it — `terminal.spawn` is a plain invoke — and the
 *    view receives its port on first activation like any cached view.
 *
 * From the view's own perspective this is indistinguishable from an ordinary
 * cold start: same factory, same registration, same hydration, same persisted
 * `agentSessionId`. Nothing marks it as "restored", deliberately — LRU eviction
 * can destroy and recreate it later in the session, and a signal that lived in
 * main's memory would silently stop working at that point (#10810).
 */

import { performance } from "node:perf_hooks";
import { logInfo, logWarn } from "../utils/logger.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { createRegisteredView, loadView } from "./ProjectViewFactory.js";
import { cleanupEntry, deactivateEntry } from "./ProjectViewLifecycleController.js";
import { backgroundRestoreCapacity } from "./ProjectViewEvictionController.js";
import { notifyProjectPluginsOpened } from "./projectPluginLifecycle.js";
import type { ProjectViewManager } from "./ProjectViewManager.js";
import type { ViewEntry } from "./ProjectViewManagerTypes.js";

export type BackgroundRestoreResult =
  | { status: "restored" }
  | { status: "already-live" }
  | { status: "deferred"; reason: "capacity" | "pressure" }
  | { status: "skipped"; reason: "cancelled" | "failed" };

/**
 * How long to wait for a background view to report hydration.
 *
 * Generous on purpose. This bounds a renderer that is deliberately unhurried —
 * hidden, CPU-contended with every other cold boot on the machine, and doing
 * the full panel restore plus one agent respawn per saved terminal. Expiring it
 * is treated as a FAILURE, not a slow success: the view never said it restored
 * anything, so publishing it as a healthy cached view would hand the user a
 * blank project the next time they switched to it.
 */
export const BACKGROUND_HYDRATION_TIMEOUT_MS = 90_000;

/**
 * Restore one project into `host` as a cached, never-visible view.
 *
 * Resolves rather than rejects on every failure: the queue driving this treats
 * one project's failure as that project's business, and a rejected promise
 * escaping into a fire-and-forget startup pass is an unhandled rejection.
 */
export async function restoreInBackground(
  host: ProjectViewManager,
  projectId: string,
  projectPath: string,
  opts: { signal: AbortSignal; lastUsed: number }
): Promise<BackgroundRestoreResult> {
  if (!isRestorable(host, opts.signal)) return { status: "skipped", reason: "cancelled" };

  // A view already exists — the user switched here first, or a previous pass
  // restored it. Either way the project is live and this job is done.
  if (host.views.has(projectId)) return { status: "already-live" };

  const capacity = backgroundRestoreCapacity(host);
  if (capacity !== "available") {
    logInfo("projectview.background-restore.deferred", { projectId, reason: capacity });
    return { status: "deferred", reason: capacity };
  }

  const startedAt = performance.now();
  let entry: ViewEntry;
  try {
    entry = createRegisteredView(host, projectId, projectPath, { lastUsed: opts.lastUsed });
  } catch (error) {
    // Registration is several map writes and a handler install; a throw partway
    // leaves an entry occupying a capacity slot that nothing else will reclaim,
    // because the caller has no reference to clean up by.
    if (host.views.has(projectId)) cleanupEntry(host, projectId);
    logWarn("projectview.background-restore.failed", {
      projectId,
      phase: "create",
      error: formatErrorMessage(error, "createRegisteredView threw"),
    });
    return { status: "skipped", reason: "failed" };
  }

  const view = entry.view;
  const webContentsId = view.webContents.id;
  // Never composited, so tell Chromium as much from birth: an invisible view
  // holds no GPU tile textures, which is what keeps a cache full of restored
  // projects affordable.
  try {
    view.setVisible(false);
  } catch {
    // non-critical
  }

  // Armed BEFORE the load: hydration can complete on the same tick the load
  // settles, and a signal that arrives before anyone is waiting must latch
  // rather than be dropped.
  const hydration = host.waitForViewHydrated(webContentsId, {
    timeoutMs: BACKGROUND_HYDRATION_TIMEOUT_MS,
    signal: opts.signal,
  });

  try {
    await loadView(view, projectId, {
      softMs: host.viewLoadTimeoutMs,
      hardMs: host.viewLoadHardTimeoutMs,
    });
  } catch (error) {
    return failRestore(host, projectId, entry, webContentsId, opts.signal, () => {}, {
      phase: "load",
      error,
    });
  }

  // Armed only now, deliberately. `loadView` owns crash and destruction for the
  // duration of the load — a second listener there would just duplicate it.
  // What nobody covers is the window AFTER it settles: it has removed its own
  // handlers, and `setupViewHandlers` returns early for a `"loading"` entry
  // (that state normally means loadView is still responsible). A renderer that
  // dies here would otherwise sit until the hydration deadline and then be
  // published as a healthy cached view wrapping a dead document.
  const gone = watchForViewGone(view, () => host.settleViewHydrated(webContentsId));

  const outcome = await hydration;

  if (gone.happened() || isWebContentsGone(view)) {
    return failRestore(host, projectId, entry, webContentsId, opts.signal, gone.dispose, {
      phase: "renderer-gone",
    });
  }
  if (outcome !== "hydrated") {
    return failRestore(host, projectId, entry, webContentsId, opts.signal, gone.dispose, {
      phase: outcome,
    });
  }
  gone.dispose();

  if (host.views.get(projectId) !== entry) return { status: "skipped", reason: "cancelled" };

  // A switch landed while this booted and promoted the entry to active. It is
  // on screen and owns the window's ports — parking it would black out the
  // window. The project is live either way, which is all this job promised.
  if (host.activeProjectId === projectId) return { status: "restored" };

  if (!isRestorable(host, opts.signal)) return { status: "skipped", reason: "cancelled" };

  try {
    // `preserveLastUsed` because this project's recency belongs to the session
    // that ended, not to the moment its restore happened to finish: stamping now
    // would make the *least* recently used project — restored last — score as the
    // most recent and evict the ones the user actually rotates through.
    deactivateEntry(host, entry, { preserveLastUsed: true });
  } catch (error) {
    return failRestore(host, projectId, entry, webContentsId, opts.signal, () => {}, {
      phase: "park",
      error,
    });
  }

  // After registration and load, matching the cold-start path: registration
  // alone fires no contribution broadcast, so a plugin loaded into an
  // unregistered view stays invisible to it until some unrelated mutation
  // publishes a fresh snapshot.
  notifyProjectPluginsOpened(projectId, projectPath);

  logInfo("projectview.background-restore.restored", {
    projectId,
    elapsedMs: Math.round(performance.now() - startedAt),
  });
  return { status: "restored" };
}

/**
 * Tear down a restore that did not finish, identity-checked.
 *
 * The identity check is the whole point: a user switch that abandoned this
 * restore has already destroyed the entry and may have installed its own in
 * its place. Cleaning up by project id alone would destroy the view the user
 * is looking at.
 */
function failRestore(
  host: ProjectViewManager,
  projectId: string,
  entry: ViewEntry,
  webContentsId: number,
  signal: AbortSignal,
  disposeGoneWatch: () => void,
  detail: { phase: string; error?: unknown }
): BackgroundRestoreResult {
  disposeGoneWatch();
  host.settleViewHydrated(webContentsId);
  if (host.views.get(projectId) === entry) cleanupEntry(host, projectId);
  if (!isRestorable(host, signal)) return { status: "skipped", reason: "cancelled" };
  logWarn("projectview.background-restore.failed", {
    projectId,
    phase: detail.phase,
    error:
      detail.error === undefined
        ? undefined
        : formatErrorMessage(detail.error, "Background restore failed"),
  });
  return { status: "skipped", reason: "failed" };
}

/**
 * Watch a view for renderer death or teardown, releasing whatever is waiting on
 * it. Listeners are removed by `dispose`, which every caller path runs.
 */
function watchForViewGone(
  view: ViewEntry["view"],
  onGone: () => void
): { happened: () => boolean; dispose: () => void } {
  let happened = false;
  // Captured once: `view.webContents` reads back undefined for a destroyed
  // view (electron#50249), and dispose must keep working past that point.
  const wc = view.webContents;
  const handler = (): void => {
    happened = true;
    onGone();
  };
  try {
    wc.once("destroyed", handler);
    wc.once("render-process-gone", handler);
  } catch {
    // A webContents already torn down has nothing to report.
  }
  return {
    happened: () => happened,
    dispose: () => {
      try {
        wc.removeListener("destroyed", handler);
        wc.removeListener("render-process-gone", handler);
      } catch {
        // Electron can throw from removeListener once the WebContents is gone.
      }
    },
  };
}

/**
 * Closes the zero-width gap between the load settling and the watch being
 * armed, and catches a view torn down by a path that fires no event we saw.
 * The getter reads back undefined for a destroyed view (electron#50249), so a
 * missing `webContents` counts as gone rather than throwing.
 */
function isWebContentsGone(view: ViewEntry["view"]): boolean {
  try {
    const wc = view.webContents;
    return !wc || wc.isDestroyed();
  } catch {
    return true;
  }
}

function isRestorable(host: ProjectViewManager, signal: AbortSignal): boolean {
  return !host.disposed && !host.win.isDestroyed() && !signal.aborted;
}
