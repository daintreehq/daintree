import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useUIStore } from "@/store/uiStore";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";
import { useCanopyStore } from "@/store/canopyStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useAgentDiscoveryOnboarding } from "@/hooks/app/useAgentDiscoveryOnboarding";
import { agentStateDotColor } from "@/components/Worktree/terminalStateConfig";
import { getRuntimeOrBootAgentId } from "@/utils/terminalType";
import { BUILT_IN_AGENT_IDS, isBuiltInAgentId } from "@shared/config/agentIds";
import type { AgentState, PanelInstance } from "@shared/types";
import { isAgentLaunchable } from "../../../shared/utils/agentAvailability";
import { isPtyPanel } from "@shared/types/panel";
import type { AnyToolbarButtonId } from "@/../../shared/types/toolbar";
import { pluralize } from "@/lib/pluralize";
import { isHandBackWait } from "@/lib/handBackPresentation";
import { useHandBackRunIds } from "@/hooks/useRunHandBackState";

const NO_HAND_BACKS: ReadonlySet<string> = new Set();

/**
 * The overflow trigger's mark, named for what it draws — the shape the hidden
 * button itself would wear: `critical` an error square, `waiting` the waiting
 * ring (something asking for the user), `warning` the rounded warning square (a
 * passive fault in the user's own project), `notice` the same shape in
 * neutral ink (external data the app couldn't fetch — the Forge capsule's
 * warning, which is neutral on the strip and stays neutral folded away),
 * `info` the neutral dot. Ranked in that order.
 */
export type OverflowBadgeSeverity = "critical" | "waiting" | "warning" | "notice" | "info" | null;

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
  overflowIds: readonly AnyToolbarButtonId[],
  handBackRunIds: ReadonlySet<string> = NO_HAND_BACKS
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
    // A hand-back is not asking for anything, so it earns no dot.
    if (isHandBackWait(handBackRunIds, p)) continue;
    counts.set(p.agentState, (counts.get(p.agentState) ?? 0) + 1);
  }
  return counts;
}

/** `["1 agent waiting", "2 agents directing"]` — the words behind the badge. */
export function formatAgentObservations(counts: ReadonlyMap<AgentState, number>): string[] {
  const out: string[] = [];
  for (const [state, count] of counts) {
    out.push(`${pluralize(count, "agent")} ${state}`);
  }
  return out;
}

/**
 * The agent half of the overflow trigger's observations, from the same
 * sessions `useOverflowBadgeSeverity` derives its warning from.
 */
export function useOverflowAgentObservations(overflowIds: readonly AnyToolbarButtonId[]): string[] {
  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);
  const handBackRunIds = useHandBackRunIds();
  // Derived inside the selector: every activity/headline flush replaces a
  // panel object, which a shallow `panelsById` subscription treats as a change
  // and re-renders the whole toolbar for.
  return usePanelStore(
    useShallow((s) =>
      formatAgentObservations(
        countOverflowAgentStates(
          s.panelsById,
          s.panelIds,
          activeWorktreeId,
          overflowIds,
          handBackRunIds
        )
      )
    )
  );
}

/**
 * Whether a launcher folded into `overflowIds` is carrying its discovery dot —
 * a launchable agent the user hasn't seen yet. Shared by the badge and the
 * trigger's name, so the dot is never unexplained.
 */
