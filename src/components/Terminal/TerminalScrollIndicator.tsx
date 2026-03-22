import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import { useUnseenOutput } from "@/hooks/useUnseenOutput";
import { terminalInstanceService } from "@/services/TerminalInstanceService";

export interface TerminalScrollIndicatorProps {
  terminalId: string;
}

export function TerminalScrollIndicator({ terminalId }: TerminalScrollIndicatorProps) {
  const { hasUnseenOutput } = useUnseenOutput(terminalId);
  const { isVisible, shouldRender } = useAnimatedPresence({ isOpen: hasUnseenOutput });

  if (!shouldRender) return null;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    terminalInstanceService.resumeAutoScroll(terminalId);
    requestAnimationFrame(() => terminalInstanceService.focus(terminalId));
  };

  return (
    <div className="absolute inset-0 z-30 pointer-events-none flex items-end justify-center pb-4">
      <button
        type="button"
        className={cn(
          "pointer-events-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full",
          "bg-canopy-bg/90 border border-canopy-border/40 text-canopy-text shadow-[var(--theme-shadow-floating)]",
          "text-xs font-medium cursor-pointer",
          "hover:bg-canopy-bg hover:border-canopy-border/60",
          "transition-all duration-150",
          "motion-reduce:transition-none motion-reduce:duration-0 motion-reduce:transform-none",
          isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
        )}
        onClick={handleClick}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label="Scroll to latest output"
      >
        <ChevronDown className="h-3.5 w-3.5" />
        New output below
      </button>
    </div>
  );
}
