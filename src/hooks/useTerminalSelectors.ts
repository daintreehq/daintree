import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import type { WorktreeSnapshot } from "@shared/types";
import { isPtyPanel, type PtyPanelData } from "@shared/types/panel";
import { getNarrowPanels } from "@/store/slices/panelRegistry/selectors";
import { panelMatchesWorktreeScope } from "@/store/slices/panelRegistry/worktreeIndex";
import { isTerminalOrphaned, isTerminalVisible } from "@/lib/terminalVisibility";
import { isTerminalErrorClusterEligible } from "@/store/fleetEligibility";
import { isNeedsYouPane } from "@/lib/paneSessionPresentation";
import { useFleetBandRunIds } from "@/hooks/useRunFleetBand";
import {
  ATTENTION_FILTER_BANDS,
  DEMAND_BANDS,
  NEEDS_YOU_BANDS,
  UNREAD_FILTER_BANDS,
  type FleetBand,
} from "@/lib/fleetAttention";
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
  // Only an unread Canopy ask reaches the title's `(N)` or the Dock badge — the
  // same call every other waiting count makes. A prompt that asks nothing and
  // a hand-back don't.
  const needsYouRunIds = useFleetBandRunIds(NEEDS_YOU_BANDS);

  return usePanelStore(
    useShallow((state) => {
      if (blurTime === null) {
        return { waitingCount: 0 };
      }

      let waitingCount = 0;

      for (const panel of getNarrowPanels(state.panelsById, state.panelIds)) {
        if (!isPtyPanel(panel)) continue;
        if (!isTerminalVisible(panel, state.isInTrash, worktreeIds)) continue;

        if (!isNeedsYouPane(needsYouRunIds, panel)) continue;

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

const EMPTY_TERMINALS: PtyPanelData[] = [];

/**
 * Visible terminals whose fleet run sits in `bands`, so the dock's pills hold
 * the same agents as the sidebar's buckets and Pilot. A terminal the fleet has
 * not reported belongs to none of them.
 */
function useFleetBandTerminals(bands: ReadonlySet<FleetBand>): PtyPanelData[] {
  const worktreeIds = useWorktreeIds();
  const runIds = useFleetBandRunIds(bands);

  return usePanelStore(
    useShallow((state) => {
      if (runIds.size === 0) return EMPTY_TERMINALS;
      const out: PtyPanelData[] = [];
      for (const panel of getNarrowPanels(state.panelsById, state.panelIds)) {
        if (!runIds.has(panel.id)) continue;
        if (!isPtyPanel(panel)) continue;
        if (!isTerminalVisible(panel, state.isInTrash, worktreeIds)) continue;
        out.push(panel);
      }
      return out;
    })
  );
}

/**
 * Agents asking for something: the sidebar's Attention bucket. A hand-back is
 * not one of them unless Canopy read an ask in it, and a parked or snoozed
 * agent has been shelved by the user.
 */
export function useWaitingTerminals(): PtyPanelData[] {
  return useFleetBandTerminals(ATTENTION_FILTER_BANDS);
}

/** Hand-backs nobody has read yet: the unread half of the sidebar's Finished bucket. */
export function useUnreadTerminals(): PtyPanelData[] {
  return useFleetBandTerminals(UNREAD_FILTER_BANDS);
}

/**
 * How many agents the dock's Waiting and Unread pills hold between them, as a
 * primitive so a member's streaming output doesn't re-render the reader.
 */
export function useDemandTerminalCount(): number {
  const worktreeIds = useWorktreeIds();
  const runIds = useFleetBandRunIds(DEMAND_BANDS);

  return usePanelStore((state) => {
    if (runIds.size === 0) return 0;
    let count = 0;
    for (const panel of getNarrowPanels(state.panelsById, state.panelIds)) {
      if (!runIds.has(panel.id)) continue;
      if (!isPtyPanel(panel)) continue;
      if (!isTerminalVisible(panel, state.isInTrash, worktreeIds)) continue;
      count += 1;
    }
    return count;
  });
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
 * What the Zen Mode header says about the panes a maximized one is hiding.
 *
 * `activeCount` counts what the grid would show around it: the other cells of
 * the same worktree's grid, a tab group being one cell however many tabs it
 * holds. Counted any other way the number could not be reconciled with the
 * layout the user just left (seven tabs read as seven panes, another
 * worktree's panes as this one's). The pane's own tab group is left out of
 * everything, since its tabs stay on screen in the maximized header.
 *
 * `workingCount` and `waitingCount` count agents in those cells, background
 * tabs included: an agent in a tab nobody can see is exactly the one the
 * readout is for.
 * @param excludeId - The maximized panel
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
  const needsYouRunIds = useFleetBandRunIds(NEEDS_YOU_BANDS);
  return usePanelStore(
    useShallow((state) => {
      if (!enabled) return EMPTY_BACKGROUND_PANEL_STATS;
      const groupOf = new Map<string, string>();
      for (const [groupId, group] of state.tabGroups ?? []) {
        if (group.location !== "grid") continue;
        for (const id of group.panelIds) groupOf.set(id, groupId);
      }
      const scope = state.panelsById[excludeId]?.worktreeId;
      const ownGroup = groupOf.get(excludeId);
      const cells = new Set<string>();
      let working = 0;
      let waiting = 0;
      for (const panel of getNarrowPanels(state.panelsById, state.panelIds)) {
        if (panel.id === excludeId) continue;
        if (panel.location !== "grid" && panel.location !== undefined) continue;
        if (!panelMatchesWorktreeScope(panel.worktreeId, scope, "grid")) continue;
        const groupId = groupOf.get(panel.id);
        if (groupId !== undefined && groupId === ownGroup) continue;
        cells.add(groupId ?? panel.id);
        if (isPtyPanel(panel)) {
          if (panel.agentState === "working") working++;
          else if (isNeedsYouPane(needsYouRunIds, panel)) waiting++;
        }
      }
      return { activeCount: cells.size, workingCount: working, waitingCount: waiting };
    })
  );
}
