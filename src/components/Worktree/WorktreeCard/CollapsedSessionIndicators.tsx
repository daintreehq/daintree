import type { AgentState } from "@/types";
import { cn } from "@/lib/utils";
import { STATE_ICONS, STATE_COLORS, STATE_LABELS } from "../terminalStateConfig";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";

interface CollapsedSessionIndicatorsProps {
  visibleStates: { state: AgentState; count: number }[];
  sessionAriaLabel: string;
}

export function CollapsedSessionIndicators({
  visibleStates,
  sessionAriaLabel,
}: CollapsedSessionIndicatorsProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="flex items-center gap-1.5 shrink-0"
          role="img"
          aria-label={sessionAriaLabel}
          data-testid="collapsed-session-indicators"
        >
          {visibleStates.map(({ state, count }) => {
            const Icon = STATE_ICONS[state];
            return (
              <span
                key={state}
                aria-hidden="true"
                className={cn("flex items-center gap-0.5 text-[10px]", STATE_COLORS[state])}
              >
                <Icon
                  className={cn(
                    "w-2.5 h-2.5",
                    state === "working" && "animate-spin-slow motion-reduce:animate-none"
                  )}
                />
                <span className="font-mono tabular-nums">{count}</span>
              </span>
            );
          })}
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {visibleStates.map((v) => `${v.count} ${STATE_LABELS[v.state]}`).join(", ")}
      </TooltipContent>
    </Tooltip>
  );
}
