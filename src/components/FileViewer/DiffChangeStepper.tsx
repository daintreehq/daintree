import { ChevronDown, ChevronUp } from "lucide-react";
import { pluralize } from "@/lib/pluralize";
import { FileViewerToolbar, TOOLBAR_ICON_CLASS } from "./FileViewerToolbar";

/**
 * The change inventory for the diff panel: how many hunks (or, in the rendered
 * Markdown layout, changed blocks) this file holds, which one you are on, and
 * a way to the next.
 *
 * A long file with four edits gives the reader nothing to tell them there are
 * four, or where the other three are. They scroll and hope. A counter plus a
 * stepper is the established answer (Kaleidoscope's change stepper, Word's
 * Next/Previous change, every side-by-side comparison tool).
 *
 * The arrows run on past either end into the neighbouring file of the change
 * set, so their availability is the host's to say: an arrow is live while a
 * step that way lands somewhere, here or in another file. The count isn't a
 * live region — hand scrolling moves it too, and narrating every hunk a wheel
 * passes would make the toolbar chatter — so the host announces each
 * deliberate step itself.
 *
 * Its own component rather than JSX inside `DiffPane` so the screenshot harness
 * renders the real thing. A stepper copied into a preview drifts from the one
 * that ships, and then the review is of a control nobody uses.
 */
export interface DiffChangeStepperProps {
  /** Stops in this file; null while they are still being counted. */
  count: number | null;
  /** Zero-based index of the stop the reader is on. */
  index: number;
  /** What one stop is: a source hunk or a rendered block. */
  unit: "hunk" | "change";
  /**
   * There is somewhere to step at all: more than one stop, or a neighbouring
   * file. The arrows stay mounted while it holds, unavailable in a direction
   * that leads nowhere for now (the stops still being counted, say), so a
   * focused arrow keeps focus through a step into a file that is loading.
   */
  steppable: boolean;
  /** A step back lands somewhere: an earlier stop, or the previous file. */
  canStepBack: boolean;
  /** A step forward lands somewhere: a later stop, or the next file. */
  canStepForward: boolean;
  onStep: (delta: -1 | 1) => void;
  /** The keys the two steps are bound to, for the tooltips; empty when unbound. */
  backShortcut?: string;
  forwardShortcut?: string;
}

function withShortcut(label: string, shortcut: string | undefined): string {
  return shortcut ? `${label} (${shortcut})` : label;
}

export function DiffChangeStepper({
  count,
  index,
  unit,
  steppable,
  canStepBack,
  canStepForward,
  onStep,
  backShortcut,
  forwardShortcut,
}: DiffChangeStepperProps) {
  const known = count ?? 0;
  const position = known > 1 ? `${index + 1} of ${known}` : known === 1 ? pluralize(1, unit) : null;
  // Arrows with nowhere to go are a control that does nothing, which is worse
  // than an absent one — but a lone count still answers "is there more
  // below?", so it stays.
  if (!steppable) {
    return position ? (
      <span className="px-1 text-xs text-text-secondary select-none">{position}</span>
    ) : null;
  }
  const previousLabel = unit === "hunk" ? "Previous hunk" : "Previous change";
  const nextLabel = unit === "hunk" ? "Next hunk" : "Next change";
  return (
    <div
      role="group"
      aria-label={unit === "hunk" ? "Hunks" : "Changes"}
      className="flex items-center gap-0.5"
    >
      {/*
        The arrows must hold still under a pointer that clicks Next again and
        again. Tabular figures keep every digit the same width, but "10 of 20"
        is still a digit longer than "9 of 20", so the slot is sized by the
        widest value it can show and the text sits against its end edge: only
        the new leading digit appears, and " of 20" never moves. The sizer is
        drawn from an attribute, so it adds no text for a screen reader. A file
        with nothing to count (an image, a binary) keeps the arrows alone.
      */}
      {position && (
        <span className="grid px-1 text-xs tabular-nums text-text-secondary select-none">
          <span className="col-start-1 row-start-1 text-end">{position}</span>
          <span
            aria-hidden="true"
            data-label={known > 1 ? `${known} of ${known}` : position}
            className="invisible col-start-1 row-start-1 after:content-[attr(data-label)]"
          />
        </span>
      )}
      <FileViewerToolbar.IconButton
        label={previousLabel}
        tooltip={withShortcut(previousLabel, backShortcut)}
        disabled={!canStepBack}
        onClick={() => onStep(-1)}
      >
        <ChevronUp className={TOOLBAR_ICON_CLASS} />
      </FileViewerToolbar.IconButton>
      <FileViewerToolbar.IconButton
        label={nextLabel}
        tooltip={withShortcut(nextLabel, forwardShortcut)}
        disabled={!canStepForward}
        onClick={() => onStep(1)}
      >
        <ChevronDown className={TOOLBAR_ICON_CLASS} />
      </FileViewerToolbar.IconButton>
    </div>
  );
}
