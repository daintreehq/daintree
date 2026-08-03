/**
 * Source: https://github.com/tmux/tmux/blob/e26356607e38cbb4676a7c91815ae2d5734443c3/logo/tmux-logo-1-color.svg
 * Brand color: #1BB91F
 */

import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

type TmuxIconProps = SVGProps<SVGSVGElement> & {
  size?: number;
};

export function TmuxIcon({ className, size = 16, ...props }: TmuxIconProps) {
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
        d="M24 2.251V10.5H12.45V0h9.3A2.251 2.251 0 0 1 24 2.251zM12.45 11.4H24v10.5h-.008A2.25 2.25 0 0 1 21.75 24H2.25a2.247 2.247 0 0 1-2.242-2.1H0V2.251A2.251 2.251 0 0 1 2.25 0h9.3v21.6h.9V11.4zm11.242 10.5H.308a1.948 1.948 0 0 0 1.942 1.8h19.5a1.95 1.95 0 0 0 1.942-1.8z"
      />
    </svg>
  );
}

export default TmuxIcon;
