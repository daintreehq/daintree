/**
 * Source: https://github.com/evanw/esbuild/blob/ac542f913908d7326b65eb2e01f0559ed135a40e/images/logo.svg
 * Brand color: #FFCF00
 */

import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

type EsbuildIconProps = SVGProps<SVGSVGElement> & {
  size?: number;
};

export function EsbuildIcon({ className, size = 16, ...props }: EsbuildIconProps) {
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
        d="M12 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0zM6.718 5.282L13.436 12l-6.718 6.718-2.036-2.036L9.364 12 4.682 7.318zm7.2 0L20.636 12l-6.718 6.718-2.036-2.036L16.564 12l-4.682-4.682z"
      />
    </svg>
  );
}

export default EsbuildIcon;
