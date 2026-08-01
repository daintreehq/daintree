import {
  SpinnerCircle,
  HollowCircle,
  InteractingCircle,
  ExitedCircle,
  CircleCheck,
} from "@/components/icons";
import type { FleetBand } from "@/lib/fleetAttention";
import type { AgentState } from "@shared/types/agent";

interface PilotRunStateProps {
  band: FleetBand;
  agentState: AgentState | undefined;
}

/**
 * A run's state, in the app's existing agent vocabulary.
 *
 * Deliberately the same glyphs and tokens the assistant header and the dock
 * already use — the green spinner and the amber hollow circle ARE the identity
 * of "working" and "waiting" in this product. Inventing a second set for one
 * surface would teach the user two languages for one fact.
 *
 * Keyed on the BAND, not the raw state, so the glyph cannot contradict the label
 * and tone beside it: an acknowledged completion has to stop looking like a
 * hand-back at the same moment it stops being counted as one.
 *
 * Redundant by design. Every state here is also written out in words on the row,
 * because the two states a supervisor most needs to tell apart — waiting and
 * idle — are both hollow circles, and hue is the only thing separating them.
 */
export function PilotRunState({ band, agentState }: PilotRunStateProps) {
  const size = "size-3.5 shrink-0";

  switch (band) {
    case "blocked":
      return <HollowCircle className={`${size} text-status-danger`} />;
    case "needs-you":
      return <HollowCircle className={`${size} text-state-waiting`} />;
    case "review":
      return <CircleCheck className={`${size} text-activity-completed`} />;
    case "running":
      return agentState === "directing" ? (
        <InteractingCircle className={`${size} text-category-blue`} />
      ) : (
        <SpinnerCircle
          className={`${size} text-state-working animate-spin-slow motion-reduce:animate-none`}
        />
      );
    case "done":
      return <CircleCheck className={`${size} text-daintree-text/40`} />;
    default:
      return agentState === "exited" ? (
        <ExitedCircle className={`${size} text-daintree-text/40`} />
      ) : (
        <HollowCircle className={`${size} text-daintree-text/30`} />
      );
  }
}
