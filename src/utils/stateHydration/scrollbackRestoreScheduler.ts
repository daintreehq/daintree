import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { logWarn } from "@/utils/logger";
import {
  type TerminalRestoreTask,
  registerLazyScrollRestore,
  scheduleBackgroundFetchAndRestore,
} from "./batchScheduler";

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
      if (!isCurrent()) return;
      const current = terminalInstanceService.get(task.terminalId);
      if (!current || current !== managed) return;
      if (managed.scrollbackRestoreState !== "pending") return;

      managed.scrollbackRestoreState = "in-progress";
      try {
        await terminalInstanceService.fetchAndRestore(task.terminalId);
        managed.scrollbackRestoreState = "done";
      } catch (error) {
        managed.scrollbackRestoreState = "none";
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
