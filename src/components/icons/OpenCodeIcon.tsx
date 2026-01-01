import { cn } from "@/lib/utils";

interface OpenCodeIconProps {
  className?: string;
  size?: number;
  brandColor?: string;
}

export function OpenCodeIcon({ className, size = 16, brandColor }: OpenCodeIconProps) {
  // Official OpenCode logo: rectangular frame with inner square
  // Adapted from opencode-logo-light.svg (240x300 viewBox)
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn(className)}
      aria-hidden="true"
    >
      {/* Outer frame with cutout - the distinctive OpenCode "O" shape */}
      <path
        fill={brandColor || "currentColor"}
        fillRule="evenodd"
        clipRule="evenodd"
        d="M2 2h20v20H2V2zm5 3h10v12H7V5z"
      />
      {/* Inner square at bottom */}
      <rect x="7" y="10" width="10" height="7" fill={brandColor || "currentColor"} opacity="0.4" />
    </svg>
  );
}

export default OpenCodeIcon;
