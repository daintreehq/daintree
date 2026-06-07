import { useEffect, useRef } from "react";
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
  // `count` prop — now 0 — would render "0 more above/below" mid-fade (#10316).
  // The latch lives in an effect, not the render body: writing a ref during
  // render would let an abandoned concurrent render leak a stale count into it.
  const lastPositiveCountRef = useRef(count);
  useEffect(() => {
    if (count > 0) lastPositiveCountRef.current = count;
  }, [count]);
  const displayCount = count > 0 ? count : lastPositiveCountRef.current;

  if (!shouldRender) return null;

  const Icon = direction === "above" ? ChevronUp : ChevronDown;

  return (
    <div
      aria-hidden={ariaHidden || undefined}
      className={cn(
        "absolute left-0 right-0 z-20 pointer-events-none flex justify-center",
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
        <span>more {direction}</span>
      </ScrollPill>
    </div>
  );
}
