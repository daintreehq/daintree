import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SESSION_COLORS, SESSION_ICONS } from "@/components/Worktree/terminalStateConfig";
import { DOCK_STATE_GLYPH_CLASS } from "./dockChipStyles";

interface DockScrollChevronProps {
  side: "left" | "right";
  visible: boolean;
  /** A chip asking for the user is scrolled off past this edge. */
  attention?: boolean;
  onClick: () => void;
}

/**
 * Always mounted: reaching an end fades the chevron and its scrim out and
 * disables the button, rather than pulling it from under a cursor resting on
 * it. Its tooltip is closed with it, or it would outlive the button it labels.
 * The scrim spans the rail's full height so its fade has no hard top and bottom
 * edges across the chips beneath it, and is opaque under the button itself.
 *
 * When an asking chip is scrolled off past this edge the chevron carries the
 * app's waiting ring beside it, still and on the inner side, so the user knows
 * which way to scroll; the tray's count alone says only that one exists.
 */
export function DockScrollChevron({
  side,
  visible,
  attention = false,
  onClick,
}: DockScrollChevronProps) {
  const [tooltipOpen, setTooltipOpen] = useState(false);
  // A disabled, pointer-inert button never hears the pointer leave, so the
  // open flag is dropped as it hides — or the tooltip would pop back up the
  // next time the chevron returns, wherever the cursor is by then.
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (!visible) setTooltipOpen(false);
  }
  const label = `${side === "left" ? "Scroll left" : "Scroll right"}${attention ? " — a panel there needs attention" : ""}`;
  const WaitingGlyph = SESSION_ICONS.waiting;
  const Icon = side === "left" ? ChevronLeft : ChevronRight;

  return (
    <div
      data-dock-scroll-chevron={side}
      data-visible={visible}
      className={cn(
        "absolute inset-y-0 z-10 flex items-center pointer-events-none",
        "transition-opacity duration-150 ease-out",
        "contrast-more:bg-none contrast-more:bg-[var(--dock-bg)]",
        // Forced colours drops the gradient's colours; without its own backing
        // the chevron lands on the chip beneath it.
        "forced-colors:bg-none forced-colors:bg-[Canvas]",
        // ...and an edge on its inner side, so the chip it cuts reads as cut.
        side === "left"
          ? "forced-colors:border-r forced-colors:border-[CanvasText]"
          : "forced-colors:border-l forced-colors:border-[CanvasText]",
        // Solid under the button and faded only past it: a chip showing
        // through the chevron reads as part of it.
        side === "left"
          ? attention
            ? "left-0 bg-[linear-gradient(to_right,var(--dock-bg)_2.75rem,transparent)] pr-4"
            : "left-0 bg-[linear-gradient(to_right,var(--dock-bg)_1.75rem,transparent)] pr-4"
          : attention
            ? "right-0 bg-[linear-gradient(to_left,var(--dock-bg)_2.75rem,transparent)] pl-4"
            : "right-0 bg-[linear-gradient(to_left,var(--dock-bg)_1.75rem,transparent)] pl-4",
        visible ? "opacity-100" : "opacity-0"
      )}
    >
      <Tooltip open={visible && tooltipOpen} onOpenChange={setTooltipOpen}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onClick}
            disabled={!visible}
            tabIndex={-1}
            aria-hidden="true"
            className={cn(
              "flex items-center gap-1 p-1.5 text-text-secondary hover:text-text-primary",
              side === "right" && "flex-row-reverse",
              "rounded-[var(--radius-md)] transition-colors",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary",
              visible ? "pointer-events-auto" : "pointer-events-none"
            )}
            aria-label={label}
          >
            <Icon className="w-4 h-4" />
            {attention && (
              <WaitingGlyph
                aria-hidden="true"
                className={cn(DOCK_STATE_GLYPH_CLASS, SESSION_COLORS.waiting)}
              />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </div>
  );
}
