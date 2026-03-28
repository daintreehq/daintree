import { ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";
import { useAnimatedPresence } from "../../hooks/useAnimatedPresence";

interface ScrollIndicatorProps {
  direction: "above" | "below";
  count: number;
  onClick: () => void;
}

export function ScrollIndicator({ direction, count, onClick }: ScrollIndicatorProps) {
  const { isVisible, shouldRender } = useAnimatedPresence({ isOpen: count > 0 });

  if (!shouldRender) return null;

  const Icon = direction === "above" ? ChevronUp : ChevronDown;

  return (
    <div
      className={cn(
        "absolute left-0 right-0 z-20 pointer-events-none flex justify-center",
        direction === "above" ? "top-0 pt-2" : "bottom-0 pb-2"
      )}
    >
      <button
        type="button"
        onClick={onClick}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label={
          direction === "above"
            ? `Scroll up, ${count} more above`
            : `Scroll down, ${count} more below`
        }
        className={cn(
          "pointer-events-auto flex items-center gap-1.5 px-2.5 py-1 rounded-full",
          "bg-canopy-bg/90 border border-canopy-border/40 text-canopy-text shadow-[var(--theme-shadow-floating)]",
          "text-xs font-medium cursor-pointer",
          "hover:bg-canopy-bg hover:border-canopy-border/60",
          "transition-all duration-150",
          "motion-reduce:transition-none motion-reduce:duration-0 motion-reduce:transform-none",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-1",
          isVisible
            ? "opacity-100 translate-y-0"
            : direction === "above"
              ? "opacity-0 -translate-y-2"
              : "opacity-0 translate-y-2"
        )}
      >
        <Icon className="h-3 w-3" />
        <span className="font-medium tabular-nums">{count}</span>
        <span>more {direction}</span>
      </button>
    </div>
  );
}
