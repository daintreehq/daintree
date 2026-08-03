import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import type { AgentState } from "@shared/types/agent";
import { isAgentTerminal } from "@/utils/terminalType";
import { isTerminalVisible } from "@/lib/terminalVisibility";
import { isAgentTerminalFleetEligible } from "@/store/fleetEligibility";
import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";

// Per-worktree rollups consumed by the sidebar (terminal counts + agent-state
// flags). These live outside the component so their churn-safety and reactivity
// invariants are unit-testable (#10908): subscribing to the whole `panelsById`
// map re-ran every rollup on each rAF status-buffer flush, because the buffer
// replaces the map reference every flush. The three selectors below read ONLY
// fields the rollups depend on — none of which the buffer writes (it touches
// activity/flow/held/runtimeStatus) — and return flat primitive maps so
// `useShallow` bails on buffer flushes yet still fires on real structural,
// agent-state, or fleet-eligibility changes.

// Orphaning is worktree-scoped, so the intrinsic visibility pass disables
// `isTerminalVisible`'s orphan check with an empty set; `computePanelStateByWorktree`
// re-applies it once per worktree using the live worktree id set.
const EMPTY_WORKTREE_IDS: Set<string> = new Set();

/** Minimal panel-store shape the sidebar derivations read. */
export interface SidebarPanelDerivationState {
  panelIds: readonly string[];
  panelsById: Record<string, PanelInstance>;
  isInTrash: (id: string) => boolean;
}

// The per-worktree rollups iterate `panelsById` rather than `panelIds`: during
// a spawn/hydration batch a panel is committed to `panelsById` and the worktree
// index immediately, but `panelIds` is deferred until the batch flush
// (panelRegistry/core.ts). The old inline rollup walked the worktree index and
// read `panelsById`, so it counted batched panels before flush; keying the flat
// maps off `panelsById` preserves that (#9649). `computePanelStateByWorktree`
// still gates on the worktree index, so extra entries here are simply ignored.

export interface WorktreePanelSummary {
  terminalCount: number;
  waitingTerminalCount: number;
  hasWorkingAgent: boolean;
  hasWaitingAgent: boolean;
  hasCompletedAgent: boolean;
  hasExitedAgent: boolean;
}

/** Panels passing intrinsic visibility (trash/location/persistence), sans orphan. */
export function selectSidebarVisiblePanelIds(
  state: SidebarPanelDerivationState
): Record<string, 1> {
  const result: Record<string, 1> = {};
  for (const id of Object.keys(state.panelsById)) {
    const panel = state.panelsById[id];
    if (panel && isTerminalVisible(panel, state.isInTrash, EMPTY_WORKTREE_IDS)) {
      result[id] = 1;
    }
  }
  return result;
}

/** Agent-state per PTY agent panel (absent when there is no live agent state). */
export function selectSidebarAgentStateByPanelId(
  state: SidebarPanelDerivationState
): Record<string, AgentState> {
  const result: Record<string, AgentState> = {};
  for (const id of Object.keys(state.panelsById)) {
    const panel = state.panelsById[id];
    if (!panel || !isPtyPanel(panel)) continue;
    const agentState = panel.agentState;
    if (!agentState) continue;
    if (!isAgentTerminal(panel)) continue;
    result[id] = agentState;
  }
  return result;
}

/**
 * Agent panels eligible for the sidebar's filter-scoped bulk arm → their
 * worktree id. Agent-scoped rather than terminal-scoped so the quick-filter
 * arm affordance addresses the same terminals as the state filters beside it;
 * plain shells stay armable individually (#11637). `collectFilterArmEligibleIds`
 * applies the same predicate at dispatch time.
 *
 * Shares `isAgentTerminal` with `selectSidebarAgentStateByPanelId` above, so the
 * arm count and the working/waiting chips agree on what counts as an agent —
 * including plugin-contributed ones.
 *
 * `isAgentTerminalFleetEligible` reads `runtimeStatus`, which the buffer writes,
 * but only its exited/error transition flips eligibility and the buffer never
 * sets those on the flow path (`panelStatusBuffer.ts`) — so the eligible set is
 * stable across flushes. The agent-identity fields it adds are not buffer-written
 * either, so the churn-safety invariant above still holds.
 */
export function selectSidebarFleetEligibleWorktreeById(
  state: SidebarPanelDerivationState
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const id of state.panelIds) {
    const panel = getNarrowPanel(state.panelsById, id);
    if (!isAgentTerminalFleetEligible(panel)) continue;
    result[id] = panel.worktreeId ?? "";
  }
  return result;
}

function emptySummary(): WorktreePanelSummary {
  return {
    terminalCount: 0,
    waitingTerminalCount: 0,
    hasWorkingAgent: false,
    hasWaitingAgent: false,
    hasCompletedAgent: false,
    hasExitedAgent: false,
  };
}

/** Roll the flat maps up into per-worktree terminal counts + agent-state flags. */
export function computePanelStateByWorktree(
  worktreeIdList: readonly string[],
  panelIdsByWorktreeId: Record<string, string[]>,
  visiblePanelIds: Record<string, 1>,
  agentStateByPanelId: Record<string, AgentState>,
  worktreeIds: ReadonlySet<string>
): Record<string, WorktreePanelSummary> {
  const result: Record<string, WorktreePanelSummary> = {};
  for (const worktreeId of worktreeIdList) {
    const ids = panelIdsByWorktreeId[worktreeId];
    // Every panel indexed under `worktreeId` carries that worktreeId, so the
    // orphan check is constant across the group and evaluated once here.
    const worktreeOrphaned = worktreeIds.size > 0 && !worktreeIds.has(worktreeId);
    if (!ids || ids.length === 0 || worktreeOrphaned) {
      result[worktreeId] = emptySummary();
      continue;
    }
    const summary = emptySummary();
    for (const id of ids) {
      if (!visiblePanelIds[id]) continue;
      summary.terminalCount++;
      const agentState = agentStateByPanelId[id];
      if (!agentState) continue;
      if (agentState === "working") summary.hasWorkingAgent = true;
      if (agentState === "waiting") {
        summary.hasWaitingAgent = true;
        summary.waitingTerminalCount++;
      }
      if (agentState === "completed") summary.hasCompletedAgent = true;
      if (agentState === "exited") summary.hasExitedAgent = true;
    }
    result[worktreeId] = summary;
  }
  return result;
}
