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
// Entries for already-restored terminals are harmless — the scheduler gate
// (`scrollbackRestoreState !== "none"`) skips them on re-submit.
const lastBatchTaskMap = new Map<string, TerminalRestoreTask>();

function notifyRestoreListeners(): void {
  terminalInstanceService.notifyScrollbackRestoreListeners();
}

export function scheduleScrollbackRestore(
  tasks: TerminalRestoreTask[],
  isCurrent: () => boolean
): void {
  let scheduledAny = false;
  for (const task of tasks) {
    const managed = terminalInstanceService.get(task.terminalId);
    if (!managed || managed.scrollbackRestoreState !== "none") continue;

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

    scheduleBackgroundFetchAndRestore(doRestore);
  }

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

/** Clear the captured retry tasks. Exported for test isolation and teardown. */
export function resetScrollbackRestoreBatch(): void {
  lastBatchTaskMap.clear();
}
