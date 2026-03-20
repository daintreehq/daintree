import type { SVGProps } from "react";

type CircleProps = SVGProps<SVGSVGElement> & { className?: string };

// r=6, strokeWidth=2 → 14px diameter in 16x16 viewBox (1px padding prevents clipping)
// Circumference = 2π × 6 = 37.699
const DASH = "28.274"; // 270° arc (C × 0.75)
const GAP = "9.425"; // 90° gap (C × 0.25)
const OFFSET = "28.274"; // positions gap at bottom-right (3:00 to 6:00)

export function SpinnerCircle({ className, ...props }: CircleProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} {...props}>
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={`${DASH} ${GAP}`}
        strokeDashoffset={OFFSET}
      />
    </svg>
  );
}

export function HollowCircle({ className, ...props }: CircleProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} {...props}>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export function ApprovalCircle({ className, ...props }: CircleProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} {...props}>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" />
      <line
        x1="8"
        y1="4.5"
        x2="8"
        y2="9"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="8" cy="11.5" r="1" fill="currentColor" />
    </svg>
  );
}

export function InteractingCircle({ className, ...props }: CircleProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} {...props}>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" />
      <line
        x1="8"
        y1="5.5"
        x2="8"
        y2="10.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <line
        x1="5.5"
        y1="8"
        x2="10.5"
        y2="8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
