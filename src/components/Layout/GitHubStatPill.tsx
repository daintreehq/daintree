import type React from "react";
import { Button } from "@/components/ui/button";
import { FixedDropdown } from "@/components/ui/fixed-dropdown";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface GitHubStatPillProps {
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  open: boolean;
  count: number | null;
  animKey: number;
  ariaLabel: string;
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
  freshnessGlyph?: React.ReactNode;
}

export function GitHubStatPill({
  buttonRef,
  open,
  count,
  animKey,
  ariaLabel,
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
  freshnessGlyph,
}: GitHubStatPillProps) {
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
              "h-full gap-2 rounded-none px-3 text-daintree-text transition-opacity hover:bg-[var(--toolbar-stats-hover-bg,var(--theme-overlay-hover))] hover:text-text-primary",
              activityChip != null && "relative",
              className,
              open &&
                cn(
                  "bg-[var(--toolbar-stats-hover-bg,var(--theme-overlay-hover))] text-text-primary",
                  openRingClassName
                )
            )}
            aria-label={ariaLabel}
          >
            <Icon className={cn("h-4 w-4", iconClassName)} />
            <span
              key={animKey}
              className={cn(
                "text-xs font-medium tabular-nums",
                animKey > 0 && "animate-badge-bump"
              )}
            >
              {count ?? "—"}
            </span>
            {freshnessGlyph}
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
