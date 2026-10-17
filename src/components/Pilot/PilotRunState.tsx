import type { ComponentType } from "react";
import {
  SpinnerCircle,
  HollowCircle,
  InteractingCircle,
  ExitedCircle,
  DoneCircle,
  UnreadCircle,
  BlockedCircle,
  ParkedCircle,
  SnoozedCircle,
  IdleCircle,
} from "@/components/icons";
import { SESSION_COLORS } from "@/components/Worktree/terminalStateConfig";
import type { FleetBand } from "@/lib/fleetAttention";
import type { AgentState } from "@shared/types/agent";

interface PilotRunStateProps {
  band: FleetBand;
  agentState: AgentState | undefined;
}

/**
 * The neutral tone the settled states carry.
 *
 * "Settled", not "quiet" — `quiet` is a band now, and it is hued.
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
 *
 * Three of these marks are the app's own standards and are not this surface's
 * to reinterpret: the green spinner is working, the amber hollow circle is
 * waiting, the ring with a check is finished, and the solid disc with a dot
 * cut out of it is an unread hand-back. The sidebar, the dock, the assistant
 * header and the panel chrome all say the same things the same ways.
 *
 * So the invariant here is NOT that every band draws a different shape — it is
 * that no two bands share a shape AND a tone, and that among the bands wearing
 * the SAME tone, every shape differs. Hue does the work where the vocabulary
 * already assigns it; geometry does the work everywhere hue cannot.
 *
 * - `quiet` is the working spinner in the waiting hue, and no new glyph at all.
 *   A silent run IS working — that is the whole difficulty with it — so it
 *   keeps working's mark and takes the colour of the thing that may need a
 *   hand. It does not animate, which is the other half of what it means. The
 *   row spells "quiet 12m" beside it in words, so the pair is never separated
 *   by colour alone.
 * - `done` is the ring with a check in the settled tone, and `review` (an
 *   unread hand-back) the solid dot in the primary tone: the same shapes the
 *   pane header and the sidebar draw.
 * - `idle` takes the dotted circle — alive, at rest, nothing running. It used
 *   to share the hollow circle with `needs-you`, which is the one collision
 *   worth removing: it left the amber hollow circle meaning waiting while a
 *   grey one meant something else entirely. Now the hollow circle means
 *   waiting and only waiting. The exited refinement below keeps the
 *   struck-through circle, so a dead shell and a resting one stay tellable
 *   apart too.
 */
export const BAND_GLYPH: Record<FleetBand, ComponentType<{ className?: string }>> = {
  blocked: BlockedCircle,
  "needs-you": HollowCircle,
  quiet: SpinnerCircle,
  review: UnreadCircle,
  running: SpinnerCircle,
  done: DoneCircle,
  parked: ParkedCircle,
  // Dashed rather than paused: a park is held, a snooze is merely silent for
  // now, and the two must not share a shape when the row's only other
  // difference between them is a word. The dash is the same signal the project
  // switcher's snoozed dot uses, so one vocabulary covers both surfaces.
  snoozed: SnoozedCircle,
  idle: IdleCircle,
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
 * `review` is an unread hand-back, and wears the same primary tone it does
 * on the pane chip and the sidebar: brighter than the settled states because
 * it is news, but no hue, because nothing is being asked (#12002). Its solid
 * dot keeps it apart from the green spinner by shape as well as colour.
 *
 * `done` and `idle` stay neutral: an acknowledged completion and an exited
 * shell are not news.
 *
 * Exported for the group header's demand chip, which has to speak the same
 * hue as the rows it summarises.
 */
export const BAND_GLYPH_TONE: Record<FleetBand, string> = {
  blocked: "text-status-danger",
  "needs-you": "text-state-waiting",
  // Amber, and the same amber a demand wears. A stall is not a demand — nobody
  // is asking — but it is the other thing on this surface that may need a hand,
  // and inventing a third hue for it would spend a colour on a distinction the
  // shape already carries.
  quiet: "text-state-waiting",
  review: "text-text-primary",
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
    // Directing wears its own blue here as on every other surface: it is the
    // user's own draft, and the working green would claim the agent is busy.
    return agentState === "directing" ? (
      <InteractingCircle className={`size-3.5 shrink-0 ${SESSION_COLORS.directing}`} />
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
