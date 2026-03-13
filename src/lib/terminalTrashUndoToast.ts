import { notify } from "@/lib/notify";
import { TRASH_TTL_MS, TRASH_UNDO_TOAST_DURATION_MS } from "@shared/config/trash";

const COALESCE_KEY = "terminal-trash-undo";
const COALESCE_WINDOW_MS = 2_000;

interface PendingRestore {
  id: string;
  groupRestoreId?: string;
  addedAt: number;
}

let pendingRestoreTargets: PendingRestore[] = [];
let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setTimeout(() => {
    cleanupTimer = null;
    const cutoff = Date.now() - TRASH_TTL_MS;
    pendingRestoreTargets = pendingRestoreTargets.filter((t) => t.addedAt > cutoff);
  }, TRASH_TTL_MS + 500);
}

function restoreAll(): void {
  const targets = pendingRestoreTargets;
  pendingRestoreTargets = [];

  // Lazy import to avoid circular dependency with terminalStore
  void import("@/store/terminalStore").then(({ useTerminalStore }) => {
    const state = useTerminalStore.getState();
    const restored = new Set<string>();

    for (const target of targets) {
      if (target.groupRestoreId && !restored.has(target.groupRestoreId)) {
        if (
          Array.from(state.trashedTerminals.values()).some(
            (t) => t.groupRestoreId === target.groupRestoreId
          )
        ) {
          state.restoreTrashedGroup(target.groupRestoreId);
          restored.add(target.groupRestoreId);
        }
      } else if (!target.groupRestoreId && !restored.has(target.id)) {
        if (state.trashedTerminals.has(target.id)) {
          state.restoreTerminal(target.id);
          restored.add(target.id);
        }
      }
    }
  });
}

export function showTrashUndoToast(title: string, id: string, groupRestoreId?: string): void {
  pendingRestoreTargets.push({ id, groupRestoreId, addedAt: Date.now() });
  scheduleCleanup();

  notify({
    type: "info",
    message: `Closed "${title}"`,
    inboxMessage: `Closed "${title}"`,
    duration: TRASH_UNDO_TOAST_DURATION_MS,
    action: {
      label: "Undo",
      onClick: restoreAll,
      variant: "primary",
    },
    coalesce: {
      key: COALESCE_KEY,
      windowMs: COALESCE_WINDOW_MS,
      buildMessage: (count) => `Closed ${count} panels`,
      buildInboxMessage: (count) => `Closed ${count} panels`,
      buildAction: () => ({
        label: "Undo",
        onClick: restoreAll,
        variant: "primary" as const,
      }),
    },
  });
}
