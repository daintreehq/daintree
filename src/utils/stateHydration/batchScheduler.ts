import { logWarn } from "@/utils/logger";

export const RESTORE_SPAWN_BATCH_SIZE = 3;
export const RESTORE_SPAWN_BATCH_DELAY_MS = 100;

const DEFERRED_RESTORE_IDLE_TIMEOUT_MS = 1200;
const DEFERRED_RESTORE_FALLBACK_DELAY_MS = 32;

export interface TerminalRestoreTask {
  terminalId: string;
  label: string;
  worktreeId?: string;
  location: "grid" | "dock";
}

export function splitSnapshotRestoreTasks(
  tasks: TerminalRestoreTask[],
  activeWorktreeId: string | null,
  enableDeferredRestore: boolean
): { criticalTasks: TerminalRestoreTask[]; deferredTasks: TerminalRestoreTask[] } {
  if (!enableDeferredRestore || tasks.length <= 1) {
    return { criticalTasks: tasks, deferredTasks: [] };
  }

  const criticalTasks: TerminalRestoreTask[] = [];
  const deferredTasks: TerminalRestoreTask[] = [];

  for (const task of tasks) {
    const isDockTask = task.location === "dock";
    const isProjectScopedTask = task.worktreeId == null;
    const isActiveWorktreeTask = task.worktreeId === activeWorktreeId;

    if (isDockTask || isProjectScopedTask || isActiveWorktreeTask) {
      criticalTasks.push(task);
    } else {
      deferredTasks.push(task);
    }
  }

  if (criticalTasks.length === 0 && deferredTasks.length > 0) {
    const fallbackTask = deferredTasks.shift();
    if (fallbackTask) {
      criticalTasks.push(fallbackTask);
    }
  }

  return { criticalTasks, deferredTasks };
}

export function scheduleDeferredSnapshotRestore(runRestore: () => Promise<void>): void {
  const execute = () => {
    void runRestore().catch((error) => {
      logWarn("Deferred terminal snapshot restore failed", { error });
    });
  };

  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(() => execute(), {
      timeout: DEFERRED_RESTORE_IDLE_TIMEOUT_MS,
    });
    return;
  }

  setTimeout(execute, DEFERRED_RESTORE_FALLBACK_DELAY_MS);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runInBatches<T>(
  items: T[],
  batchSize: number,
  delayMs: number,
  runner: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.allSettled(batch.map(runner));
    if (i + batchSize < items.length) {
      await delay(delayMs);
    }
  }
}
