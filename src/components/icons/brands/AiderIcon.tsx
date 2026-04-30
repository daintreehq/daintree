import { cn } from "@/lib/utils";

interface AiderIconProps {
  className?: string;
  size?: number;
  brandColor?: string;
}

export function AiderIcon({ className, size = 16, brandColor }: AiderIconProps) {
  // Lucide-style 24x24 outline of a lowercase "a" letterform — the official
  // aider.chat wordmark won't compose at icon size, so this distills it to
  // the dominant glyph in the brand mark.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={brandColor || "currentColor"}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      className={cn(className)}
      aria-hidden="true"
    >
      {/* Outer bowl of the lowercase "a" */}
      <path d="M16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" />
      {/* Right-side stem from cap to baseline */}
      <path d="M16 9v8" />
    </svg>
  );
}

export default AiderIcon;
