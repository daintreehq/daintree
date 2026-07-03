import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import type { WorktreeSnapshot } from "@shared/types";
import { isPtyPanel, type PtyPanelData } from "@shared/types/panel";
import { getNarrowPanels } from "@/store/slices/panelRegistry/selectors";
import { isTerminalOrphaned, isTerminalVisible } from "@/lib/terminalVisibility";
import { isTerminalErrorClusterEligible } from "@/store/fleetEligibility";
export { isTerminalOrphaned, isTerminalVisible };

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

export function useWorktreeIds(): Set<string> {
  return useWorktreeStore(useShallow((state) => buildWorktreeIds(state.worktrees)));
}

export function useTerminalNotificationCounts(blurTime?: number | null): {
  waitingCount: number;
} {
  const worktreeIds = useWorktreeIds();

  return usePanelStore(
    useShallow((state) => {
      if (blurTime === null) {
        return { waitingCount: 0 };
      }

      let waitingCount = 0;

      for (const panel of getNarrowPanels(state.panelsById, state.panelIds)) {
        if (!isPtyPanel(panel)) continue;
        if (!isTerminalVisible(panel, state.isInTrash, worktreeIds)) continue;

        if (panel.agentState !== "waiting") continue;

        if (blurTime !== undefined) {
          if (panel.lastStateChange == null) continue;
          if (panel.lastStateChange <= blurTime) continue;
        }

        waitingCount += 1;
      }

      return { waitingCount };
    })
  );
}

export function useWaitingTerminals(): PtyPanelData[] {
  const worktreeIds = useWorktreeIds();

  return usePanelStore(
    useShallow((state) => {
      const out: PtyPanelData[] = [];
      for (const panel of getNarrowPanels(state.panelsById, state.panelIds)) {
        if (!isPtyPanel(panel)) continue;
        if (panel.agentState !== "waiting") continue;
        if (!isTerminalVisible(panel, state.isInTrash, worktreeIds)) continue;
        out.push(panel);
      }
      return out;
    })
  );
}

export function useWaitingTerminalIds(): string[] {
  const waiting = useWaitingTerminals();
  return useMemo(() => waiting.map((t) => t.id), [waiting]);
}

export function useErrorTerminals(): PtyPanelData[] {
  const worktreeIds = useWorktreeIds();

  return usePanelStore(
    useShallow((state) => {
      const out: PtyPanelData[] = [];
      for (const panel of getNarrowPanels(state.panelsById, state.panelIds)) {
        if (!isPtyPanel(panel)) continue;
        if (panel.agentState !== "exited") continue;
        if (typeof panel.exitCode !== "number" || panel.exitCode === 0) continue;
        // isTerminalVisible rejects trash/background/excluded/orphaned;
        // isTerminalErrorClusterEligible adds the dock-location exclusion.
        // Without the orphan gate, clicking an entry from a deleted worktree
        // would call selectWorktree() on a stale ID and persist it.
        if (!isTerminalVisible(panel, state.isInTrash, worktreeIds)) continue;
        if (!isTerminalErrorClusterEligible(panel)) continue;
        out.push(panel);
      }
      return out;
    })
  );
}

export function useBackgroundedTerminals(): PtyPanelData[] {
  const worktreeIds = useWorktreeIds();

  return usePanelStore(
    useShallow((state) => {
      const out: PtyPanelData[] = [];
      for (const panel of getNarrowPanels(state.panelsById, state.panelIds)) {
        if (!isPtyPanel(panel)) continue;
        if (panel.location !== "background") continue;
        if (isTerminalOrphaned(panel, worktreeIds)) continue;
        out.push(panel);
      }
      return out;
    })
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

const EMPTY_BACKGROUND_PANEL_STATS = Object.freeze({
  activeCount: 0,
  workingCount: 0,
  waitingCount: 0,
});

/**
 * Get background panel stats for Zen Mode header display.
 * Returns count of active (grid) panels excluding the current one, and how many are
 * working (churning) vs waiting (blocked on the user) — the latter is otherwise
 * invisible while a single panel is maximized, since the other grid panels unmount.
 * @param excludeId - The ID of the current panel to exclude from counts
 * @param enabled - When false (panel not maximized), skips the per-write panel scan
 */
export function useBackgroundPanelStats(
  excludeId: string,
  enabled = true
): {
  activeCount: number;
  workingCount: number;
  waitingCount: number;
} {
  return usePanelStore(
    useShallow((state) => {
      if (!enabled) return EMPTY_BACKGROUND_PANEL_STATS;
      let active = 0;
      let working = 0;
      let waiting = 0;
      for (const panel of getNarrowPanels(state.panelsById, state.panelIds)) {
        if (panel.id !== excludeId && (panel.location === "grid" || panel.location === undefined)) {
          active++;
          if (isPtyPanel(panel)) {
            if (panel.agentState === "working") working++;
            else if (panel.agentState === "waiting") waiting++;
          }
        }
      }
      return { activeCount: active, workingCount: working, waitingCount: waiting };
    })
  );
}
