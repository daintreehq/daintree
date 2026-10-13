import type { AgentState, WaitingReason } from "@shared/types/agent";
import type { FleetSnapshot } from "@shared/types/ipc/fleet";
import { isHandBackStop, isHandBackUnseen } from "@shared/utils/runHandBack";

/** What the fleet knows about a run's last hand-back, reduced to what a glyph needs. */
export type HandBackSeenState = "none" | "unseen" | "seen";

/**
 * A session as its glyph draws it. `unread` is presentation only: an agent that
 * handed its turn back and the user has not read it. It never reaches
 * `data-agent-state` or MCP, which keep reporting what was observed.
 */
export type SessionPresentationState = AgentState | "unread";

const indexCache = new WeakMap<FleetSnapshot, Map<string, HandBackSeenState>>();

function indexSnapshot(snapshot: FleetSnapshot): Map<string, HandBackSeenState> {
  const cached = indexCache.get(snapshot);
  if (cached) return cached;
  const index = new Map<string, HandBackSeenState>();
  for (const run of snapshot.runs) {
    // The fleet's own observation must still be a hand-back stop: a record
    // outlives the stop it was made for until main clears it.
    if (run.handBack === undefined || run.agentState === undefined) continue;
    if (!isHandBackStop(run.agentState, run.waitingReason)) continue;
    index.set(run.runId, isHandBackUnseen(run.handBack) ? "unseen" : "seen");
  }
  indexCache.set(snapshot, index);
  return index;
}

/**
 * The hand-back state for one run (`runId` is the terminal id). A snapshot not
 * yet delivered reads as no hand-back, so glyphs keep their observed state
 * rather than claiming the user has read anything.
 */
export function handBackStateForRun(
  snapshot: FleetSnapshot | null,
  runId: string
): HandBackSeenState {
  if (snapshot === null) return "none";
  return indexSnapshot(snapshot).get(runId) ?? "none";
}

/**
 * The glyph state for a session. A seen hand-back draws as settled, an unseen
 * one as unread, and everything else — approval, question and error waits
 * included — keeps the display state it already had.
 *
 * Eligibility is checked against the renderer's raw observation as well as the
 * fleet's, so an actionable reason from either side keeps the amber circle.
 */
export function resolveSessionPresentation(
  displayState: AgentState | undefined,
  rawState: AgentState | undefined,
  waitingReason: WaitingReason | undefined,
  handBack: HandBackSeenState
): SessionPresentationState | undefined {
  if (displayState === undefined || handBack === "none" || rawState === undefined) {
    return displayState;
  }
  if (!isHandBackStop(rawState, waitingReason)) return displayState;
  return handBack === "seen" ? "completed" : "unread";
}
