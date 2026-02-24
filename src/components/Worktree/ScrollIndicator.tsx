import { ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";

interface ScrollIndicatorProps {
  direction: "above" | "below";
  count: number;
  onClick: () => void;
}

export function ScrollIndicator({ direction, count, onClick }: ScrollIndicatorProps) {
  if (count <= 0) return null;

  const Icon = direction === "above" ? ChevronUp : ChevronDown;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "absolute left-0 right-0 z-20 py-1.5 px-4",
        "text-xs text-canopy-text/65 hover:text-canopy-text/90",
        "transition-colors cursor-pointer",
        "flex items-center justify-center gap-1.5",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-1",
        direction === "above" &&
          "top-0 bg-gradient-to-b from-[var(--color-canopy-sidebar)] via-[var(--color-canopy-sidebar)]/80 to-transparent",
        direction === "below" &&
          "bottom-0 bg-gradient-to-t from-[var(--color-canopy-sidebar)] via-[var(--color-canopy-sidebar)]/80 to-transparent"
      )}
    >
      <Icon className="w-3 h-3" />
      <span className="font-medium tabular-nums">{count}</span>
      <span>more {direction === "above" ? "above" : "below"}</span>
    </button>
  );
}
