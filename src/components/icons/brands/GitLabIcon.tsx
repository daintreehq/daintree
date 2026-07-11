/**
 * GitLab tanuki mark — simplified single-path outline of the brand logo.
 * 24x24 viewBox, currentColor-aware to match other brand icons.
 */

import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

type GitLabIconProps = SVGProps<SVGSVGElement> & {
  size?: number;
  brandColor?: string;
};

export function GitLabIcon({ className, size = 16, brandColor, ...props }: GitLabIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={brandColor || "currentColor"}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn(className)}
      aria-hidden="true"
      {...props}
    >
      <path d="m22 13.29-3.33-10a.42.42 0 0 0-.14-.18.38.38 0 0 0-.22-.11.39.39 0 0 0-.23.07.42.42 0 0 0-.14.18l-2.26 6.67H8.32L6.1 3.26a.42.42 0 0 0-.1-.18.38.38 0 0 0-.26-.08.39.39 0 0 0-.23.07.42.42 0 0 0-.14.18L2 13.29a.74.74 0 0 0 .27.83L12 21l9.69-6.88a.71.71 0 0 0 .31-.83Z" />
    </svg>
  );
}

export default GitLabIcon;
