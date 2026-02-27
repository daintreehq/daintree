import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { getActivityColor } from "@/utils/colorInterpolation";
import { formatTimestampExact } from "@/utils/textParsing";
import { useGlobalSecondTicker } from "@/hooks/useGlobalSecondTicker";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";

interface ActivityLightProps {
  lastActivityTimestamp?: number | null;
  className?: string;
}

const GRAY_COLOR = "#52525b";

/**
 * Activity indicator that fades from green to gray over 90 seconds.
 * Uses a shared global ticker for efficiency.
 */
export function ActivityLight({ lastActivityTimestamp, className }: ActivityLightProps) {
  const globalTick = useGlobalSecondTicker();
  const [color, setColor] = useState(() => getActivityColor(lastActivityTimestamp));

  useEffect(() => {
    if (lastActivityTimestamp == null) {
      setColor(GRAY_COLOR);
      return;
    }

    const newColor = getActivityColor(lastActivityTimestamp);
    setColor(newColor);

    if (newColor === GRAY_COLOR) {
      return;
    }
  }, [lastActivityTimestamp, globalTick]);

  const tooltipText = formatTimestampExact(lastActivityTimestamp);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "w-2.5 h-2.5 rounded-full transition-colors duration-1000 ease-linear",
              className
            )}
            style={{ backgroundColor: color }}
            role="status"
            aria-label={tooltipText}
          />
        </TooltipTrigger>
        <TooltipContent side="bottom">{tooltipText}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
