import type { ComponentType } from "react";
import {
  SpinnerCircle,
  HollowCircle,
  InteractingCircle,
  ExitedCircle,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleSlash,
} from "@/components/icons";
import type { FleetBand } from "@/lib/fleetAttention";
import type { AgentState } from "@shared/types/agent";

interface PilotRunStateProps {
  band: FleetBand;
  agentState: AgentState | undefined;
}

/**
 * The neutral tone the quiet states carry.
 *
 * `done` and `idle` are finished business: nothing is in flight and nothing is
 * being asked, so they read as ordinary text. Deliberately `text-text-secondary`
 * rather than `text-muted`: muted sits below the contrast floor against the
 * palette's raised surface in the dark themes, and a state glyph nobody can see
 * is worse than a loud one.
 */
const NEUTRAL_TONE = "text-text-secondary";

/**
 * One glyph per band, shared by every surface that speaks about bands.
 *
 * The filter bar's segments draw from here too, so "the amber hollow circle"
 * means the same thing in the list as in the control that filters on it. A
 * second set for either would teach the reader two vocabularies for one fact.
 *
 * These are the BAND's representative shapes. `PilotRunState` refines two of
 * them where the row knows more than the band does — directing inside
 * `running`, and exited inside `idle`.
 *
 * `blocked` gets the prohibition sign rather than the hollow circle it used to
 * share with `needs-you`. The row's visible status word was the only non-colour
 * channel separating "the agent errored" from "the agent asked you a question";
 * with that word gone, the shapes have to carry it. Same circle family as every
 * other glyph here, so it still reads as one of the set.
 */
export const BAND_GLYPH: Record<FleetBand, ComponentType<{ className?: string }>> = {
  blocked: CircleSlash,
  "needs-you": HollowCircle,
  review: CircleCheck,
  running: SpinnerCircle,
  done: CircleCheck,
  parked: CirclePause,
  // Dashed rather than paused: a park is held, a snooze is merely quiet for
  // now, and the two must not share a shape when the row's only other
  // difference between them is a word. The dash is the same signal the project
  // switcher's snoozed dot uses, so one vocabulary covers both surfaces.
  snoozed: CircleDashed,
  idle: HollowCircle,
};

/**
 * Colour per band, and the one place this surface's hue rule lives.
 *
 * A band is hued when it is a live fact about the fleet — something needs you,
 * or something is happening. Green for `running` is the app's own vocabulary:
 * the sidebar's quick filters, the assistant header, the dock and the panel
 * chrome all already say working in green, and the overview reading it grey was
 * the one surface speaking a second language.
 *
 * `review` is blue rather than the completed token because that token is unset
 * in every built-in theme and falls back to `status-success` — the same hex as
 * `activity-working` in five of them. Green working beside green ready-for-
 * review would leave spinner-vs-check as the only difference between two states
 * an operator has to tell apart at a glance. Blue is also what the sidebar's
 * `QuickStateFilterBar` already gives Finished.
 *
 * `done` and `idle` stay neutral: an acknowledged completion and an exited
 * shell are not news.
 *
 * Exported for the group header's demand chip, which has to speak the same
 * hue as the rows it summarises. The filter bar still spells its own segment
 * tones out in full because Tailwind's scanner cannot see an assembled
 * `${tone}/40`.
 */
export const BAND_GLYPH_TONE: Record<FleetBand, string> = {
  blocked: "text-status-danger",
  "needs-you": "text-state-waiting",
  review: "text-category-blue",
  running: "text-state-working",
  done: NEUTRAL_TONE,
  // Parked is the user's own quiet, so it takes the quiet tone: hued parked
  // rows would re-demand the attention parking just released.
  parked: NEUTRAL_TONE,
  // Snoozed is quiet for the same reason parked is: hueing a run the user just
  // silenced would re-demand the attention the snooze exists to withdraw.
  snoozed: NEUTRAL_TONE,
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
 * The three demand bands and `running` are hued; the quiet ones are not.
 * Shape still carries the state as a second channel for every band — spinner,
 * hollow circle, prohibition, check, pause and exited stay distinct — and the
 * row keeps the state in text in its accessible name either way. Never colour
 * alone, and never colour where there is nothing happening.
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
