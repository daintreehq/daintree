import type { BuiltInAgentId } from "@shared/config/agentIds";
import {
  isGridPanelLocation,
  isPtyPanel,
  type PanelInstance,
  type PtyPanelData,
} from "@shared/types/panel";
import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import { getBuiltInRuntimeAgentId, isAgentTerminal } from "@/utils/terminalType";

// Carrier element from the legacy `panelsById` shape, sourced through
// `getNarrowPanel`'s parameter so this file doesn't import the deprecated
// `TerminalInstance` alias by name. Lets external callers that still hand
// out raw carrier entries pass through these predicates while the rest of
// the renderer migrates to `getNarrowPanel` (#8957).
type CarrierPanel = Parameters<typeof getNarrowPanel>[0][string];

/**
 * Fleet membership/broadcast predicate: the terminal has a writable PTY and is
 * in a location where Fleet should address it. Dock terminals are excluded —
 * the collapsed dock surface has no room to render the armed/follower visual
 * state that warns a user their keystrokes are being broadcast.
 */
export function isTerminalFleetEligible(
  t: PanelInstance | CarrierPanel | undefined
): t is PtyPanelData {
  if (!t) return false;
  if (!isPtyPanel(t)) return false;
  if (!isGridPanelLocation(t.location)) return false;
  if (t.hasPty === false) return false;
  // `runtimeStatus` is the renderer's authoritative liveness signal. `hasPty`
  // can lag after backend snapshots/reconnect for panels preserved after exit.
  if (t.runtimeStatus === "exited" || t.runtimeStatus === "error") return false;
  return true;
}

/**
 * Cluster-error predicate: the terminal is in a valid location and not
 * snapshot-stale, but post-exit `runtimeStatus` is *expected* — these are the
 * terminals the error cluster is meant to surface. Used by the agent-cluster
 * hook in place of `isTerminalFleetEligible` for the "exited with errors"
 * bucket only; `prompt` and `completion` buckets keep the full eligibility
 * gate because their downstream actions assume a live PTY.
 */
export function isTerminalErrorClusterEligible(
  t: PanelInstance | CarrierPanel | undefined
): t is PtyPanelData {
  if (!t) return false;
  if (!isPtyPanel(t)) return false;
  if (!isGridPanelLocation(t.location)) return false;
  if (t.hasPty === false) return false;
  return true;
}

/**
 * Agent capability for agent-specific Fleet actions.
 *
 * Broadcast can target any live terminal. Accept/reject/interrupt/restart
 * still require an agent identity because those actions depend on agent state.
 */
export function resolveFleetAgentCapabilityId(
  t: PanelInstance | CarrierPanel | undefined
): BuiltInAgentId | undefined {
  if (!t || !isPtyPanel(t)) return undefined;
  return getBuiltInRuntimeAgentId(t);
}

export function isAgentFleetActionEligible(
  t: PanelInstance | CarrierPanel | undefined
): t is PtyPanelData {
  return isTerminalFleetEligible(t) && resolveFleetAgentCapabilityId(t) !== undefined;
}

/**
 * Predicate for the sidebar's filter-scoped bulk arm, which addresses agents
 * rather than terminals. (The ribbon's state presets still run on the built-in
 * predicate below — a separate, pre-existing gap, not this one.)
 *
 * Deliberately NOT `isAgentFleetActionEligible`: that one resolves a *built-in*
 * capability id because accept/reject/interrupt/restart drive built-in agent
 * protocols. Arming just adds a terminal to the broadcast set, so any agent
 * qualifies — gating on built-ins would silently drop plugin- and
 * user-contributed agents, whose ids are non-built-in by construction (#11637).
 * Matches `isAgentTerminal`, which the sidebar already uses for the agent-state
 * rollups behind the quick state filters this sits beside.
 */
export function isAgentTerminalFleetEligible(
  t: PanelInstance | CarrierPanel | undefined
): t is PtyPanelData {
  return isTerminalFleetEligible(t) && isAgentTerminal(t);
}

export function isFleetWaitingAgentEligible(
  t: PanelInstance | CarrierPanel | undefined
): t is PtyPanelData {
  return isAgentFleetActionEligible(t) && t.agentState === "waiting";
}

export function isFleetInterruptAgentEligible(
  t: PanelInstance | CarrierPanel | undefined
): t is PtyPanelData {
  return (
    isAgentFleetActionEligible(t) && (t.agentState === "working" || t.agentState === "waiting")
  );
}

export function isFleetRestartAgentEligible(
  t: PanelInstance | CarrierPanel | undefined
): t is PtyPanelData {
  return isAgentFleetActionEligible(t);
}