export function useOverflowLauncherDiscovery(overflowIds: readonly AnyToolbarButtonId[]): boolean {
  const availability = useCliAvailabilityStore(useShallow((s) => s.availability));
  const { loaded, seenAgentIds } = useAgentDiscoveryOnboarding();
  return useMemo(() => {
    if (!overflowIds.includes("launcher") || !loaded) return false;
    const seen = new Set(seenAgentIds);
    return BUILT_IN_AGENT_IDS.some((id) => isAgentLaunchable(availability?.[id]) && !seen.has(id));
  }, [overflowIds, loaded, seenAgentIds, availability]);
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
  errorCount: number,
  /** Asks Canopy reads as urgent, for its button folded into the menu. */
  canopyUrgentCount = 0,
  /** File watching is degraded or the topology watcher went dark. */
  watcherUnreliable = false,
  /** The Forge capsule is showing its "data unavailable" warning. */
  forgeUnavailable = false
): OverflowBadgeSeverity {
  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);
  const handBackRunIds = useHandBackRunIds();
  // A boolean, not `panelsById`, so activity/headline flushes that replace
  // panel objects without changing a dot state don't re-render the toolbar.
  // Only a wait asks for anything; a directing session is ambient. A primitive
  // ("waiting" / "directing" / null) so the selector stays stable.
  const overflowAgentTier = usePanelStore((s) => {
    const counts = countOverflowAgentStates(
      s.panelsById,
      s.panelIds,
      activeWorktreeId,
      overflowIds,
      handBackRunIds
    );
    if (counts.has("waiting")) return "waiting" as const;
    return counts.size > 0 ? ("directing" as const) : null;
  });

  const notificationUnreadCount = useNotificationHistoryStore((s) => s.unreadCount);
  // A mark stands down while the surface it reports on is open, from the `…`
  // trigger as from the button itself.
  const notificationCenterOpen = useUIStore((s) => s.notificationCenterOpen);
  const diagnosticsOpen = useDiagnosticsStore((s) => s.isOpen);
  const canopyOpen = useCanopyStore((s) => s.isOpen);

  const availability = useCliAvailabilityStore(useShallow((s) => s.availability));
  const { loaded: onboardingLoaded, seenAgentIds } = useAgentDiscoveryOnboarding();

  return useMemo<OverflowBadgeSeverity>(() => {
    if (overflowIds.length === 0) return null;

    let critical = false;
    let waiting = false;
    let warning = false;
    let notice = false;
    let info = false;

    if (overflowIds.includes("problems") && errorCount > 0 && !diagnosticsOpen) {
      critical = true;
    }

    // Each panel independently rather than folded to a dominant state —
    // `getDominantAgentState` would let a `working` panel suppress a sibling
    // `waiting`/`directing` panel for the same agent, which is exactly the
    // silenced state the overflow dot is meant to surface.
    if (overflowAgentTier === "waiting") {
      waiting = true;
    } else if (overflowAgentTier === "directing") {
      info = true;
    }

    // The problems button's watcher warning, which it shows even with no
    // errors; folded away, it would otherwise vanish.
    if (overflowIds.includes("problems") && watcherUnreliable && !diagnosticsOpen) {
      warning = true;
    }

    // The capsule's stale-data mark, folded away with it, at the loudness it
    // had on the strip.
    if (overflowIds.includes("forge-stats") && forgeUnavailable) {
      notice = true;
    }

    if (overflowIds.includes("canopy") && canopyUrgentCount > 0 && !canopyOpen) {
      waiting = true;
    }

    if (
      overflowIds.includes("notification-center") &&
      notificationUnreadCount > 0 &&
      !notificationCenterOpen
    ) {
      info = true;
    }

    if (overflowIds.includes("launcher") && onboardingLoaded) {
      const seenSet = new Set(seenAgentIds);
      for (const id of BUILT_IN_AGENT_IDS) {
        if (isAgentLaunchable(availability?.[id]) && !seenSet.has(id)) {
          info = true;
          break;
        }
      }
    }

    if (critical) return "critical";
    if (waiting) return "waiting";
    if (warning) return "warning";
    if (notice) return "notice";
    if (info) return "info";
    return null;
  }, [
    overflowIds,
    errorCount,
    canopyUrgentCount,
    watcherUnreliable,
    forgeUnavailable,
    overflowAgentTier,
    notificationCenterOpen,
    diagnosticsOpen,
    canopyOpen,
    notificationUnreadCount,
    availability,
    onboardingLoaded,
    seenAgentIds,
  ]);
}
