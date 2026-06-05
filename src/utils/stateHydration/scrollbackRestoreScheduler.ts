import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { usePanelStore } from "@/store";
import { logWarn } from "@/utils/logger";
import type { TerminalScrollbackRestoreError } from "@shared/types/panel";
import {
  type TerminalRestoreTask,
  registerLazyScrollRestore,
  scheduleBackgroundFetchAndRestore,
} from "./batchScheduler";

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
// Merged across the critical + deferred calls of a single hydration run; the
// `isCurrent` guard ensures only one logical batch is ever live, so a flat map
// is safe. Entries for already-restored terminals are harmless — the scheduler
// gate (`scrollbackRestoreState !== "none"`) skips them on re-submit.
const lastBatchTaskMap = new Map<string, TerminalRestoreTask>();

function notifyRestoreListeners(): void {
  terminalInstanceService.notifyScrollbackRestoreListeners();
}

export function scheduleScrollbackRestore(
  tasks: TerminalRestoreTask[],
  isCurrent: () => boolean,
  mode: "background" | "lazy"
): void {
  let scheduledAny = false;
  for (const task of tasks) {
    const managed = terminalInstanceService.get(task.terminalId);
    if (!managed || managed.scrollbackRestoreState !== "none") continue;

    lastBatchTaskMap.set(task.terminalId, task);
    managed.scrollbackRestoreState = "pending";
    scheduledAny = true;

    const doRestore = async () => {
      // On bail paths where state is still "pending" (we never started),
      // reset to "none" so a subsequent scheduleScrollbackRestore call —
      // e.g. after the user navigates back into a project view — picks the
      // terminal up again. Without this reset, a project switch mid-flight
      // permanently strands the terminal in "pending" and scrollback is
      // never restored. The "state !== 'pending'" bail below is left alone:
      // there, external code (destroy/done) already set a deliberate state.
      const resetIfStillPending = () => {
        if (managed.scrollbackRestoreState === "pending") {
          managed.scrollbackRestoreState = "none";
          // Bailed before starting (project switch mid-flight). The restore
          // outcome is no longer relevant to this terminal in the new context,
          // so unblock any fully-settle waiters that gated on it.
          terminalInstanceService.notifyRestoreSettledWaiters(task.terminalId);
          notifyRestoreListeners();
        }
      };

      if (!isCurrent()) {
        resetIfStillPending();
        return;
      }
      const current = terminalInstanceService.get(task.terminalId);
      if (!current || current !== managed) {
        resetIfStillPending();
        return;
      }
      if (managed.scrollbackRestoreState !== "pending") return;

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

    if (mode === "lazy" && managed.hostElement) {
      const disposable = registerLazyScrollRestore(managed, doRestore);
      managed.scrollbackRestoreDisposable = disposable;
      managed.listeners.push(() => disposable.dispose());
    } else {
      scheduleBackgroundFetchAndRestore(doRestore);
    }
  }

  // One notify for the whole batch of "pending" transitions above — the
  // per-terminal `doRestore` transitions notify individually as they fire.
  if (scheduledAny) notifyRestoreListeners();
}

/**
 * Re-queue scrollback restore for the panels that previously failed. Clears
 * each panel's stored error first (so the failure banner clears and the
 * scheduler's `"none"` gate allows re-entry — failure paths already reset
 * managed state to `"none"`), then re-submits only the failed tasks using
 * their captured definitions. `isCurrent` is `() => true`: by retry time the
 * original hydration closure is gone, and the scheduler/instance guards make a
 * post-teardown retry a safe no-op (the terminals would no longer exist).
 */
export function retryFailedScrollbackRestoreBatch(failedTerminalIds: string[]): void {
  const panelStore = usePanelStore.getState();
  const retryTasks: TerminalRestoreTask[] = [];
  for (const id of failedTerminalIds) {
    panelStore.clearScrollbackRestoreError(id);
    const task = lastBatchTaskMap.get(id);
    if (task) retryTasks.push(task);
  }
  if (retryTasks.length === 0) return;
  scheduleScrollbackRestore(retryTasks, () => true, "background");
}

/** Clear the captured retry tasks. Exported for test isolation and teardown. */
export function resetScrollbackRestoreBatch(): void {
  lastBatchTaskMap.clear();
}
