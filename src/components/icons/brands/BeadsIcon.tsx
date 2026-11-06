/**
 * Beads publishes no brand mark beyond a "bd" wordmark favicon, so this is a
 * plain glyph: beads on a thread.
 */

import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

type BeadsIconProps = SVGProps<SVGSVGElement> & {
  size?: number;
};

export function BeadsIcon({ className, size = 16, ...props }: BeadsIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn(className)}
      aria-hidden="true"
      {...props}
    >
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        d="M2 15.5c3-5 6-7.5 10-7.5s7 2.5 10 7.5"
      />
      <circle fill="currentColor" cx="5" cy="11.4" r="2.6" />
      <circle fill="currentColor" cx="12" cy="8" r="3" />
      <circle fill="currentColor" cx="19" cy="11.4" r="2.6" />
    </svg>
  );
}

export default BeadsIcon;
