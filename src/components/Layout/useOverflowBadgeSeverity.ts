import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useAgentDiscoveryOnboarding } from "@/hooks/app/useAgentDiscoveryOnboarding";
import { agentStateDotColor } from "@/components/Worktree/AgentStatusIndicator";
import { getRuntimeOrBootAgentId } from "@/utils/terminalType";
import { BUILT_IN_AGENT_IDS, type BuiltInAgentId } from "@shared/config/agentIds";
import type { AgentState } from "@shared/types";
import { isAgentLaunchable } from "../../../shared/utils/agentAvailability";
import type { AnyToolbarButtonId } from "@/../../shared/types/toolbar";

export type OverflowBadgeSeverity = "critical" | "warning" | "info" | null;

const ACTIVE_AGENT_STATES: ReadonlySet<AgentState | undefined> = new Set<AgentState | undefined>([
  "idle",
  "working",
  "waiting",
  "directing",
]);

const BUILT_IN_AGENT_ID_SET: ReadonlySet<string> = new Set<string>(BUILT_IN_AGENT_IDS);

function isBuiltInAgentId(id: AnyToolbarButtonId): id is BuiltInAgentId {
  return BUILT_IN_AGENT_ID_SET.has(id);
}

/**
 * Aggregates the highest-severity badge state from buttons currently pushed
 * into the overflow `…` menu so the trigger can surface a single dot rather
 * than silently hiding active state.
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

    // voice-recording is only registered when actively recording — its
    // mere presence in overflow signals a live session.
    if (overflowIds.includes("voice-recording")) {
      warning = true;
    }

    const overflowedAgentIds: BuiltInAgentId[] = [];
    for (const id of overflowIds) {
      if (isBuiltInAgentId(id)) overflowedAgentIds.push(id);
    }
    if (overflowedAgentIds.length > 0) {
      const overflowedAgentSet = new Set<string>(overflowedAgentIds);
      // Check each panel independently rather than folding to a dominant
      // state — `getDominantAgentState` would let a `working` panel
      // suppress a sibling `waiting`/`directing` panel for the same
      // agent, which is exactly the silenced-state the overflow dot is
      // meant to surface.
      for (const pid of panelIds) {
        const p = panelsById[pid];
        if (!p || p.location === "trash" || p.location === "background") continue;
        const agentId = getRuntimeOrBootAgentId(p);
        if (!agentId || !overflowedAgentSet.has(agentId)) continue;
        if (activeWorktreeId && p.worktreeId !== activeWorktreeId) continue;
        if (!ACTIVE_AGENT_STATES.has(p.agentState)) continue;
        if (p.agentState && agentStateDotColor(p.agentState)) {
          warning = true;
          break;
        }
      }
    }

    if (overflowIds.includes("notification-center") && notificationUnreadCount > 0) {
      info = true;
    }

    if (overflowIds.includes("agent-tray") && onboardingLoaded) {
      const seenSet = new Set(seenAgentIds);
      for (const id of BUILT_IN_AGENT_IDS) {
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
