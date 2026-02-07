import { Ban } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";

export interface GridFullOverlayProps {
  maxTerminals: number;
  show: boolean;
}

export function GridFullOverlay({ maxTerminals, show }: GridFullOverlayProps) {
  const { isVisible, shouldRender } = useAnimatedPresence({ isOpen: show });

  if (!shouldRender) return null;

  return (
    <div
      className={cn(
        "absolute inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/60 backdrop-blur-sm pointer-events-none",
        "transition-opacity duration-150",
        "motion-reduce:transition-none motion-reduce:duration-0",
        isVisible ? "opacity-100" : "opacity-0"
      )}
    >
      <div
        className={cn(
          "flex flex-col items-center gap-3 text-center px-6 py-4 rounded-[var(--radius-xl)] bg-canopy-bg/90 border border-canopy-border/40 shadow-xl",
          "transition-all duration-150",
          "motion-reduce:transition-none motion-reduce:duration-0 motion-reduce:transform-none",
          isVisible ? "opacity-100 translate-y-0 scale-100" : "opacity-0 translate-y-1 scale-[0.98]"
        )}
      >
        <Ban className="h-8 w-8 text-amber-400" />
        <div>
          <p className="text-sm font-medium text-canopy-text">Grid is full</p>
          <p className="text-xs text-canopy-text/60 mt-1">
            Maximum {maxTerminals} terminals. Close one to add more.
          </p>
        </div>
      </div>
    </div>
  );
}
