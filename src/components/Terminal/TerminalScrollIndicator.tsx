import { ChevronDown } from "lucide-react";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import { ScrollPill } from "@/components/ui/ScrollPill";
import { useUnseenOutput } from "@/hooks/useUnseenOutput";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TERMINAL_SCROLLBAR_WIDTH } from "@/config/xtermConfig";

// XtermAdapter pads the terminal `pr-3` and xterm draws its overlay scrollbar
// inside that, so the track runs from 12px to 12px + TERMINAL_SCROLLBAR_WIDTH
// off the pane's right edge. The pill clears it by the same 2px the fleet
// chip sits inside the text column on the left (`pl-[14px]` against `pl-3`),
// so the two chips frame the text column symmetrically. A pill over the track
// swallows track clicks and hides the thumb, which sits right there whenever
// the user is only a few lines back.
const PILL_RIGHT_INSET = 14 + TERMINAL_SCROLLBAR_WIDTH;

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
    // `overflow-hidden` keeps the floating shadow inside the terminal viewport.
    // Unclipped, the light themes' deep floating shadow smeared a grey patch
    // across the top of the composer below.
    <div
      className="absolute inset-0 z-30 pointer-events-none overflow-hidden flex items-end justify-end pb-1.5"
      style={{ paddingRight: PILL_RIGHT_INSET }}
    >
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
    </div>
  );
}
