import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useAgentDiscoveryOnboarding } from "@/hooks/app/useAgentDiscoveryOnboarding";
import { agentStateDotColor } from "@/components/Worktree/AgentStatusIndicator";
import { getRuntimeOrBootAgentId } from "@/utils/terminalType";
import { LAUNCHABLE_AGENT_IDS, isBuiltInAgentId } from "@shared/config/agentIds";
import type { AgentState, PanelInstance } from "@shared/types";
import { isAgentLaunchable } from "../../../shared/utils/agentAvailability";
import { isPtyPanel } from "@shared/types/panel";
import type { AnyToolbarButtonId } from "@/../../shared/types/toolbar";

export type OverflowBadgeSeverity = "critical" | "warning" | "info" | null;

/**
 * Sessions of overflowed agents whose state carries a dot, counted per state.
 * Per PANEL, never per agent type: a `working` session must not hide a
 * sibling `waiting` one — that is exactly what the badge exists to surface,
 * and the trigger's accessible name has to agree with the badge.
 */
export function countOverflowAgentStates(
  panelsById: Record<string, PanelInstance>,
  panelIds: readonly string[],
  activeWorktreeId: string | null,
  overflowIds: readonly AnyToolbarButtonId[]
): Map<AgentState, number> {
  const counts = new Map<AgentState, number>();
  const overflowedAgentSet = new Set<string>();
  for (const id of overflowIds) {
    if (isBuiltInAgentId(id)) overflowedAgentSet.add(id);
  }
  if (overflowedAgentSet.size === 0) return counts;
  for (const pid of panelIds) {
    const p = panelsById[pid];
    if (
      !p ||
      !isPtyPanel(p) ||
      p.location === "trash" ||
      p.location === "background" ||
      p.location === "overlay"
    )
      continue;
    const agentId = getRuntimeOrBootAgentId(p);
    if (!agentId || !overflowedAgentSet.has(agentId)) continue;
    if (activeWorktreeId && p.worktreeId !== activeWorktreeId) continue;
    if (!ACTIVE_AGENT_STATES.has(p.agentState)) continue;
    if (!p.agentState || !agentStateDotColor(p.agentState)) continue;
    counts.set(p.agentState, (counts.get(p.agentState) ?? 0) + 1);
  }
  return counts;
}

/** `["1 agent waiting", "2 agents directing"]` — the words behind the badge. */
export function formatAgentObservations(counts: ReadonlyMap<AgentState, number>): string[] {
  const out: string[] = [];
  for (const [state, count] of counts) {
    out.push(`${count} ${count === 1 ? "agent" : "agents"} ${state}`);
  }
  return out;
}

/**
 * The agent half of the overflow trigger's observations, from the same
 * sessions `useOverflowBadgeSeverity` derives its warning from.
 */
export function useOverflowAgentObservations(overflowIds: readonly AnyToolbarButtonId[]): string[] {
  const panelsById = usePanelStore(useShallow((s) => s.panelsById));
  const panelIds = usePanelStore(useShallow((s) => s.panelIds));
  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);
  return useMemo(
    () =>
      formatAgentObservations(
        countOverflowAgentStates(panelsById, panelIds, activeWorktreeId, overflowIds)
      ),
    [panelsById, panelIds, activeWorktreeId, overflowIds]
  );
}

const ACTIVE_AGENT_STATES: ReadonlySet<AgentState | undefined> = new Set<AgentState | undefined>([
  "idle",
  "working",
  "waiting",
  "directing",
]);

/**
 * Aggregates the highest-severity badge state from buttons currently pushed
 * into the overflow `…` menu so the trigger can surface a single dot rather
 * than silently hiding active state.
 *
 * Hardware-privacy indicators (e.g. voice recording) are pinned out of
 * overflow by the toolbar — they never appear in `overflowIds`, so no
 * branch here handles them.
 *
 * Why a primitive return: keeps Zustand selector identity stable so
 * downstream renders don't churn (lesson #3730). All store reads are
 * unconditional to comply with the rules of hooks; gating happens inside
 * the memo via `overflowIds.includes(...)`.
 */
export function useOverflowBadgeSeverity(
  overflowIds: readonly AnyToolbarButtonId[],
  errorCount: number
): OverflowBadgeSeverity {
  const panelsById = usePanelStore(useShallow((s) => s.panelsById));
  const panelIds = usePanelStore(useShallow((s) => s.panelIds));
  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);

  const notificationUnreadCount = useNotificationHistoryStore((s) => s.unreadCount);

  const availability = useCliAvailabilityStore(useShallow((s) => s.availability));
  const { loaded: onboardingLoaded, seenAgentIds } = useAgentDiscoveryOnboarding();

  return useMemo<OverflowBadgeSeverity>(() => {
    if (overflowIds.length === 0) return null;

    let critical = false;
    let warning = false;
    let info = false;

    if (overflowIds.includes("problems") && errorCount > 0) {
      critical = true;
    }

    // Each panel independently rather than folded to a dominant state —
    // `getDominantAgentState` would let a `working` panel suppress a sibling
    // `waiting`/`directing` panel for the same agent, which is exactly the
    // silenced state the overflow dot is meant to surface.
    if (countOverflowAgentStates(panelsById, panelIds, activeWorktreeId, overflowIds).size > 0) {
      warning = true;
    }

    if (overflowIds.includes("notification-center") && notificationUnreadCount > 0) {
      info = true;
    }

    if (overflowIds.includes("launcher") && onboardingLoaded) {
      const seenSet = new Set(seenAgentIds);
      for (const id of LAUNCHABLE_AGENT_IDS) {
        if (isAgentLaunchable(availability?.[id]) && !seenSet.has(id)) {
          info = true;
          break;
        }
      }
    }

    if (critical) return "critical";
    if (warning) return "warning";
    if (info) return "info";
    return null;
  }, [
    overflowIds,
    errorCount,
    panelsById,
    panelIds,
    activeWorktreeId,
    notificationUnreadCount,
    availability,
    onboardingLoaded,
    seenAgentIds,
  ]);
}
