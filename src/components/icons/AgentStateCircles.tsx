import type { SVGProps } from "react";

type CircleProps = SVGProps<SVGSVGElement> & { className?: string };

export function SpinnerCircle({ className, ...props }: CircleProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} {...props}>
      <path d="M8 3a5 5 0 0 1 5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
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

export function SolidCircle({ className, ...props }: CircleProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} {...props}>
      <circle cx="8" cy="8" r="6" fill="currentColor" />
    </svg>
  );
}
