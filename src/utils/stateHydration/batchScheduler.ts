import { logWarn } from "@/utils/logger";
import type { ResourceProfile } from "@shared/types/resourceProfile";

export const RESTORE_SPAWN_BATCH_SIZE = 3;
export const RESTORE_SPAWN_BATCH_DELAY_MS = 100;

const BACKGROUND_RESTORE_FALLBACK_DELAY_MS = 0;

export interface RestoreBatchParams {
  /** Number of background/orphan PTY panels spawned per staggered batch. */
  batchSize: number;
  /** Delay between staggered batches, in milliseconds. */
  delayMs: number;
}

/**
 * Adaptive batch size + inter-batch delay for staggered PTY restore, scaled to
 * the machine's resource profile (#10528). The profile already encodes hardware
 * capability — `performance` machines spawn larger batches with shorter gaps,
 * `efficiency` machines stay conservative to limit simultaneous shell-init
 * bursts and PTY fd pressure. Unknown/missing profiles fall back to `balanced`,
 * matching the resource-profile store's default. Kept upper-bounded (8) to stay
 * below the fd-leak ceiling flagged in #9544.
 */
export function getRestoreBatchParams(profile?: ResourceProfile | null): RestoreBatchParams {
  switch (profile) {
    case "performance":
      return { batchSize: 8, delayMs: 50 };
    case "efficiency":
      return { batchSize: 2, delayMs: 150 };
    case "balanced":
    default:
      return { batchSize: 5, delayMs: 80 };
  }
}

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
