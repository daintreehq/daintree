import type { AgentState } from "@shared/types/agent";
import type { TerminalSubmissionPhase } from "@shared/types/terminalSubmission";

export type DeliveryState =
  | { status: "sending" }
  /** A fresh session is starting; the request goes in once it is at its prompt. */
  | { status: "starting" }
  /** The session is asking its user something (trust, approval) before it can take the request. */
  | { status: "needs-you" }
  /**
   * Waiting its turn: behind an earlier request from the same owner, or for an
   * agent that isn't at its prompt yet. It goes in by itself when both clear.
   */
  | { status: "queued" }
  | { status: "sent" }
  | { status: "unconfirmed" }
  /** `partial` when typing had started: some of the prompt may be in the agent's input. */
  | { status: "failed"; message: string; partial?: true };

/**
 * Whether a freshly launched agent can take a typed request now. Only an agent
 * observed waiting at its own prompt qualifies: a trust or approval question is
 * also "waiting", and a request typed into it would answer the question.
 */
export function launchReadiness(
  agentState: AgentState | null | undefined,
  waitingReason: string | undefined
): "ready" | "needs-you" | "not-yet" {
  if (agentState === "waiting") {
    return waitingReason === "question" || waitingReason === "approval" || waitingReason === "error"
      ? "needs-you"
      : "ready";
  }
  if (agentState === "idle") return "ready";
  return "not-yet";
}

/**
 * Only `pty_written` is evidence the prompt reached the agent's terminal. Every
 * other outcome is reported as what it is rather than rounded up to "sent".
 */
export function deliveryFromPhase(phase: TerminalSubmissionPhase | null): DeliveryState | null {
  switch (phase) {
    case "pty_written":
      return { status: "sent" };
    // Part of the prompt may already sit in the agent's input, so neither of
    // these says resending is safe.
    case "failed":
      return {
        status: "failed",
        message: "The terminal didn't accept the whole prompt",
        partial: true,
      };
    case "cancelled":
      return {
        status: "failed",
        message: "Sending was stopped before the prompt finished",
        partial: true,
      };
    case "queued":
    case "writing":
    case null:
      return null;
    case "unknown":
      return { status: "unconfirmed" };
  }
}
