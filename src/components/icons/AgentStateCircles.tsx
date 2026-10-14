import type { HTMLAttributes, SVGProps } from "react";
import { cn } from "@/lib/utils";

type CircleProps = SVGProps<SVGSVGElement> & { className?: string };

// r=6, strokeWidth=1.333 → ~13.33px diameter in 16x16 viewBox. The 1.333 stroke
// (= 2 × 16/24) normalizes these icons to Lucide's 24-viewBox / strokeWidth-2 grid
// so they render the same line weight as adjacent Lucide icons. Every mark inside
// a ring takes the ring's own 1.333 stroke, and the straight ones (plus, dash)
// share one span, x 5-11: a lighter or shorter mark goes to a blur at 12px on a
// 1x screen while the ring around it stays crisp.

// The ring the static glyphs share, with a faint wash of its own colour inside so
// the circle has a little body against the surface rather than a bare outline.
// A tint of the glyph's hue, not a neutral lift, so it moves with each theme's
// own state colour; at 10% it stays well clear of the solid unread disc and of
// the inner marks drawn over it. The spinner and the dashed snoozed ring stay
// unfilled: a static fill behind a moving arc smears, and a wash would close
// the snooze's gaps. `data-glyph-wash` drops it under forced colours (index.css),
// where its opacity would otherwise survive as a grey disc of system ink.
function WashedRing() {
  return (
    <circle
      cx="8"
      cy="8"
      r="6"
      stroke="currentColor"
      strokeWidth="1.333"
      fill="currentColor"
      fillOpacity={0.1}
      data-glyph-wash=""
    />
  );
}

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
      <WashedRing />
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
      <WashedRing />
      <line
        x1="8"
        y1="5"
        x2="8"
        y2="11"
        stroke="currentColor"
        strokeWidth="1.333"
        strokeLinecap="round"
      />
      <line
        x1="5"
        y1="8"
        x2="11"
        y2="8"
        stroke="currentColor"
        strokeWidth="1.333"
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
      <WashedRing />
      <line
        x1="5"
        y1="8"
        x2="11"
        y2="8"
        stroke="currentColor"
        strokeWidth="1.333"
        strokeLinecap="round"
      />
    </svg>
  );
}

// The waiting ring with a question mark in it: an agent that is waiting and is
// asking the user something. A refinement of the hollow circle, never a new
// hue, so it still reads as waiting first. The mark is typographic rather than
// a cartoon curl: a tight bowl, a short straight stem, and a dot exactly the
// stroke's width, drawn as a round cap on a zero-length segment.
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
      <WashedRing />
      <path
        d="M6.4 6.45A1.6 1.6 0 1 1 9.23 7.48C8.75 7.92 8 8.2 8 8.8M8 11.15h.01"
        stroke="currentColor"
        strokeWidth="1.333"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Finished: the ring with a check in it, the same circle as the rest of the
// family so a settled agent still reads as one of the state glyphs.
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
      <WashedRing />
      <path
        d="M5.5 8L7.17 9.67L10.5 6.33"
        stroke="currentColor"
        strokeWidth="1.333"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Pilot's quieter bands, drawn on the shared ring rather than taken from Lucide,
// whose circles sit at r 10 + a 2 stroke on 24 units: their outer edge lands at
// 91.7% of the box against the family's 83.3%, so beside a done or waiting ring
// they read a size larger.

// Blocked: an agent stopped on an error, distinct in shape from a waiting one.
export function BlockedCircle({ className, ...props }: CircleProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      aria-hidden="true"
      data-agent-state-glyph=""
      {...props}
    >
      <WashedRing />
      <line
        x1="6.23"
        y1="9.77"
        x2="9.77"
        y2="6.23"
        stroke="currentColor"
        strokeWidth="1.333"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Parked: a run the user shelved on purpose. The bars sit four units apart, so a
// 12px glyph puts each on its own pixel column with two clear between them.
export function ParkedCircle({ className, ...props }: CircleProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      aria-hidden="true"
      data-agent-state-glyph=""
      {...props}
    >
      <WashedRing />
      <path
        d="M6 5.75v4.5M10 5.75v4.5"
        stroke="currentColor"
        strokeWidth="1.333"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Snoozed: quiet until it wakes. Eight dashes, one centred on each compass and
// diagonal point, from a ring whose length (2π6 ≈ 37.7) divides into them evenly.
export function SnoozedCircle({ className, ...props }: CircleProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      aria-hidden="true"
      data-agent-state-glyph=""
      {...props}
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeWidth="1.333"
        strokeLinecap="round"
        strokeDasharray="2.1 2.612"
        strokeDashoffset="1.05"
      />
    </svg>
  );
}

// Idle: alive and doing nothing. The dot keeps it apart from the waiting ring,
// which is the same circle in amber.
export function IdleCircle({ className, ...props }: CircleProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      aria-hidden="true"
      data-agent-state-glyph=""
      {...props}
    >
      <WashedRing />
      <circle cx="8" cy="8" r="1.25" fill="currentColor" />
    </svg>
  );
}

// The unread disc's edge sits where the spinner's and every ring's outer edge
// does (r 6 + half the 1.333 stroke), so at the same box size all three read
// as the same diameter.
const SOLID_DISC = "M1.333 8a6.667 6.667 0 1 0 13.334 0a6.667 6.667 0 1 0 -13.334 0Z";

// Unread: an agent that handed its turn back and the user has not read it yet —
// a solid disc with a dot cut out of it, the one filled glyph, so it stands out
// from the rings. Never the waiting hue: it is not asking for anything, and
// amber is kept for the agents that are. The dot is cut with `evenodd` rather
// than drawn over the disc in a second colour, so it survives forced colours,
// where every fill collapses to the same system colour.
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
