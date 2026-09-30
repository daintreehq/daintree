import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { usePanelStore } from "@/store";
import { logWarn } from "@/utils/logger";
import type { TerminalScrollbackRestoreError } from "@shared/types/panel";
import { type TerminalRestoreTask, scheduleBackgroundFetchAndRestore } from "./batchScheduler";

function classifySchedulerError(error: unknown): TerminalScrollbackRestoreError {
  const timestamp = Date.now();
  if (error instanceof Error) {
    return { type: "error", message: error.message, timestamp };
  }
  return { type: "error", message: String(error), timestamp };
}

// Tasks captured at schedule time, keyed by terminalId, so "Retry batch" can
// re-queue a failed restore using its original location/worktree without
// re-reading the (possibly stale) panel store at click time (lesson #9514).
// Entries are dropped once a restore settles as "done" so the map only
// retains the failed restores the retry path needs; any leftover entries are
// harmless — the scheduler gate (`scrollbackRestoreState !== "none"`) skips
// them on re-submit.
const lastBatchTaskMap = new Map<string, TerminalRestoreTask>();

// A retry task is only actionable while its terminal exists; drop it when the
// instance is destroyed so failed restores for closed panels don't accumulate.
let unsubDestroyed: (() => void) | null = null;
function ensureDestroyedListener(): void {
  if (unsubDestroyed) return;
  unsubDestroyed = terminalInstanceService.addInstanceDestroyedListener((id) => {
    lastBatchTaskMap.delete(id);
  });
}

function notifyRestoreListeners(): void {
  terminalInstanceService.notifyScrollbackRestoreListeners();
}

// Snapshot fetches (and the chunked replays they start) are bounded and run
// focused pane first, so the pane the user is looking at isn't queued behind —
// and parsed in 12 ms xterm slices interleaved with — every other pane's
// snapshot. Hidden panes finish later; the focused pane never waits for a slot.
const MAX_CONCURRENT_RESTORES = 3;

interface QueuedRestore {
  terminalId: string;
  run: () => Promise<void>;
}

const restoreQueue: QueuedRestore[] = [];
let activeRestores = 0;
// Bumped by reset so a restore dispatched before it can't release a slot the
// fresh queue never granted.
let queueGeneration = 0;

// Focus often lands after the batch is queued (boot focus is assigned once
// hydration finishes), so a focus change has to dispatch a waiting pane too.
let unsubFocus: (() => void) | null = null;
function syncFocusSubscription(): void {
  if (restoreQueue.length > 0 && !unsubFocus) {
    unsubFocus = usePanelStore.subscribe(
      (state) => state.focusedId,
      () => pumpRestoreQueue()
    );
  } else if (restoreQueue.length === 0 && unsubFocus) {
    unsubFocus();
    unsubFocus = null;
  }
}

// Read at dispatch time, not at schedule time: panes mount, reveal and take
// focus while the queue drains. Focus comes from the store alone — an
// instance's own isFocused flag can outlive the pane that set it.
function restorePriority(terminalId: string, focusedId: string | null): number {
  if (terminalId === focusedId) return 0;
  if (terminalInstanceService.get(terminalId)?.isVisible) return 1;
  return 2;
}

function pumpRestoreQueue(): void {
  const focusedId = usePanelStore.getState().focusedId;
  while (restoreQueue.length > 0) {
    let best: QueuedRestore | undefined;
    let bestIndex = 0;
    let bestPriority = Infinity;
    for (const [index, queued] of restoreQueue.entries()) {
      const priority = restorePriority(queued.terminalId, focusedId);
      if (priority < bestPriority) {
        best = queued;
        bestIndex = index;
        bestPriority = priority;
        if (priority === 0) break;
      }
    }
    if (!best) break;
    if (activeRestores >= MAX_CONCURRENT_RESTORES && bestPriority !== 0) break;

    restoreQueue.splice(bestIndex, 1);
    activeRestores++;
    const { run } = best;
    const generation = queueGeneration;
    scheduleBackgroundFetchAndRestore(async () => {
      try {
        await run();
      } finally {
        if (generation === queueGeneration) {
          activeRestores--;
          pumpRestoreQueue();
        }
      }
    });
  }
  syncFocusSubscription();
}

