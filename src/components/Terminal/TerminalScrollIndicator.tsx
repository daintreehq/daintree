import { ChevronDown } from "lucide-react";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import { ScrollPill } from "@/components/ui/ScrollPill";
import { useUnseenOutput } from "@/hooks/useUnseenOutput";
import { peek as peekTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";

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
    peekTerminalService()?.resumeAutoScroll(terminalId);
    requestAnimationFrame(() => peekTerminalService()?.focus(terminalId));
  };

  // Rendered inside `TerminalChipRow`, which owns the position, insets and
  // shadow clip it shares with the fleet chip.
  return (
    <ScrollPill
      isVisible={isVisible}
      translateDirection="down"
      className="flex items-center gap-1 px-2 py-0.5"
      onClick={handleClick}
      onPointerDown={(e) => e.stopPropagation()}
      aria-label="New output below, scroll to latest output"
    >
      <ChevronDown className="h-3 w-3" />
      New output below
    </ScrollPill>
  );
}
