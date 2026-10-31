import { useState, type WheelEvent } from "react";
import { ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";
import { useAnimatedPresence } from "../../hooks/useAnimatedPresence";
import { ScrollPill } from "@/components/ui/ScrollPill";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HollowCircle } from "@/components/icons";
import { STATE_COLORS } from "./terminalStateConfig";
import { pluralize } from "@/lib/pluralize";
import {
  UI_ENTER_DURATION,
  UI_ENTER_EASING,
  UI_EXIT_DURATION,
  UI_EXIT_EASING,
} from "@/lib/animationUtils";

/**
 * Height of the opaque band each pill sits in. The list treats a shown band as
 * its edge, so this is also the inset `useScrollIndicator` measures against.
 */
export const SCROLL_INDICATOR_BAND_HEIGHT_PX = 36;

interface ScrollIndicatorProps {
  direction: "above" | "below";
  /** Worktrees entirely past this edge of the list. */
  count: number;
  /** How many of those are in the quick-state bar's "Attention" bucket. */
  attentionCount?: number;
  onClick: () => void;
  /** A wheel over the band, which covers the list and so can't scroll it itself. */
  onWheel?: (event: WheelEvent<HTMLDivElement>) => void;
  tabIndex?: number;
  ariaHidden?: boolean;
}

interface Shown {
  count: number;
  attentionCount: number;
}

function describe(direction: "above" | "below", { count, attentionCount }: Shown): string {
  const hidden = `${count} more ${count === 1 ? "worktree" : "worktrees"} ${direction}`;
  if (attentionCount === 0) return hidden;
  return `${hidden}, ${pluralize(attentionCount, "needs", "need")} attention`;
}

// What a click does, which differs by state: the pill either jumps to a
// specific row or pages, and the person should know which before it moves.
function describeAction({ attentionCount }: Shown): string {
  if (attentionCount === 0) return "Click to show the next page";
  return attentionCount === 1 ? "Click to show it" : "Click to show the nearest";
}

export function ScrollIndicator({
  direction,
  count,
  attentionCount = 0,
  onClick,
  onWheel,
  tabIndex,
  ariaHidden,
}: ScrollIndicatorProps) {
  const { isVisible, shouldRender } = useAnimatedPresence({ isOpen: count > 0 });

  // Latch the last positive reading so the pill keeps showing what it had
  // while it fades out. Without this, a drop to 0 (scrolled to an edge, or a
  // filter/sort/group change that resets the offscreen counts) flips `isOpen`
  // false but holds `shouldRender` true for the exit animation, and the live
  // `count` prop — now 0 — would render a bare "0" mid-fade (#10316). The
  // attention count is latched WITH the count, as one reading: while the pill
  // is live both are live, so the mark never outlives the state it reports.
  // The latch is state adjusted during render, not a ref: React discards an
  // abandoned concurrent render's state update, so a stale count can't leak in.
  const [lastPositive, setLastPositive] = useState<Shown>({ count, attentionCount });
  if (
    count > 0 &&
    (count !== lastPositive.count || attentionCount !== lastPositive.attentionCount)
  ) {
    setLastPositive({ count, attentionCount });
  }
  const shown: Shown = count > 0 ? { count, attentionCount } : lastPositive;

  if (!shouldRender) return null;

  // A band on its way out is already gone as far as the list is concerned:
  // the rows it is uncovering are back on screen and must take their presses.
  const live = count > 0;
  const Icon = direction === "above" ? ChevronUp : ChevronDown;
  const description = describe(direction, shown);
  const action = describeAction(shown);

  return (
    // A full-width opaque band rather than a pill floating over the list: rows
    // keep their menu, chevron and alarm pills in the trailing corner, so a
    // bare pill covered the edge row's controls and took their clicks
    // (#15805), and centred it covered titles (#12010). A row behind the band
    // is past the edge, and the list counts it so. The band is hit-testable, so
    // its empty part can't click a row nobody can see, and it hands wheel
    // scrolling on to the list. Presses still bubble, so an open popover sees
    // one as an outside click. `pr-4` matches the card content column's gutter.
    <div
      aria-hidden={ariaHidden || undefined}
      data-sidebar-scroll-indicator={direction}
      onWheel={live ? onWheel : undefined}
      // A pointer shortcut, not a focus stop: without this a click leaves
      // focus on a button the accessibility tree has been told is absent.
      onMouseDown={(e) => e.preventDefault()}
      style={{ height: SCROLL_INDICATOR_BAND_HEIGHT_PX }}
      className={cn(
        "absolute inset-x-0 z-20 flex items-center justify-end pr-4",
        direction === "above" ? "top-0" : "bottom-0",
        !live && "pointer-events-none"
      )}
    >
      {/* The sidebar's own fill and grain, so the band reads as the list's
          edge rather than a panel over it. Fades with the pill. */}
      <div
        className={cn(
          "absolute inset-0 border-divider bg-surface-sidebar",
          "bg-(image:--chrome-noise-texture) bg-blend-soft-light",
          "transition-opacity",
          direction === "above" ? "border-b" : "border-t",
          isVisible ? "opacity-100" : "opacity-0"
        )}
        style={{
          transitionDuration: `${isVisible ? UI_ENTER_DURATION : UI_EXIT_DURATION}ms`,
          transitionTimingFunction: isVisible ? UI_ENTER_EASING : UI_EXIT_EASING,
        }}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <ScrollPill
            isVisible={isVisible}
            translateDirection={direction === "above" ? "up" : "down"}
            onClick={live ? onClick : undefined}
            tabIndex={tabIndex}
            aria-label={`${description}. ${action}`}
            className={cn(
              "relative flex items-center gap-1.5 px-2.5 py-1",
              !live && "pointer-events-none"
            )}
          >
            <Icon className="h-3 w-3" />
            <span className="font-medium tabular-nums">{shown.count}</span>
            {shown.attentionCount > 0 && (
              // The quick-state bar's "Attention" glyph, in its colour, so the
              // pill says "some of the Attention count is this way" in the one
              // vocabulary the sidebar already uses for it. A ring rather than a
              // filled square: in an agent tool a small solid square reads as
              // Stop, and forced colours flatten any hue to that shape.
              <HollowCircle
                data-testid="scroll-indicator-attention-mark"
                className={cn("h-3 w-3 shrink-0", STATE_COLORS.waiting)}
              />
            )}
          </ScrollPill>
        </TooltipTrigger>
        {/* Out past the sidebar's edge, clear of the list altogether. */}
        <TooltipContent side="right" className="text-xs">
          <div>{description}</div>
          <div className="text-text-secondary">{action}</div>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
