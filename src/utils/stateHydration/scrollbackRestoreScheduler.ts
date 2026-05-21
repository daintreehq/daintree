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

export function scheduleScrollbackRestore(
  tasks: TerminalRestoreTask[],
  isCurrent: () => boolean,
  mode: "background" | "lazy"
): void {
  for (const task of tasks) {
    const managed = terminalInstanceService.get(task.terminalId);
    if (!managed || managed.scrollbackRestoreState !== "none") continue;

    managed.scrollbackRestoreState = "pending";

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
}
