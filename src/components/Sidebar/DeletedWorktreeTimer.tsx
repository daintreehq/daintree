import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TRUNCATION_DISCLOSURE_ATTR } from "@/lib/accessibility";
import type { DeletedWorktreeCountdown } from "./useDeletedWorktreeCountdown";

type TimerState = Pick<DeletedWorktreeCountdown, "hold" | "remainingSeconds">;

/**
 * The one sentence a row's seconds readout is explained by: counting down, or
 * holding and why.
 */
export function describeDeletedWorktreeTimer({ hold, remainingSeconds }: TimerState): string {
  return hold !== undefined
    ? `${hold.tooltip}, holding at ${remainingSeconds}s`
    : `Closes automatically in ${remainingSeconds}s`;
}

/** The same sentence for assistive tech, with the unit spelled out. */
export function labelDeletedWorktreeTimer({ hold, remainingSeconds }: TimerState): string {
  return hold !== undefined
    ? `${hold.tooltip}, holding at ${remainingSeconds} seconds`
    : `Closes automatically in ${remainingSeconds} seconds`;
}

interface DeletedWorktreeTimerProps {
  /** What the tooltip says; the visible readout is `children`. */
  description: string;
  ariaLabel: string;
  "data-testid": string;
  children: ReactNode;
}

/**
 * A deleted-worktree seconds readout with a themed tooltip. A native `title`
 * opens late, ignores the theme and cannot be reached from the keyboard, so the
 * readout is a tab stop that reveals what the number is doing.
 */
export function DeletedWorktreeTimer({
  description,
  ariaLabel,
  children,
  "data-testid": testId,
}: DeletedWorktreeTimerProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="timer"
          tabIndex={0}
          {...{ [TRUNCATION_DISCLOSURE_ATTR]: "" }}
          aria-label={ariaLabel}
          className={cn(
            "shrink-0 rounded-[var(--radius-sm)] font-mono text-2xs tabular-nums text-text-secondary",
            "outline-hidden focus-visible:outline-solid focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
          )}
          data-testid={testId}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{description}</TooltipContent>
    </Tooltip>
  );
}
