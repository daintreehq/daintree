import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface DockScrollChevronProps {
  side: "left" | "right";
  visible: boolean;
  onClick: () => void;
}

/**
 * Always mounted: reaching an end fades the chevron and its scrim out and
 * disables the button, rather than pulling it from under a cursor resting on
 * it. Its tooltip is closed with it, or it would outlive the button it labels.
 * The scrim spans the rail's full height so its fade has no hard top and bottom
 * edges across the chips beneath it.
 */
export function DockScrollChevron({ side, visible, onClick }: DockScrollChevronProps) {
  const [tooltipOpen, setTooltipOpen] = useState(false);
  // A disabled, pointer-inert button never hears the pointer leave, so the
  // open flag is dropped as it hides — or the tooltip would pop back up the
  // next time the chevron returns, wherever the cursor is by then.
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (!visible) setTooltipOpen(false);
  }
  const label = side === "left" ? "Scroll left" : "Scroll right";
  const Icon = side === "left" ? ChevronLeft : ChevronRight;

  return (
    <div
      data-dock-scroll-chevron={side}
      data-visible={visible}
      className={cn(
        "absolute inset-y-0 z-10 flex items-center pointer-events-none",
        "transition-opacity duration-150 ease-out",
        "contrast-more:bg-none contrast-more:bg-[var(--dock-bg)]",
        side === "left"
          ? "left-0 bg-gradient-to-r from-[var(--dock-bg)] via-[var(--dock-bg)]/90 to-transparent pr-4"
          : "right-0 bg-gradient-to-l from-[var(--dock-bg)] via-[var(--dock-bg)]/90 to-transparent pl-4",
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
              "p-1.5 text-text-secondary hover:text-text-primary",
              "rounded-[var(--radius-md)] transition-colors",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary",
              visible ? "pointer-events-auto" : "pointer-events-none"
            )}
            aria-label={label}
          >
            <Icon className="w-4 h-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </div>
  );
}
