import type { AgentState, WaitingReason } from "@shared/types/agent";

/**
 * What a live Daintree Assistant means for the row it sits on.
 *
 * - `blocked` — settled after a failure; input may not restart it.
 * - `waiting-unseen` — waiting, and the user has not had this workspace on
 *   screen since the wait began. Nobody is coming.
 * - `working` — actively doing something.
 * - `waiting` — at its prompt, already seen. Its normal resting state.
 *
 * Null means the assistant has nothing to say: no live session, or a settled
 * one (`idle`, `completed`, `exited`).
 */
export type AssistantActivity = "blocked" | "waiting-unseen" | "working" | "waiting";

/**
 * The fields this classification reads, declared structurally rather than
 * imported from the switcher's row model.
 *
 * Both row kinds satisfy it, and keeping the dependency pointing this way
 * means the hook can call this helper without the type import looping back
 * through it.
 */
export interface AssistantActivityFields {
  assistantState?: AgentState;
  assistantWaitingReason?: WaitingReason;
  assistantStateSince?: number;
  /**
   * When the user last had this workspace as their current one. Stamped on the
   * way in AND on the way out — `ProjectStore` sets the departing project's
   * `lastOpened` to just before the switch — so it reads as "last had this on
   * screen" rather than merely "last opened it".
   */
  lastOpened: number;
  /** Whether this workspace is the one the view is showing right now. */
  isActive: boolean;
}

/**
 * The one definition of what the assistant's state means for a row (#11806).
 *
 * Shared by the switcher's banding, its within-band ordering, and its status
 * line, because those three disagreeing is how a project ends up sorted into
 * "Needs attention" while its own status line says something else.
 *
 * Escalation is deliberately narrow. An assistant parked at its prompt is what
 * an idle assistant looks like, and a band that fills up with them stops
 * meaning anything — so `waiting` only escalates when the user has not been
 * back since the wait started, and `working` never escalates at all.
 *
 * Known limits of `lastOpened` as the observation watermark, both erring
 * toward escalating a wait the user may already have seen: switching from a
 * project into a scratch clears the current-project pointer without stamping
 * the project it left, and the stamp is skipped entirely while disk writes are
 * suppressed. Both are rarer than the case this catches, and an over-eager
 * status line is a smaller failure than an assistant stuck where nobody looks.
 */
export function classifyAssistantActivity(
  workspace: AssistantActivityFields
): AssistantActivity | null {
  const state = workspace.assistantState;

  if (state === "working" || state === "directing") return "working";
  if (state !== "waiting") return null;

  // An error outranks the observation check: it is not waiting on the user in
  // the ordinary sense, and having glanced at the project does not unstick it.
  if (workspace.assistantWaitingReason === "error") return "blocked";

  // The user is looking at it right now — there is nothing to escalate to.
  if (workspace.isActive) return "waiting";

  const since = workspace.assistantStateSince;
  // No recorded transition means the wait cannot be dated, and an undatable
  // wait must not escalate: it would have no way back down.
  if (since === undefined) return "waiting";

  // Strictly after: a wait that began at the moment the user was last here
  // was on screen for them to see.
  return since > workspace.lastOpened ? "waiting-unseen" : "waiting";
}

/** Whether this activity belongs in the switcher's attention band. */
export function assistantNeedsAttention(activity: AssistantActivity | null): boolean {
  return activity === "blocked" || activity === "waiting-unseen";
}
