import { useShallow } from "zustand/react/shallow";
import { useTerminalStore, type TerminalInstance } from "@/store/terminalStore";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";

function isTerminalOrphaned(terminal: TerminalInstance, worktreeIds: Set<string>): boolean {
  const worktreeId = typeof terminal.worktreeId === "string" ? terminal.worktreeId.trim() : "";
  if (!worktreeId) return false;
  return !worktreeIds.has(worktreeId);
}

function isTerminalVisible(
  terminal: TerminalInstance,
  isInTrash: (id: string) => boolean,
  worktreeIds: Set<string>
): boolean {
  if (isInTrash(terminal.id)) return false;
  if (terminal.location === "trash") return false;
  if (isTerminalOrphaned(terminal, worktreeIds)) return false;
  return true;
}

export function useTerminalNotificationCounts(): { waitingCount: number; failedCount: number } {
  const worktreeIds = useWorktreeDataStore(
    useShallow((state) => {
      const ids = new Set<string>();
      for (const [id, wt] of state.worktrees) {
        ids.add(id);
        if (wt.worktreeId) ids.add(wt.worktreeId);
      }
      return ids;
    })
  );

  return useTerminalStore(
    useShallow((state) => {
      let waitingCount = 0;
      let failedCount = 0;

      for (const terminal of state.terminals) {
        if (!isTerminalVisible(terminal, state.isInTrash, worktreeIds)) continue;
        if (terminal.agentState === "waiting") waitingCount += 1;
        if (terminal.agentState === "failed") failedCount += 1;
      }

      return { waitingCount, failedCount };
    })
  );
}

export function useWaitingTerminals(): TerminalInstance[] {
  const worktreeIds = useWorktreeDataStore(
    useShallow((state) => {
      const ids = new Set<string>();
      for (const [id, wt] of state.worktrees) {
        ids.add(id);
        if (wt.worktreeId) ids.add(wt.worktreeId);
      }
      return ids;
    })
  );

  return useTerminalStore(
    useShallow((state) =>
      state.terminals.filter(
        (t) => t.agentState === "waiting" && isTerminalVisible(t, state.isInTrash, worktreeIds)
      )
    )
  );
}

export function useWaitingTerminalIds(): string[] {
  return useWaitingTerminals().map((t) => t.id);
}

export function useFailedTerminals(): TerminalInstance[] {
  const worktreeIds = useWorktreeDataStore(
    useShallow((state) => {
      const ids = new Set<string>();
      for (const [id, wt] of state.worktrees) {
        ids.add(id);
        if (wt.worktreeId) ids.add(wt.worktreeId);
      }
      return ids;
    })
  );

  return useTerminalStore(
    useShallow((state) =>
      state.terminals.filter(
        (t) => t.agentState === "failed" && isTerminalVisible(t, state.isInTrash, worktreeIds)
      )
    )
  );
}

export function useFailedTerminalIds(): string[] {
  return useFailedTerminals().map((t) => t.id);
}

/**
 * Get background panel stats for Zen Mode header display.
 * Returns count of active (grid) panels excluding the current one, and how many are working.
 * @param excludeId - The ID of the current panel to exclude from counts
 */
export function useBackgroundPanelStats(excludeId: string): {
  activeCount: number;
  workingCount: number;
} {
  return useTerminalStore(
    useShallow((state) => {
      let active = 0;
      let working = 0;
      for (const t of state.terminals) {
        // Only count grid panels (exclude dock and trash), and exclude the current panel
        if (t.id !== excludeId && (t.location === "grid" || t.location === undefined)) {
          active++;
          if (t.agentState === "working") working++;
        }
      }
      return { activeCount: active, workingCount: working };
    })
  );
}
