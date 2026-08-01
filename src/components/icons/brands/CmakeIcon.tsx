/**
 * Source: https://www.kitware.com/platforms/
 * Brand color: #064F8C
 */

import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

type CmakeIconProps = SVGProps<SVGSVGElement> & {
  size?: number;
};

export function CmakeIcon({ className, size = 16, ...props }: CmakeIconProps) {
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
        fill="currentColor"
        d="M11.769.066L.067 23.206l12.76-10.843zM23.207 23.934L7.471 17.587 0 23.934zM24 23.736L12.298.463l1.719 19.24zM12.893 12.959l-5.025 4.298 5.62 2.248z"
      />
    </svg>
  );
}

export default CmakeIcon;
