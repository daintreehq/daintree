import type { HTMLAttributes, SVGProps } from "react";
import { cn } from "@/lib/utils";

type CircleProps = SVGProps<SVGSVGElement> & { className?: string };

// r=6, strokeWidth=1.333 → ~13.33px diameter in 16x16 viewBox. The 1.333 stroke
// (= 2 × 16/24) normalizes these icons to Lucide's 24-viewBox / strokeWidth-2 grid
// so they render the same line weight as adjacent Lucide icons.

// Drawn in CSS (`.spinner-circle` in index.css), not as an <svg>: Chromium will
// not run a transform animation on the compositor when its target is an svg
// (trace: compositeFailed 1024, "transform-related property cannot be
// accelerated on target"), so `animate-spin-slow` on the old svg re-ran style on
// the main thread at display rate for a glyph that moves 17 times a second.
// The geometry mirrors the 16-unit grid above: r=6, 1.333 stroke, round caps.
export function SpinnerCircle({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      data-glyph-box="spinner"
      aria-hidden="true"
      className={cn("spinner-circle", className)}
      {...props}
    />
  );
}

// `data-agent-state-glyph` is the forced-colors hook (index.css): these are
// stroked in `currentColor`, and without a system colour the state hue survives
// onto the forced white canvas — an amber ring there is 1.7:1.
export function HollowCircle({ className, ...props }: CircleProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      aria-hidden="true"
      data-agent-state-glyph=""
      {...props}
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.333" />
    </svg>
  );
}

export function InteractingCircle({ className, ...props }: CircleProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      aria-hidden="true"
      data-agent-state-glyph=""
      {...props}
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.333" />
      <line
        x1="8"
        y1="5.5"
        x2="8"
        y2="10.5"
        stroke="currentColor"
        strokeWidth="1.0"
        strokeLinecap="round"
      />
      <line
        x1="5.5"
        y1="8"
        x2="10.5"
        y2="8"
        stroke="currentColor"
        strokeWidth="1.0"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ExitedCircle({ className, ...props }: CircleProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      aria-hidden="true"
      data-agent-state-glyph=""
      {...props}
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.333" />
      <line
        x1="5"
        y1="8"
        x2="11"
        y2="8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

// The waiting ring with a question mark in it: an agent that is waiting and is
// asking the user something. A refinement of the hollow circle, never a new
// hue, so it still reads as waiting first.
export function AskingCircle({ className, ...props }: CircleProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      aria-hidden="true"
      data-agent-state-glyph=""
      {...props}
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.333" />
      <path
        d="M6.4 6.5a1.65 1.65 0 0 1 3.2.55c0 1.1-1.6 1.45-1.6 1.45"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="10.75" r="0.75" fill="currentColor" />
    </svg>
  );
}

// The solid pair: a settled session is a disc in its state colour with one mark
// cut out of it, never a ring — a ring is the waiting family. The mark is cut
// with `evenodd` rather than drawn over the disc in a second colour, so it
// survives forced colours, where every fill collapses to the same system colour.
const SOLID_DISC = "M1.333 8a6.667 6.667 0 1 0 13.334 0a6.667 6.667 0 1 0 -13.334 0Z";

// Finished: the disc with a check cut out of it.
export function DoneCircle({ className, ...props }: CircleProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      aria-hidden="true"
      data-agent-state-glyph=""
      {...props}
    >
      <path
        d={`${SOLID_DISC}M5.517 7.657L7.1 9.14L10.457 5.583L11.543 6.617L7.1 11.26L4.483 8.743Z`}
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  );
}

// Unread: an agent that handed its turn back and the user has not read it yet —
// the disc with a dot cut out of it. Neutral, never the waiting hue: it is not
// asking for anything, and amber is kept for the agents that are.
export function UnreadCircle({ className, ...props }: CircleProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      aria-hidden="true"
      data-agent-state-glyph=""
      {...props}
    >
      <path
        d={`${SOLID_DISC}M6 8a2 2 0 1 0 4 0a2 2 0 1 0 -4 0Z`}
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  );
}
