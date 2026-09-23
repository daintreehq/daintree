import { useState } from "react";
import { ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";
import { useAnimatedPresence } from "../../hooks/useAnimatedPresence";
import { ScrollPill } from "@/components/ui/ScrollPill";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface ScrollIndicatorProps {
  direction: "above" | "below";
  /** Worktrees entirely past this edge of the list. */
  count: number;
  /** How many of those have an agent waiting for input. */
  waitingCount?: number;
  onClick: () => void;
  tabIndex?: number;
  ariaHidden?: boolean;
}

interface Shown {
  count: number;
  waitingCount: number;
}

function describe(direction: "above" | "below", { count, waitingCount }: Shown): string {
  const hidden = `${count} more ${count === 1 ? "worktree" : "worktrees"} ${direction}`;
  return waitingCount > 0 ? `${hidden}, ${waitingCount} waiting for input` : hidden;
}

export function ScrollIndicator({
  direction,
  count,
  waitingCount = 0,
  onClick,
  tabIndex,
  ariaHidden,
}: ScrollIndicatorProps) {
  const { isVisible, shouldRender } = useAnimatedPresence({ isOpen: count > 0 });

  // Latch the last positive reading so the pill keeps showing what it had
  // while it fades out. Without this, a drop to 0 (scrolled to an edge, or a
  // filter/sort/group change that resets the offscreen counts) flips `isOpen`
  // false but holds `shouldRender` true for the exit animation, and the live
  // `count` prop — now 0 — would render a bare "0" mid-fade (#10316). The
  // waiting count is latched WITH the count, as one reading: while the pill is
  // live both are live, so a waiting mark never outlives the agent it reports.
  // The latch is state adjusted during render, not a ref: React discards an
  // abandoned concurrent render's state update, so a stale count can't leak in.
  const [lastPositive, setLastPositive] = useState<Shown>({ count, waitingCount });
  if (count > 0 && (count !== lastPositive.count || waitingCount !== lastPositive.waitingCount)) {
    setLastPositive({ count, waitingCount });
  }
  const shown: Shown = count > 0 ? { count, waitingCount } : lastPositive;

  if (!shouldRender) return null;

  const Icon = direction === "above" ? ChevronUp : ChevronDown;
  const description = describe(direction, shown);

  return (
    // Trailing edge, not centred: sidebar rows put identity text in a leading
    // `min-w-0 flex-1` block and icons in a trailing `shrink-0` one, so a
    // centred pill lands on the worktree title or the "Changed files" heading —
    // the text you're scanning while you scroll (#12010). `pr-4` matches the
    // card content column's own right gutter, which also keeps the pill off the
    // active row's 2px inset accent edge at `right-0` (`sidebar.css`).
    <div
      aria-hidden={ariaHidden || undefined}
      data-sidebar-scroll-indicator={direction}
      className={cn(
        "absolute left-0 right-0 z-20 pointer-events-none flex justify-end pr-4",
        direction === "above" ? "top-0 pt-2" : "bottom-0 pb-2"
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <ScrollPill
            isVisible={isVisible}
            translateDirection={direction === "above" ? "up" : "down"}
            onClick={onClick}
            onPointerDown={(e) => e.stopPropagation()}
            // A pointer shortcut, not a focus stop: without this a click leaves
            // focus on a button the accessibility tree has been told is absent.
            onMouseDown={(e) => e.preventDefault()}
            tabIndex={tabIndex}
            aria-label={description}
            className="flex items-center gap-1.5 px-2.5 py-1"
          >
            <Icon className="h-3 w-3" />
            <span className="font-medium tabular-nums">{shown.count}</span>
            {shown.waitingCount > 0 && (
              // The collapsed card's waiting mark, at the same size and in the
              // same token: a solid square, never rounded (a pill is selection,
              // a rectangle is status — `WorktreeStatusTick`). Its presence is
              // the signal, so it does not lean on hue alone, and `status-mark`
              // keeps it painted under forced colours.
              <span
                data-testid="scroll-indicator-waiting-mark"
                className="status-mark h-1.5 w-1.5 shrink-0 bg-activity-waiting"
              />
            )}
          </ScrollPill>
        </TooltipTrigger>
        <TooltipContent side="left" className="text-xs">
          {description}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
