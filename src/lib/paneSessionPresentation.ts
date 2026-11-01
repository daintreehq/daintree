import type { AgentState, WaitingReason } from "@shared/types/agent";
import type { FleetBand } from "@/lib/fleetAttention";
import type { SessionPresentationState } from "@/lib/handBackPresentation";

/**
 * What a pane header's agent glyph draws: the session states, plus `blocked`
 * for an error wait, which takes the header's failure mark rather than the
 * waiting ring. Presentation only, like `unread`.
 */
export type PaneSessionPresentationState = SessionPresentationState | "blocked";

/** What a pane last observed of its own run, as the panel store holds it. */
export interface PaneObservation {
  agentState?: AgentState;
  waitingReason?: WaitingReason;
  isRestarting?: boolean;
  runtimeStatus?: string;
}

/**
 * The pane's own observation still has the run stopped where it could be
 * asking. The band is main's polled read and the pane's state is pushed, so the
 * pane can be a beat ahead of it: amber must not outlive a reply that set the
 * agent working again, a restart, an exit on record, or a wait that has turned
 * into an error. An exit is `runtimeStatus: "exited"`, exactly what a shown
 * pane reads its own from (`useTerminalLogic`), so a hidden tab and the same
 * pane in front agree; a leftover `"error"` or exit code after a successful
 * restart is not one.
 */
function isStillStopped(pane: PaneObservation): boolean {
  if (pane.isRestarting === true || pane.runtimeStatus === "exited") return false;
  const { agentState } = pane;
  if (agentState === "working" || agentState === "directing" || agentState === "exited") {
    return false;
  }
  return !(agentState === "waiting" && pane.waitingReason === "error");
}

/**
 * A pane the fleet places in `needs-you` — Canopy read an ask on its current
 * turn that the user hasn't had in front of them — and still stopped as the
 * pane last saw it. The only thing pane chrome draws amber for.
 */
export function isNeedsYouPane(
  needsYouRunIds: ReadonlySet<string>,
  panel: PaneObservation & { id: string }
): boolean {
  return needsYouRunIds.has(panel.id) && isStillStopped(panel);
}

/**
 * The header glyph for a pane, from its display state, its fleet band and what
 * the pane itself last observed.
 *
 * The display state keeps every live agent visible by drawing a quiet one as
 * `waiting`, so the band decides what that wait is: an unread Canopy ask is the
 * amber ring, a hand-back or an unread wait is the unread mark, a read one is
 * finished, and an error wait is blocked. Everything else — a prompt that asks
 * nothing, a seen ask, the user's own park or snooze, or no fleet report yet —
 * draws no glyph, since none of them is news. Work in flight keeps the state
 * observed. The grid edge reads its amber from here too, so the two agree.
 */
export function resolvePaneSessionPresentation(
  displayState: AgentState | undefined,
  band: FleetBand | undefined,
  observed: PaneObservation = {}
): PaneSessionPresentationState | undefined {
  if (displayState !== "waiting") return displayState;
  switch (band) {
    case "needs-you":
      return isStillStopped(observed) ? "waiting" : undefined;
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
