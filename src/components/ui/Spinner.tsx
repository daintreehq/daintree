import type { CSSProperties } from "react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

const SIZE_CLASSES = {
  xs: "w-3 h-3",
  sm: "w-3.5 h-3.5",
  md: "w-4 h-4",
  lg: "w-5 h-5",
  xl: "w-6 h-6",
  "2xl": "w-8 h-8",
} as const;

type SpinnerSize = keyof typeof SIZE_CLASSES;

interface SpinnerProps {
  size?: SpinnerSize;
  className?: string;
  /**
   * Lands on the rotating wrapper, and the glyph takes its colour from it —
   * which is how `InlineStatusBanner` tints an `icon` to the band's severity.
   */
  style?: CSSProperties;
}

/**
 * The rotation runs on an HTML wrapper, not the `<svg>`: Chromium cannot run a
 * transform animation on the compositor when its target is an svg, so it
 * re-runs style on the main thread every frame for as long as the spinner is
 * visible (#12584). Size, placement and colour classes land on the wrapper,
 * which is block-level like the svg it replaces; the glyph fills it.
 */
export function Spinner({ size = "md", className, style }: SpinnerProps) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center animate-spin motion-reduce:animate-none",
        SIZE_CLASSES[size],
        className
      )}
      style={style}
      aria-hidden="true"
    >
      <Loader2 className="size-full" />
    </span>
  );
}
