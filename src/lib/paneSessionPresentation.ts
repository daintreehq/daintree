import type { AgentState, WaitingReason } from "@shared/types/agent";
import type { FleetBand } from "@/lib/fleetAttention";
import type { SessionPresentationState } from "@/lib/handBackPresentation";

/**
 * What a pane header's agent glyph draws: the session states, plus `blocked`
 * for an error wait, which takes the header's failure mark rather than the
 * waiting ring. Presentation only, like `unread`.
 */
export type PaneSessionPresentationState = SessionPresentationState | "blocked";

/**
 * The pane's own observation still has the run stopped where it could be
 * asking. The band is main's polled read and the pane's state is pushed, so the
 * pane can be a beat ahead of it: amber must not outlive a reply that set the
 * agent working again, an exit, or a wait that has turned into an error.
 */
function isStillStopped(agentState: AgentState | undefined, waitingReason?: WaitingReason) {
  if (agentState === "working" || agentState === "directing" || agentState === "exited") {
    return false;
  }
  return !(agentState === "waiting" && waitingReason === "error");
}

/**
 * A pane the fleet places in `needs-you` — Canopy read an ask on its current
 * turn that the user hasn't had in front of them — and still stopped as the
 * pane last saw it. The only thing pane chrome draws amber for.
 */
export function isNeedsYouPane(
  needsYouRunIds: ReadonlySet<string>,
  panel: { id: string; agentState?: AgentState; waitingReason?: WaitingReason }
): boolean {
  return needsYouRunIds.has(panel.id) && isStillStopped(panel.agentState, panel.waitingReason);
}

/**
 * The header glyph for a pane, from its display state and its fleet band.
 *
 * The display state keeps every live agent visible by drawing a quiet one as
 * `waiting`, so the band decides what that wait is: an unread Canopy ask is the
 * amber ring, a hand-back or an unread wait is the unread mark, a read one is
 * finished, and an error wait is blocked. Everything else — a prompt that asks
 * nothing, a seen ask, the user's own park or snooze, or no fleet report yet —
 * draws no glyph, since none of them is news. Work in flight keeps the state
 * observed.
 */
export function resolvePaneSessionPresentation(
  displayState: AgentState | undefined,
  band: FleetBand | undefined,
  waitingReason?: WaitingReason
): PaneSessionPresentationState | undefined {
  if (displayState !== "waiting") return displayState;
  switch (band) {
    case "needs-you":
      return waitingReason === "error" ? undefined : "waiting";
    case "review":
      return "unread";
    case "done":
      return "completed";
    case "blocked":
      return "blocked";
    default:
      return undefined;
  }
}
