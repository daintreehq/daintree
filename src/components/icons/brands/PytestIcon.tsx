/**
 * Source: https://github.com/pytest-dev/design/blob/081f06cd2d6cd742e68f593560a2e8c1802feb7c/pytest_logo/pytest_logo.svg
 * Brand color: #0A9EDC
 */

import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

type PytestIconProps = SVGProps<SVGSVGElement> & {
  size?: number;
};

export function PytestIcon({ className, size = 16, ...props }: PytestIconProps) {
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
        d="M2.6152 0v.8867h3.8399V0zm5.0215 0v.8867h3.8418V0zm4.957 0v.8867h3.8418V0zm4.9356 0v.8867h3.8418V0zM2.4473 1.8945a.935.935 0 0 0-.9356.9356c0 .517.4185.9375.9356.9375h19.1054c.5171 0 .9356-.4204.9356-.9375a.935.935 0 0 0-.9356-.9356zm.168 2.8477V24H6.455V4.7422zm5.0214 0V20.543h3.8418V4.7422zm4.957 0V15.291h3.8497V4.7422zm4.9356 0v6.4941h3.8418V4.7422z"
      />
    </svg>
  );
}

export default PytestIcon;
