import { useState } from "react";
import { ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";
import { useAnimatedPresence } from "../../hooks/useAnimatedPresence";
import { ScrollPill } from "@/components/ui/ScrollPill";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HollowCircle } from "@/components/icons";
import { STATE_COLORS } from "./terminalStateConfig";

interface ScrollIndicatorProps {
  direction: "above" | "below";
  /** Worktrees entirely past this edge of the list. */
  count: number;
  /** How many of those are in the quick-state bar's "Attention" bucket. */
  attentionCount?: number;
  onClick: () => void;
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
  return `${hidden}, ${attentionCount} ${attentionCount === 1 ? "needs" : "need"} attention`;
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

  const Icon = direction === "above" ? ChevronUp : ChevronDown;
  const description = describe(direction, shown);
  const action = describeAction(shown);

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
            aria-label={`${description}. ${action}`}
            className="flex items-center gap-1.5 px-2.5 py-1"
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
        {/* Out past the sidebar's edge: to the left it would sit on the very
            titles the trailing placement keeps the pill off. */}
        <TooltipContent side="right" className="text-xs">
          <div>{description}</div>
          <div className="text-text-secondary">{action}</div>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
