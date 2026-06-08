import { logWarn } from "@/utils/logger";

export const RESTORE_SPAWN_BATCH_SIZE = 3;
export const RESTORE_SPAWN_BATCH_DELAY_MS = 100;

const BACKGROUND_RESTORE_FALLBACK_DELAY_MS = 0;

export interface TerminalRestoreTask {
  terminalId: string;
  label: string;
  worktreeId?: string;
  location: "grid" | "dock";
}

export function delay(ms: number): Promise<void> {
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

export function scheduleBackgroundFetchAndRestore(restoreFn: () => Promise<void>): void {
  const execute = () => {
    void restoreFn().catch((error) => {
      logWarn("Background scrollback restore failed", { error });
    });
  };

  if (typeof scheduler !== "undefined" && typeof scheduler.postTask === "function") {
    void scheduler.postTask(execute, { priority: "background" });
    return;
  }

  setTimeout(execute, BACKGROUND_RESTORE_FALLBACK_DELAY_MS);
}
