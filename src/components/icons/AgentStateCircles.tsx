import type { SVGProps } from "react";

type CircleProps = SVGProps<SVGSVGElement> & { className?: string };

const HALF = "15.708";
const DASH = `${HALF} ${HALF}`;

export function SpinnerCircle({ className, ...props }: CircleProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} {...props}>
      <circle
        cx="8"
        cy="8"
        r="5"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray={DASH}
        strokeDashoffset="7.854"
      />
    </svg>
  );
}

export function HollowCircle({ className, ...props }: CircleProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} {...props}>
      <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export function InteractingCircle({ className, ...props }: CircleProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} {...props}>
      <circle
        cx="8"
        cy="8"
        r="5"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray={DASH}
        strokeDashoffset="-7.854"
      />
    </svg>
  );
}
