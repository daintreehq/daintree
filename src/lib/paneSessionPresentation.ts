import type { AgentState, WaitingReason } from "@shared/types/agent";
import { isObservedAskWait } from "@shared/utils/runHandBack";
import type { FleetBand, UnseenAsk } from "@/lib/fleetAttention";

/**
 * A session as its glyph draws it, on the pane and everywhere else the run
 * shows: the observed states, plus `unread` for a hand-back the user hasn't
 * read and `blocked` for an error wait, which takes the failure mark rather
 * than the waiting ring. Both are presentation only: `data-agent-state` and
 * MCP keep reporting what was observed.
 */
export type SessionPresentationState = AgentState | "unread" | "blocked";

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
 * pane last saw it. What the amber glyph and the counts stand for; the pane
 * edge reads the wider {@link isUnseenAskPane}.
 */
export function isNeedsYouPane(
  needsYouRunIds: ReadonlySet<string>,
  panel: PaneObservation & { id: string }
): boolean {
  return needsYouRunIds.has(panel.id) && isStillStopped(panel);
}

/**
 * A pane whose current stop the fleet reads as an ask the user hasn't seen
 * (`runUnseenAsk`), and the pane's own newer observation still agrees. What the
 * full-pane amber edge draws for, the pane's own or a hidden tab's.
 *
 * Canopy's reading holds for the turn it read, whatever stop the pane has
 * slid to since, so it only needs the run still stopped. An observed ask is
 * the wait itself: once the pane shows anything but an approval or question
 * wait, the fleet is a poll behind and the ask is over.
 */
export function isUnseenAskPane(ask: UnseenAsk | undefined, pane: PaneObservation): boolean {
  if (ask === undefined || !isStillStopped(pane)) return false;
  if (ask === "canopy") return true;
  return pane.agentState !== undefined && isObservedAskWait(pane.agentState, pane.waitingReason);
}

/**
 * The glyph for a run, from its display state, its fleet band and what its
 * pane last observed: the pane header's, and every other surface that draws
 * the run (dock, tabs, switcher, sidebar, Canopy), so they all agree.
 *
 * The display state keeps every live agent visible by drawing a quiet one as
 * `waiting`, so the band decides what that wait is: an unread Canopy ask is the
 * amber ring, a hand-back or an unread wait is the unread mark, a read one is
 * finished, and an error wait is blocked. Everything else — a prompt that asks
 * nothing, a seen ask, the user's own park or snooze, or no fleet report yet —
 * resolves to nothing, since none of them is news: list rows leave it unmarked,
 * and the pane header, whose glyph is its permanent status, draws its own grey
 * waiting ring. Work in flight keeps the state observed. The grid edge's amber
 * is {@link isUnseenAskPane}, which an observed ask reaches too: the edge marks
 * the moment, the glyph keeps to the band.
 */
export function resolvePaneSessionPresentation(
  displayState: AgentState | undefined,
  band: FleetBand | undefined,
  observed: PaneObservation = {}
): SessionPresentationState | undefined {
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
