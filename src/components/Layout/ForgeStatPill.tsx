import type React from "react";
import { Button } from "@/components/ui/button";
import { FixedDropdown } from "@/components/ui/fixed-dropdown";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface ForgeStatPillProps {
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  open: boolean;
  count: number | null;
  /**
   * Pre-formatted value to render in the badge when it should differ from the
   * raw `count` — e.g. `"20+"` when the dropdown has loaded a first page but
   * more items exist. `count` stays numeric for the digit-pulse animation
   * delta comparisons; this is display-only. Falls back to `count` when unset.
   */
  displayCount?: number | string | null;
  animKey: number;
  ariaLabel: string;
  testId?: string;
  tooltipContent: React.ReactNode;

  icon: React.ComponentType<{ className?: string }>;
  iconClassName?: string;
  openRingClassName: string;
  className?: string;

  dropdownContent: React.ReactNode;
  persistThroughChildOverlays?: boolean;
  keepMounted?: boolean;

  onClick: () => void;
  onOpenChange: (open: boolean) => void;
  onPointerEnter?: (e: React.PointerEvent) => void;
  onPointerLeave?: (e: React.PointerEvent) => void;

  activityChip?: React.ReactNode;
}

export function ForgeStatPill({
  buttonRef,
  open,
  count,
  displayCount,
  animKey,
  ariaLabel,
  testId,
  tooltipContent,
  icon: Icon,
  iconClassName,
  openRingClassName,
  className,
  dropdownContent,
  persistThroughChildOverlays,
  keepMounted,
  onClick,
  onOpenChange,
  onPointerEnter,
  onPointerLeave,
  activityChip,
}: ForgeStatPillProps) {
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={buttonRef}
            variant="ghost"
            data-toolbar-item=""
            onPointerEnter={onPointerEnter}
            onPointerLeave={onPointerLeave}
            onClick={onClick}
            className={cn(
              // `scale` is in the set so the base cva's `active:scale-[0.98]
              // active:duration-[1ms]` press snap has a transitioned property to
              // act on — a bare `transition-opacity` here replaces the cva's
              // `transition` outright under tailwind-merge, which left both the
              // hover tint and the press scale uninterpolated.
              "toolbar-stat-pill h-full flex-1 justify-center gap-2 rounded-none px-2 text-daintree-text transition-[opacity,background-color,scale] hover:bg-[var(--toolbar-stats-hover-bg,var(--theme-overlay-hover))] hover:text-text-primary",
              activityChip != null && "relative",
              className,
              open &&
                cn(
                  "bg-[var(--toolbar-stats-hover-bg,var(--theme-overlay-hover))] text-text-primary",
                  openRingClassName
                )
            )}
            aria-label={ariaLabel}
            data-testid={testId}
          >
            <Icon className={cn("h-4 w-4", iconClassName)} />
            <span
              key={animKey}
              className={cn(
                "min-w-[2ch] text-center text-xs font-medium tabular-nums",
                animKey > 0 && "animate-badge-bump"
              )}
            >
              {displayCount ?? count ?? "—"}
            </span>
            {activityChip}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{tooltipContent}</TooltipContent>
      </Tooltip>
      <FixedDropdown
        open={open}
        onOpenChange={onOpenChange}
        anchorRef={buttonRef}
        className="p-0 w-[450px]"
        persistThroughChildOverlays={persistThroughChildOverlays}
        keepMounted={keepMounted}
      >
        {dropdownContent}
      </FixedDropdown>
    </>
  );
}
