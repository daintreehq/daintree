import type { SVGProps } from "react";

type CircleProps = SVGProps<SVGSVGElement> & { className?: string };

// r=6, strokeWidth=1.333 → ~13.33px diameter in 16x16 viewBox. The 1.333 stroke
// (= 2 × 16/24) normalizes these icons to Lucide's 24-viewBox / strokeWidth-2 grid
// so they render the same line weight as adjacent Lucide icons (e.g. CheckCircle2).
// Circumference = 2π × 6 = 37.699
const DASH = "28.274"; // 270° arc (C × 0.75)
const GAP = "9.425"; // 90° gap (C × 0.25)
const OFFSET = "28.274"; // positions gap at bottom-right (3:00 to 6:00)

export function SpinnerCircle({ className, ...props }: CircleProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true" {...props}>
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeWidth="1.333"
        strokeLinecap="round"
        strokeDasharray={`${DASH} ${GAP}`}
        strokeDashoffset={OFFSET}
      />
    </svg>
  );
}

export function HollowCircle({ className, ...props }: CircleProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true" {...props}>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.333" />
    </svg>
  );
}

export function InteractingCircle({ className, ...props }: CircleProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true" {...props}>
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
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true" {...props}>
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
