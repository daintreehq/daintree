import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

type AiderIconProps = SVGProps<SVGSVGElement> & {
  size?: number;
};

export function AiderIcon({ className, size = 16, ...props }: AiderIconProps) {
  // Lucide-style 24x24 outline of a lowercase "a" letterform — the official
  // aider.chat wordmark won't compose at icon size, so this distills it to
  // the dominant glyph in the brand mark.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn(className)}
      aria-hidden="true"
      {...props}
    >
      {/* Outer bowl of the lowercase "a" */}
      <path d="M16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" />
      {/* Right-side stem from cap to baseline */}
      <path d="M16 9v8" />
    </svg>
  );
}

export default AiderIcon;
