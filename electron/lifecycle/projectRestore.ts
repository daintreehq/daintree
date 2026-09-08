/**
 * The startup background-project restore queue (#12320).
 *
 * `restoreWindowFleet` brings the windows back, one project each. This brings
 * back everything else those windows had live — the warm siblings, and the
 * projects whose renderers had been evicted while their agents kept running —
 * so a relaunch does not mean walking the switcher clicking each project awake.
 *
 * One queue for the whole app, not one per window. Every job is a full React
 * cold boot; running two at once on a machine that just started N renderers
 * makes both slower without making either finish sooner, and the ordering that
 * matters is global anyway: the window the user was in restores its projects
 * before a window they had not touched in an hour.
 *
 * Pure scheduling — the per-project work, its cancellation and its capacity
 * rules all live in ProjectViewRestoreController.
 */

import { logInfo, logWarn } from "../utils/logger.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import {
  clearPendingBackgroundRestores,
  setPendingBackgroundRestores,
} from "../window/openWindowsTracker.js";
import type { ProjectViewManager } from "../window/ProjectViewManager.js";

export interface BackgroundRestoreJob {
  windowId: number;
  /** Read lazily: the manager can be disposed between enqueue and execution. */
  getManager: () => ProjectViewManager | undefined;
  /** Ordered most-recently-used first. */
  projectIds: string[];
  /** Resolve a workspace id to its on-disk path, or null if it is gone. */
  resolveWorkspacePath: (projectId: string) => string | null;
}

interface QueuedJob extends BackgroundRestoreJob {
  /**
   * How many of this job's projects have already been taken. Recency is derived
   * from this rather than from `projectIds.length`, which shrinks as the queue
   * consumes the list and would hand the LEAST recently used project the
   * NEWEST timestamp — exactly inverting the order the manifest recorded.
   */
  taken: number;
}

const queue: QueuedJob[] = [];
let draining = false;
let stopped = false;
/**
 * The manager whose boot is currently in flight, so a quit can abort it rather
 * than only refusing to start the next one.
 *
 * Without this, a restore that is mid-hydration when the shutdown chain commits
 * goes on to respawn its agents — after `gracefulKillByProject` has already
 * swept that project — leaving PTYs the capture pass will never see again.
 */
let running: ProjectViewManager | null = null;

/**
 * Queue one window's background projects. Returns immediately — window boot
 * must never wait on this, and the queue drains on its own.
 */
export function enqueueBackgroundRestores(job: BackgroundRestoreJob): void {
  if (stopped || job.projectIds.length === 0) return;
  // The queue consumes `projectIds` destructively as it drains, so it takes its
  // own copy: the caller's array is a manifest record's field, and shifting
  // items off it would edit the record the tracker persists.
  queue.push({ ...job, projectIds: [...job.projectIds], taken: 0 });
  setPendingBackgroundRestores(job.windowId, [...job.projectIds]);
  if (!draining) void drain();
}

/**
 * Stop the queue for good and drop every window's pending intent.
 *
 * Called from the shutdown chain's synchronous prefix, before the manifest
 * snapshot: a project still queued when the app quits was never restored, and
 * persisting it as pending would have the next launch promise a fleet this one
 * did not actually have.
 */
export function cancelBackgroundRestores(): void {
  stopped = true;
  for (const job of queue) clearPendingBackgroundRestores(job.windowId);
  queue.length = 0;
  try {
    running?.cancelBackgroundRestores();
  } catch (error) {
    // A manager already tearing itself down has nothing left to cancel, and
    // the shutdown chain must not fail on it.
    logWarn("projectrestore.cancel-inflight-failed", {
      error: formatErrorMessage(error, "cancelBackgroundRestores threw"),
    });
  }
  running = null;
}

async function drain(): Promise<void> {
  draining = true;
  try {
    while (!stopped) {
      const job = queue[0];
      if (!job) break;

      const projectId = job.projectIds.shift();
      if (projectId === undefined) {
        queue.shift();
        clearPendingBackgroundRestores(job.windowId);
        continue;
      }
      // Narrowed as we go, so a manifest written mid-restore describes what is
      // left to do rather than re-promising what is already back. Copied, so
      // the tracker never holds a reference this loop goes on to shift items
      // off — it would silently see a list shrink under it.
      setPendingBackgroundRestores(job.windowId, [...job.projectIds]);

      job.taken += 1;
      await runOne(job, projectId);

      // Yield between boots. Each job already awaits a full renderer cold start,
      // so this is not throughput pacing — it is what keeps a synchronous
      // failure path (a missing workspace, a disposed manager) from spinning
      // the whole queue inside one macrotask and starving the main process the
      // restored renderers are competing for.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally {
    draining = false;
  }
}

async function runOne(job: QueuedJob, projectId: string): Promise<void> {
  const manager = job.getManager();
  if (!manager || manager.disposed) {
    // The window closed while its projects waited. Its remaining jobs are
    // pointless, but the projects themselves are not this queue's to re-home.
    queue.shift();
    clearPendingBackgroundRestores(job.windowId);
    return;
  }

  const projectPath = job.resolveWorkspacePath(projectId);
  if (!projectPath) {
    // Deleted since the manifest was written. Skipped, never substituted —
    // the same rule the window restore follows for a deleted project.
    logInfo("projectrestore.skipped", { projectId, reason: "missing-workspace" });
    return;
  }

  running = manager;
  try {
    const result = await manager.restoreInBackground(projectId, projectPath, {
      // Below every live view, and stepping further back with each project
      // taken, so the recency order this queue was given survives into the LRU
      // cache rather than being reset to completion order.
      lastUsed: Date.now() - job.taken * 1000,
    });
    if (result.status === "deferred") {
      // The window is at its warm-view ceiling, or memory pressure has pulled
      // the ceiling down. Stop this window's pass rather than retrying: every
      // remaining project would hit the same wall, and the agents of a project
      // that never gets a renderer are still running and still resumable the
      // moment the user opens it.
      logInfo("projectrestore.window-full", {
        windowId: job.windowId,
        reason: result.reason,
        remaining: job.projectIds.length,
      });
      queue.shift();
      clearPendingBackgroundRestores(job.windowId);
    }
  } catch (error) {
    // restoreInBackground resolves rather than rejects, so reaching here means
    // something above it broke. One project's failure is not the queue's.
    logWarn("projectrestore.failed", {
      projectId,
      error: formatErrorMessage(error, "Background restore threw"),
    });
  } finally {
    if (running === manager) running = null;
  }
}

/** Test-only: the module singleton outlives tests that don't reset modules. */
export function resetBackgroundRestoreQueueForTests(): void {
  queue.length = 0;
  draining = false;
  stopped = false;
  running = null;
}
