import { ChevronDown, ChevronUp } from "lucide-react";
import { FileViewerToolbar, TOOLBAR_ICON_CLASS } from "./FileViewerToolbar";

/**
 * The change inventory for the diff panel's rendered layout: how many changes
 * this document holds, which one you are on, and a way to the next.
 *
 * A rendered diff has no line numbers and no hunk headers, which is the point —
 * but it also means a long document with four edits gives the reader nothing to
 * tell them there are four, or where the other three are. They scroll and hope.
 * A counter plus a stepper is the established answer (Kaleidoscope's change
 * stepper, Word's Next/Previous change, every side-by-side comparison tool), and
 * it is the whole of the orientation this surface needs — there are no lines
 * here to number and no hunks to fold.
 *
 * Its own component rather than JSX inside `DiffPane` so the screenshot harness
 * renders the real thing. A stepper copied into a preview drifts from the one
 * that ships, and then the review is of a control nobody uses.
 */
export interface DiffChangeStepperProps {
  /** Total changes in the document. The stepper renders nothing at zero. */
  count: number;
  /** Zero-based index of the change the reader is on. */
  index: number;
  /** Move by `delta` changes, wrapping at both ends. */
  onStep: (delta: number) => void;
}

export function DiffChangeStepper({ count, index, onStep }: DiffChangeStepperProps) {
  if (count === 0) return null;
  // One change needs no stepper. Two arrows that both land on the block you are
  // already looking at are a control that does nothing, which is worse than an
  // absent one — but the count still answers "is there more below?", so it
  // stays.
  if (count === 1) {
    return (
      <span className="px-1 text-xs text-text-secondary select-none" aria-live="polite">
        1 change
      </span>
    );
  }
  return (
    <div role="group" aria-label="Changes" className="flex items-center gap-0.5">
      {/*
        `aria-live="polite"` rather than moving focus: stepping is a scroll, and
        a screen-reader user who has just pressed Next needs to hear where they
        landed without losing the button they are about to press again.

        Tabular figures because the count sits between two buttons whose
        positions must not shuffle as the index crosses from 9 to 10.
      */}
      <span
        className="px-1 text-xs tabular-nums text-text-secondary select-none"
        aria-live="polite"
      >
        {`${index + 1} of ${count}`}
      </span>
      <FileViewerToolbar.IconButton label="Previous change" onClick={() => onStep(-1)}>
        <ChevronUp className={TOOLBAR_ICON_CLASS} />
      </FileViewerToolbar.IconButton>
      <FileViewerToolbar.IconButton label="Next change" onClick={() => onStep(1)}>
        <ChevronDown className={TOOLBAR_ICON_CLASS} />
      </FileViewerToolbar.IconButton>
    </div>
  );
}
