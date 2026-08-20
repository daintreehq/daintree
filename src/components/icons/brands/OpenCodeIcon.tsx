import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

type OpenCodeIconProps = SVGProps<SVGSVGElement> & {
  size?: number;
};

export function OpenCodeIcon({ className, size = 16, ...props }: OpenCodeIconProps) {
  // Official OpenCode logo: rectangular frame with inner square
  // Adapted from opencode-logo-light.svg (240x300 viewBox)
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn(className)}
      aria-hidden="true"
      {...props}
    >
      {/* Outer frame with cutout - the distinctive OpenCode "O" shape */}
      <path
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M2 2h20v20H2V2zm5 3h10v12H7V5z"
      />
      {/* Inner square at bottom. Opaque rather than the old 40%: the glyph is
          knocked out of the badge tile now, so a mid-tone shape would sit near
          2.4:1 against it while the binary silhouette clears the floor. */}
      <rect x="7" y="10" width="10" height="7" fill="currentColor" />
    </svg>
  );
}

export default OpenCodeIcon;
