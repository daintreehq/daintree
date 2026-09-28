import type React from "react";
import { m } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UI_ANIMATION_DURATION, EASE_OUT_EXPO_FM } from "@/lib/animationUtils";

/**
 * The document tab family: the grid pane's tab group, the dock popover's tab
 * group, the portal's browser tabs and the assistant's session lanes. One look,
 * one close control, one keyboard contract (APG tabs, manual activation, Delete
 * closes, the tab stop sits on the selected tab).
 *
 * This owns what the family shares; hosts own their geometry (padding, height,
 * width limits) and their content (icons, labels, state glyphs).
 *
 * Every tab also carries `data-document-tab`, the hook for the forced-colors
 * selection fallback in `index.css`.
 */
export function documentTabClassName(isActive: boolean): string {
  return cn(
    "group/tab relative flex items-center gap-1.5 text-xs font-medium select-none cursor-pointer",
    "border-r border-divider transition-colors duration-150 ease-out",
    // Inset, so the ring stays inside the strip rather than meeting the rules
    // above and below it.
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-[-2px]",
    isActive
      ? "bg-tint/[0.04] text-text-primary"
      : "text-text-secondary hover:text-text-primary hover:bg-overlay-subtle"
  );
}

/**
 * The selected tab's 2px accent underline. Render it only inside the selected
 * tab: the shared `layoutId` makes it slide between tabs, so each strip must
 * sit inside its own `LayoutGroup` or the mark would travel between strips.
 */
export function DocumentTabIndicator() {
  return (
    <m.div
      layoutId="document-tab-indicator"
      layout="position"
      data-document-tab-indicator=""
      className="absolute inset-x-0 bottom-0 h-0.5 bg-accent-primary pointer-events-none"
      transition={{ duration: UI_ANIMATION_DURATION / 1000, ease: EASE_OUT_EXPO_FM }}
      aria-hidden="true"
    />
  );
}

/**
 * Scroll a strip so one of its tabs is fully on screen. Measured in the
 * strip's own scroll coordinates rather than from `offsetLeft`, which is
 * relative to whatever positioned box the host wraps its tabs in. A tab wider
 * than the strip shows its start — the glyph and first words identify it.
 */
export function revealTabInStrip(
  strip: HTMLElement,
  tab: HTMLElement,
  behavior: ScrollBehavior
): void {
  const tabLeft =
    tab.getBoundingClientRect().left - strip.getBoundingClientRect().left + strip.scrollLeft;
  const tabRight = tabLeft + tab.offsetWidth;
  if (tabLeft < strip.scrollLeft || tab.offsetWidth > strip.clientWidth) {
    strip.scrollTo({ left: tabLeft, behavior });
  } else if (tabRight > strip.scrollLeft + strip.clientWidth) {
    strip.scrollTo({ left: tabRight - strip.clientWidth, behavior });
  }
}

export interface DocumentTabCloseProps {
  /** The tab's own title, for the control's label. */
  title: string;
  isActive: boolean;
  onClose: () => void;
  className?: string;
}

/**
 * The tab's close control.
 *
 * Pointer-only on purpose. It sits inside the element that carries `role="tab"`,
 * and a focusable control there is the nesting ARIA forbids, so it takes no
 * focus (`tabIndex={-1}`), is hidden from the accessibility tree, and the
 * keyboard route is Delete on the focused tab, which every strip handles and
 * advertises with `aria-keyshortcuts`. Refusing focus at mousedown keeps focus
 * where it was instead of on a node about to unmount.
 *
 * Always shown on the selected tab, revealed on hover or keyboard focus for the
 * others; the box is reserved either way so nothing shifts when it appears.
 */
export function DocumentTabClose({ title, isActive, onClose, className }: DocumentTabCloseProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          tabIndex={-1}
          aria-hidden="true"
          aria-label={`Close ${title}`}
          data-document-tab-close=""
          onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
          onPointerDown={(e: React.PointerEvent) => e.stopPropagation()}
          onDoubleClick={(e: React.MouseEvent) => e.stopPropagation()}
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            onClose();
          }}
          className={cn(
            "shrink-0",
            isActive
              ? "opacity-100"
              : "opacity-0 group-hover/tab:opacity-100 group-focus-visible/tab:opacity-100",
            "hover:bg-status-error/15 hover:text-status-error",
            className
          )}
        >
          <X aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Close tab</TooltipContent>
    </Tooltip>
  );
}