export function scheduleScrollbackRestore(
  tasks: TerminalRestoreTask[],
  isCurrent: () => boolean
): void {
  let scheduledAny = false;
  for (const task of tasks) {
    const managed = terminalInstanceService.get(task.terminalId);
    if (!managed || managed.scrollbackRestoreState !== "none") continue;

    ensureDestroyedListener();
    lastBatchTaskMap.set(task.terminalId, task);
    managed.scrollbackRestoreState = "pending";
    scheduledAny = true;

    const doRestore = async () => {
      // On bail paths where state is still queued (we never started), reset to
      // "none" so a subsequent scheduleScrollbackRestore call — e.g. a retry —
      // picks the terminal up again. The post-start bail below is left alone:
      // there, external code (destroy/done) already set a deliberate state.
      const resetIfStillQueued = () => {
        if (managed.scrollbackRestoreState === "pending") {
          managed.scrollbackRestoreState = "none";
          // Bailed before starting. The restore outcome is no longer relevant
          // to this terminal, so unblock any fully-settle waiters that gated
          // on it.
          terminalInstanceService.notifyRestoreSettledWaiters(task.terminalId);
          notifyRestoreListeners();
        }
      };

      if (!isCurrent()) {
        resetIfStillQueued();
        return;
      }
      const current = terminalInstanceService.get(task.terminalId);
      if (!current || current !== managed) {
        resetIfStillQueued();
        return;
      }
      if (managed.scrollbackRestoreState !== "pending") {
        return;
      }

      managed.scrollbackRestoreState = "in-progress";
      notifyRestoreListeners();
      try {
        await terminalInstanceService.fetchAndRestore(task.terminalId);

        // fetchAndRestore swallows write-timeout / parse errors internally
        // and returns false; the controller stashes the classified error on
        // `managed.lastScrollbackRestoreError`. Emit it to the panel store
        // so the user sees an inline banner instead of a silent blank
        // terminal. Gated on isCurrent() so a project switch that aborts
        // restore mid-flight does not surface a spurious banner.
        const restoreError = managed.lastScrollbackRestoreError;
        if (restoreError) {
          managed.scrollbackRestoreState = "none";
          if (isCurrent()) {
            usePanelStore.getState().setScrollbackRestoreError(task.terminalId, restoreError);
          }
          logWarn(`Scrollback restore failed for ${task.label}`, { error: restoreError });
        } else {
          managed.scrollbackRestoreState = "done";
          // Successful restores never need the retry task again — drop it so
          // the map only retains entries for failed restores.
          lastBatchTaskMap.delete(task.terminalId);
        }
        terminalInstanceService.notifyRestoreSettledWaiters(task.terminalId);
        notifyRestoreListeners();
      } catch (error) {
        // IPC-level failure from terminalClient.getSerializedState (the
        // controller's own catch returns false rather than rethrowing for
        // replay failures, so reaching here means something below
        // fetchAndRestore escaped — e.g. an unmocked test rejection).
        managed.scrollbackRestoreState = "none";
        if (isCurrent()) {
          usePanelStore
            .getState()
            .setScrollbackRestoreError(task.terminalId, classifySchedulerError(error));
        }
        logWarn(`Scrollback restore failed for ${task.label}`, { error });
        terminalInstanceService.notifyRestoreSettledWaiters(task.terminalId);
        notifyRestoreListeners();
      }
    };

    restoreQueue.push({ terminalId: task.terminalId, run: doRestore });
  }

  pumpRestoreQueue();

  // One notify for the whole batch of initial transitions above — the
  // per-terminal `doRestore` transitions notify individually as they fire.
  if (scheduledAny) notifyRestoreListeners();
}

/**
 * Re-queue scrollback restore for the panels that previously failed. Only
 * clears a panel's stored error when a captured task exists to re-submit — so
 * the failure banner (the sole recovery affordance) is never dismissed without
 * an actual retry being queued. Clearing the error also reopens the scheduler's
 * `"none"` gate (failure paths already reset managed state to `"none"`).
 * `isCurrent` is `() => true`: by retry time the original hydration closure is
 * gone, and the scheduler/instance guards make a post-teardown retry a safe
 * no-op (the terminals would no longer exist).
 */
export function retryFailedScrollbackRestoreBatch(failedTerminalIds: string[]): void {
  const panelStore = usePanelStore.getState();
  const retryTasks: TerminalRestoreTask[] = [];
  for (const id of failedTerminalIds) {
    const task = lastBatchTaskMap.get(id);
    if (!task) continue;
    panelStore.clearScrollbackRestoreError(id);
    retryTasks.push(task);
  }
  if (retryTasks.length === 0) return;
  scheduleScrollbackRestore(retryTasks, () => true);
}

/** Clear the captured retry tasks and the restore queue. Exported for test isolation and teardown. */
export function resetScrollbackRestoreBatch(): void {
  lastBatchTaskMap.clear();
  restoreQueue.length = 0;
  activeRestores = 0;
  queueGeneration++;
  syncFocusSubscription();
}
