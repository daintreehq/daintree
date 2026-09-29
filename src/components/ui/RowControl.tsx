import type { ReactElement, ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { createTooltipContent } from "@/lib/tooltipShortcut";

/**
 * An inline control inside a list row — pin, hide, launch-in-dock, set-default.
 * 24px so it clears WCAG 2.5.8 without the row growing, the Ghost recipe's
 * `overlay-hover` fill (the one overlay the theme validator floors), and a real
 * transition on the fill: `transition-opacity` alone snapped it. Opacity is in
 * the list because most of these reveal on row hover or selection.
 */
export const ROW_CONTROL_CLASS =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border-0 bg-transparent text-text-secondary cursor-pointer transition-[opacity,color,background-color] duration-150 ease-out hover:bg-overlay-hover hover:text-text-primary motion-reduce:transition-none";

interface RowControlTooltipProps {
  label: ReactNode;
  /** A chord in keybinding syntax ("Alt+P", "P"), rendered as keycaps. */
  shortcut?: string;
  side?: "top" | "right" | "bottom" | "left";
  children: ReactElement;
}

/**
 * The shared tooltip for a row control that cannot be a Button. Inside
 * `role="option"` or `role="menuitem"` the control has to be an `aria-hidden`
 * span (a real button trips `nested-interactive`), so it has no focus and its
 * keyboard route is the row's own chord, which the row names to assistive tech.
 * This is therefore pointer-only by construction: it never adds a tab stop,
 * and it replaces `title=`, which was the only way these controls explained
 * themselves.
 */
export function RowControlTooltip({
  label,
  shortcut,
  side = "top",
  children,
}: RowControlTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{createTooltipContent(label, shortcut)}</TooltipContent>
    </Tooltip>
  );
}
