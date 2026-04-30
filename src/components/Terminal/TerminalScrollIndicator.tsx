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
  // Instant hide (animationDuration: 0): once the user catches up the pill
  // should disappear immediately rather than fade out symmetrically with show.
  const { isVisible, shouldRender } = useAnimatedPresence({
    isOpen: hasUnseenOutput,
    animationDuration: 0,
  });

  if (!shouldRender) return null;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    terminalInstanceService.resumeAutoScroll(terminalId);
    requestAnimationFrame(() => terminalInstanceService.focus(terminalId));
  };

  return (
    <div className="absolute inset-0 z-30 pointer-events-none flex items-end justify-end pb-4 pr-[14px]">
      <button
        type="button"
        className={cn(
          "pointer-events-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full",
          "bg-daintree-bg/90 border border-daintree-border/40 text-daintree-text shadow-[var(--theme-shadow-floating)]",
          "text-xs font-medium cursor-pointer",
          "hover:bg-daintree-bg hover:border-daintree-border/60",
          "transition duration-150",
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
