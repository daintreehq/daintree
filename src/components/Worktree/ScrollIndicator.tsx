import { useState } from "react";
import { ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";
import { useAnimatedPresence } from "../../hooks/useAnimatedPresence";
import { ScrollPill } from "@/components/ui/ScrollPill";

interface ScrollIndicatorProps {
  direction: "above" | "below";
  count: number;
  onClick: () => void;
  tabIndex?: number;
  ariaHidden?: boolean;
}

export function ScrollIndicator({
  direction,
  count,
  onClick,
  tabIndex,
  ariaHidden,
}: ScrollIndicatorProps) {
  const { isVisible, shouldRender } = useAnimatedPresence({ isOpen: count > 0 });

  // Latch the last positive count so the pill keeps showing the number it had
  // while it fades out. Without this, a drop to 0 (scrolled to an edge, or a
  // filter/sort/group change that resets the offscreen counts) flips `isOpen`
  // false but holds `shouldRender` true for the exit animation, and the live
  // `count` prop — now 0 — would render a bare "0" mid-fade (#10316).
  // The latch is state adjusted during render, not a ref: React discards an
  // abandoned concurrent render's state update, so a stale count can't leak in.
  const [lastPositiveCount, setLastPositiveCount] = useState(count);
  if (count > 0 && count !== lastPositiveCount) setLastPositiveCount(count);
  const displayCount = count > 0 ? count : lastPositiveCount;

  if (!shouldRender) return null;

  const Icon = direction === "above" ? ChevronUp : ChevronDown;

  return (
    // Trailing edge, not centred: sidebar rows put identity text in a leading
    // `min-w-0 flex-1` block and icons in a trailing `shrink-0` one, so a
    // centred pill lands on the worktree title or the "Changed files" heading —
    // the text you're scanning while you scroll (#12010). `pr-4` matches the
    // card content column's own right gutter, which also keeps the pill off the
    // active row's 2px inset accent edge at `right-0` (`sidebar.css`).
    <div
      aria-hidden={ariaHidden || undefined}
      className={cn(
        "absolute left-0 right-0 z-20 pointer-events-none flex justify-end pr-4",
        direction === "above" ? "top-0 pt-2" : "bottom-0 pb-2"
      )}
    >
      <ScrollPill
        isVisible={isVisible}
        translateDirection={direction === "above" ? "up" : "down"}
        onClick={onClick}
        onPointerDown={(e) => e.stopPropagation()}
        tabIndex={tabIndex}
        aria-label={
          direction === "above"
            ? `Scroll up, ${displayCount} more above`
            : `Scroll down, ${displayCount} more below`
        }
        className="flex items-center gap-1.5 px-2.5 py-1"
      >
        <Icon className="h-3 w-3" />
        <span className="font-medium tabular-nums">{displayCount}</span>
      </ScrollPill>
    </div>
  );
}
