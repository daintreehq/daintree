import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTerminalStore, type TerminalInstance } from "@/store/terminalStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import type { WorktreeSnapshot } from "@shared/types";

function isTerminalOrphaned(terminal: TerminalInstance, worktreeIds: Set<string>): boolean {
  const worktreeId = typeof terminal.worktreeId === "string" ? terminal.worktreeId.trim() : "";
  if (!worktreeId) return false;
  if (worktreeIds.size === 0) return false;
  return !worktreeIds.has(worktreeId);
}

function isTerminalVisible(
  terminal: TerminalInstance,
  isInTrash: (id: string) => boolean,
  worktreeIds: Set<string>
): boolean {
  if (isInTrash(terminal.id)) return false;
  if (terminal.location === "trash") return false;
  if (terminal.location === "background") return false;
  if (isTerminalOrphaned(terminal, worktreeIds)) return false;
  return true;
}

let _cachedWorktrees: Map<string, WorktreeSnapshot> | null = null;
let _cachedIds: Set<string> | null = null;

function buildWorktreeIds(worktrees: Map<string, WorktreeSnapshot>): Set<string> {
  if (worktrees === _cachedWorktrees && _cachedIds) return _cachedIds;

  if (_cachedIds && worktrees.size === _cachedIds.size) {
    let keysMatch = true;
    for (const id of worktrees.keys()) {
      if (!_cachedIds.has(id)) {
        keysMatch = false;
        break;
      }
    }
    if (keysMatch) {
      _cachedWorktrees = worktrees;
      return _cachedIds;
    }
  }

  const ids = new Set<string>();
  for (const [id, wt] of worktrees) {
    ids.add(id);
    if (wt.worktreeId) ids.add(wt.worktreeId);
  }
  _cachedWorktrees = worktrees;
  _cachedIds = ids;
  return ids;
}

export function _resetWorktreeIdCacheForTests(): void {
  _cachedWorktrees = null;
  _cachedIds = null;
}

function useWorktreeIds(): Set<string> {
  return useWorktreeStore(useShallow((state) => buildWorktreeIds(state.worktrees)));
}

export function useTerminalNotificationCounts(blurTime?: number | null): {
  waitingCount: number;
} {
  const worktreeIds = useWorktreeIds();

  return useTerminalStore(
    useShallow((state) => {
      if (blurTime === null) {
        return { waitingCount: 0 };
      }

      let waitingCount = 0;

      for (const id of state.terminalIds) {
        const terminal = state.terminalsById[id];
        if (!terminal) continue;
        if (!isTerminalVisible(terminal, state.isInTrash, worktreeIds)) continue;

        if (terminal.agentState !== "waiting") continue;

        if (blurTime !== undefined) {
          if (terminal.lastStateChange == null) continue;
          if (terminal.lastStateChange <= blurTime) continue;
        }

        waitingCount += 1;
      }

      return { waitingCount };
    })
  );
}

export function useWaitingTerminals(): TerminalInstance[] {
  const worktreeIds = useWorktreeIds();
  const terminalIds = useTerminalStore((state) => state.terminalIds);
  const terminalsById = useTerminalStore((state) => state.terminalsById);
  const isInTrash = useTerminalStore((state) => state.isInTrash);

  return useMemo(
    () =>
      terminalIds
        .map((id) => terminalsById[id])
        .filter(
          (t): t is TerminalInstance =>
            !!t && t.agentState === "waiting" && isTerminalVisible(t, isInTrash, worktreeIds)
        ),
    [terminalIds, terminalsById, isInTrash, worktreeIds]
  );
}

export function useWaitingTerminalIds(): string[] {
  const waiting = useWaitingTerminals();
  return useMemo(() => waiting.map((t) => t.id), [waiting]);
}

export function useBackgroundedTerminals(): TerminalInstance[] {
  const worktreeIds = useWorktreeIds();
  const terminalIds = useTerminalStore((state) => state.terminalIds);
  const terminalsById = useTerminalStore((state) => state.terminalsById);

  return useMemo(
    () =>
      terminalIds
        .map((id) => terminalsById[id])
        .filter(
          (t): t is TerminalInstance =>
            !!t && t.location === "background" && !isTerminalOrphaned(t, worktreeIds)
        ),
    [terminalIds, terminalsById, worktreeIds]
  );
}

export function useConflictedWorktrees(): WorktreeSnapshot[] {
  const worktrees = useWorktreeStore((state) => state.worktrees);

  return useMemo(
    () =>
      Array.from(worktrees.values()).filter(
        (w) => w.worktreeChanges?.changes.some((c) => c.status === "conflicted") ?? false
      ),
    [worktrees]
  );
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
      for (const id of state.terminalIds) {
        const t = state.terminalsById[id];
        if (!t) continue;
        if (t.id !== excludeId && (t.location === "grid" || t.location === undefined)) {
          active++;
          if (t.agentState === "working") working++;
        }
      }
      return { activeCount: active, workingCount: working };
    })
  );
}
