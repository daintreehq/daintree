/**
 * Source: https://github.com/voidzero-dev/community-design-resources/blob/55902097229cf01cf2a4ceb376f992f5cf306756/brand-assets/vitest/vitest-icon-color-bracketless.svg
 * Brand color: #00FF74
 */

import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

type VitestIconProps = SVGProps<SVGSVGElement> & {
  size?: number;
};

export function VitestIcon({ className, size = 16, ...props }: VitestIconProps) {
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
        d="M11.545 23.3a.613.613 0 0 1-.895.197L.252 15.936A.61.61 0 0 1 0 15.439V6.325c0-.502.569-.792.975-.497l6.358 4.624c.594.433 1.432.25 1.793-.39L14.393.7a.62.62 0 0 1 .535-.314h8.455a.613.613 0 0 1 .537.916z"
      />
    </svg>
  );
}

export default VitestIcon;
