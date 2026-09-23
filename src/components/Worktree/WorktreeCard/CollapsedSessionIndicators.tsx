import type { AgentState } from "@/types";
import { cn } from "@/lib/utils";
import { STATE_ICONS, STATE_COLORS } from "../terminalStateConfig";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";

interface CollapsedSessionIndicatorsProps {
  visibleStates: { state: AgentState; count: number }[];
  sessionAriaLabel: string;
}

/**
 * The per-state glyph + count a row shows in place of its hidden session list.
 *
 * Sized to the sidebar's session rows (12px glyph) rather than below them: at
 * 10px the ring drew at ~8px with a sub-pixel stroke, so working and waiting
 * separated on hue alone and collapsed to one shape under forced colors.
 *
 * The hue lives on the glyph and the count stays neutral. The state colours
 * are tuned as graphics (3:1), and as 11px text they fall under 4.5:1 in every
 * light theme — hokkaido's waiting amber reads at 3.2:1 — so a count in its
 * state's colour was the hardest thing in the row to read. The hue sits on a
 * wrapper span rather than on the glyph: forced colors repaints an HTML
 * element's `color` and the svg's `currentColor` stroke follows, but a colour
 * set on the `<svg>` itself survives, leaving waiting amber on white at 1.7:1.
 *
 * A `<span>`, not a `<div>`: one placement renders it inside the Sessions
 * disclosure `<button>`, which only admits phrasing content.
 *
 * The tooltip repeats the accessible name, total included. The total counts
 * sessions the breakdown omits (idle agents, plain shells), so it cannot be
 * recovered by adding up the segments — and the trigger is not focusable, so
 * the name is the only other place any of this is available.
 */
export function CollapsedSessionIndicators({
  visibleStates,
  sessionAriaLabel,
}: CollapsedSessionIndicatorsProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
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
                data-state={state}
                className="flex items-center gap-0.5 text-2xs font-medium text-text-secondary"
              >
                <span className={cn("flex shrink-0", STATE_COLORS[state])}>
                  <Icon
                    className={cn(
                      "w-3 h-3",
                      state === "working" && "animate-spin-slow motion-reduce:animate-none"
                    )}
                  />
                </span>
                <span className="font-mono tabular-nums">{count}</span>
              </span>
            );
          })}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {sessionAriaLabel}
      </TooltipContent>
    </Tooltip>
  );
}
