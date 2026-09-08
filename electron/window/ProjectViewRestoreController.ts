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

export type BackgroundRestoreResult =
  | { status: "restored" }
  | { status: "already-live" }
  | { status: "deferred"; reason: "capacity" | "pressure" }
  | { status: "skipped"; reason: "cancelled" | "failed" };

/**
 * How long to wait for a background view to report `app:view-hydrated`.
 *
 * Generous on purpose. This bounds a renderer that is deliberately unhurried —
 * hidden, CPU-contended with every other cold boot on the machine, and doing
 * the full panel restore plus one agent respawn per saved terminal. Expiring it
 * costs only the parking step: the view is still registered, still loaded, and
 * its agents are already running, so a timeout degrades to "parked a little
 * early", never to "lost the project".
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
  const entry = createRegisteredView(host, projectId, projectPath, { lastUsed: opts.lastUsed });
  const view = entry.view;
  // Never composited, so tell Chromium as much from birth: an invisible view
  // holds no GPU tile textures, which is what keeps a cache full of restored
  // projects affordable.
  try {
    view.setVisible(false);
  } catch {
    // non-critical
  }

  const webContentsId = view.webContents.id;
  // Armed BEFORE the load: hydration can complete on the same tick the load
  // settles, and a signal that arrives before anyone is waiting must latch
  // rather than be dropped.
  const hydrated = host.waitForViewHydrated(webContentsId, {
    timeoutMs: BACKGROUND_HYDRATION_TIMEOUT_MS,
    signal: opts.signal,
  });

  try {
    await loadView(view, projectId, {
      softMs: host.viewLoadTimeoutMs,
      hardMs: host.viewLoadHardTimeoutMs,
    });
    await hydrated;
  } catch (error) {
    host.settleViewHydrated(webContentsId);
    // Identity-checked: a user switch that abandoned this restore has already
    // torn the entry down and may have replaced it with its own. Cleaning up by
    // project id alone would destroy the view the user is looking at.
    if (host.views.get(projectId) === entry) cleanupEntry(host, projectId);
    if (!isRestorable(host, opts.signal)) return { status: "skipped", reason: "cancelled" };
    logWarn("projectview.background-restore.failed", {
      projectId,
      error: formatErrorMessage(error, "Background restore failed"),
    });
    return { status: "skipped", reason: "failed" };
  }

  if (host.views.get(projectId) !== entry) return { status: "skipped", reason: "cancelled" };

  // A switch landed while this booted and promoted the entry to active. It is
  // on screen and owns the window's ports — parking it would black out the
  // window. The project is live either way, which is all this job promised.
  if (host.activeProjectId === projectId) return { status: "restored" };

  if (!isRestorable(host, opts.signal)) return { status: "skipped", reason: "cancelled" };

  // `preserveLastUsed` because this project's recency belongs to the session
  // that ended, not to the moment its restore happened to finish: stamping now
  // would make the *least* recently used project — restored last — score as the
  // most recent and evict the ones the user actually rotates through.
  deactivateEntry(host, entry, { preserveLastUsed: true });

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

function isRestorable(host: ProjectViewManager, signal: AbortSignal): boolean {
  return !host.disposed && !host.win.isDestroyed() && !signal.aborted;
}
