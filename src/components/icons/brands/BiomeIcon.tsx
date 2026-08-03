/**
 * Source: https://github.com/biomejs/resources/blob/551f36498dfe34b24bc7755fcdd0fa501b757cf4/svg/icon-light-mono.svg
 * Brand color: #60A5FA
 */

import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

type BiomeIconProps = SVGProps<SVGSVGElement> & {
  size?: number;
};

export function BiomeIcon({ className, size = 16, ...props }: BiomeIconProps) {
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
        d="m12 1.608-5.346 9.259a12.069 12.069 0 0 1 6.326-.219l1.807.426-1.7 7.208-1.809-.427c-2.224-.524-4.361.644-5.264 2.507l-1.672-.809c1.276-2.636 4.284-4.232 7.364-3.505l.847-3.592A10.211 10.211 0 0 0 0 22.392h24L12 1.608Z"
      />
    </svg>
  );
}

export default BiomeIcon;
