import {
  SpinnerCircle,
  HollowCircle,
  InteractingCircle,
  ExitedCircle,
  CircleCheck,
} from "@/components/icons";
import type { AgentState, WaitingReason } from "@shared/types/agent";

interface PilotRunStateProps {
  agentState: AgentState | undefined;
  waitingReason: WaitingReason | undefined;
}

/**
 * A run's state, in the app's existing agent vocabulary.
 *
 * Deliberately the same glyphs and tokens the assistant header and the dock
 * already use — the green spinner and the amber hollow circle ARE the identity
 * of "working" and "waiting" in this product. Inventing a second set for one
 * surface would teach the user two languages for one fact.
 *
 * The only addition is `blocked`, which the other surfaces have no concept of:
 * it reuses the waiting circle in the danger tone, because a block IS a wait —
 * one where input may not be what unblocks it.
 */
export function PilotRunState({ agentState, waitingReason }: PilotRunStateProps) {
  const size = "size-3.5 shrink-0";

  if (agentState === "working") {
    return (
      <SpinnerCircle
        className={`${size} text-state-working animate-spin-slow motion-reduce:animate-none`}
      />
    );
  }
  if (agentState === "directing") {
    return <InteractingCircle className={`${size} text-category-blue`} />;
  }
  if (agentState === "waiting") {
    return (
      <HollowCircle
        className={`${size} ${waitingReason === "error" ? "text-status-danger" : "text-state-waiting"}`}
      />
    );
  }
  if (agentState === "completed") {
    return <CircleCheck className={`${size} text-activity-completed`} />;
  }
  if (agentState === "exited") {
    return <ExitedCircle className={`${size} text-daintree-text/40`} />;
  }
  return <HollowCircle className={`${size} text-daintree-text/30`} />;
}

/** Screen-reader label, so state is never carried by the glyph alone. */
export function runStateLabel(
  agentState: AgentState | undefined,
  waitingReason: WaitingReason | undefined
): string {
  if (agentState === "working") return "Working";
  if (agentState === "directing") return "Directing";
  if (agentState === "waiting") return waitingReason === "error" ? "Blocked" : "Needs you";
  if (agentState === "completed") return "Ready for review";
  if (agentState === "exited") return "Exited";
  return "Idle";
}
