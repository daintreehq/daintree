import type { HTMLAttributes, SVGProps } from "react";
import { cn } from "@/lib/utils";

type CircleProps = SVGProps<SVGSVGElement> & { className?: string };

// r=6, strokeWidth=1.333 → ~13.33px diameter in 16x16 viewBox. The 1.333 stroke
// (= 2 × 16/24) normalizes these icons to Lucide's 24-viewBox / strokeWidth-2 grid
// so they render the same line weight as adjacent Lucide icons (e.g. CheckCircle2).

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
