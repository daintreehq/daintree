/**
 * Source: https://vercel.com/geist/brands
 * Brand color: #000000
 */

import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

type VercelIconProps = SVGProps<SVGSVGElement> & {
  size?: number;
};

export function VercelIcon({ className, size = 16, ...props }: VercelIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn(className)}
      aria-hidden="true"
      {...props}
    >
      <path fill="currentColor" d="m12 1.608 12 20.784H0Z" />
    </svg>
  );
}

export default VercelIcon;
