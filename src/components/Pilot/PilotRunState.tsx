import type { ComponentType } from "react";
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
 * The neutral tone every non-demand state now carries.
 *
 * Colour is spent only where there is a demand, so `running`, `done` and `idle`
 * give theirs up and read as ordinary text. Deliberately `text-text-secondary`
 * rather than `text-muted`: muted sits below the contrast floor against the
 * palette's raised surface in the dark themes, and a state glyph nobody can see
 * is worse than a loud one.
 */
const NEUTRAL_TONE = "text-text-secondary";

/**
 * One glyph per band, shared by every surface that speaks about bands.
 *
 * The filter bar's segments and a collapsed group's pip cluster both draw from
 * here, so "the amber hollow circle" means the same thing in the list, in the
 * header and in the control that filters on it. A second set for any one of
 * them would teach the reader two vocabularies for one fact.
 *
 * These are the BAND's representative shapes. `PilotRunState` refines two of
 * them where the row knows more than the band does — directing inside
 * `running`, and exited inside `idle`.
 */
export const BAND_GLYPH: Record<FleetBand, ComponentType<{ className?: string }>> = {
  blocked: HollowCircle,
  "needs-you": HollowCircle,
  review: CircleCheck,
  running: SpinnerCircle,
  done: CircleCheck,
  idle: HollowCircle,
};

/**
 * Colour per band, and the one place the "only a demand is hued" rule lives.
 *
 * Exported alongside the glyphs so a collapsed group's pips and a run's own
 * state mark cannot end up differently coloured for the same band — the two
 * read as one signal only if they agree by construction rather than by two
 * lists someone has to keep in step.
 */
export const BAND_GLYPH_TONE: Record<FleetBand, string> = {
  blocked: "text-status-danger",
  "needs-you": "text-state-waiting",
  review: "text-activity-completed",
  running: NEUTRAL_TONE,
  done: NEUTRAL_TONE,
  idle: NEUTRAL_TONE,
};

/**
 * A run's state, in the app's existing agent vocabulary.
 *
 * Deliberately the same glyphs the assistant header and the dock already use —
 * the spinner and the hollow circle ARE the identity of "working" and "waiting"
 * in this product. Inventing a second set for one surface would teach the user
 * two languages for one fact.
 *
 * Keyed on the BAND, not the raw state, so the glyph cannot contradict the
 * ordering beside it: an acknowledged completion has to stop looking like a
 * hand-back at the same moment it stops being counted as one.
 *
 * Only the three demand bands are hued. Shape still carries the state as a
 * second channel for all six — spinner, hollow circle, check and exited stay
 * distinct — and the row keeps the state in text either way, visibly for a
 * demand and in its accessible name otherwise. Never colour alone, and now
 * never colour where there is nothing to act on.
 */
export function PilotRunState({ band, agentState }: PilotRunStateProps) {
  const className = `size-3.5 shrink-0 ${BAND_GLYPH_TONE[band]}`;

  // The two refinements the row can make that the band alone cannot. Everything
  // else takes the band's own shape, so there is no second list to drift.
  if (band === "running") {
    return agentState === "directing" ? (
      <InteractingCircle className={className} />
    ) : (
      <SpinnerCircle className={`${className} animate-spin-slow motion-reduce:animate-none`} />
    );
  }
  if (band === "idle" && agentState === "exited") {
    return <ExitedCircle className={className} />;
  }

  const Glyph = BAND_GLYPH[band];
  return <Glyph className={className} />;
}
