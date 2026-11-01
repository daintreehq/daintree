import type { SessionPresentationState } from "@/lib/handBackPresentation";
import { cn } from "@/lib/utils";
import { SESSION_ICONS, SESSION_COLORS } from "../terminalStateConfig";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";

interface CollapsedSessionIndicatorsProps {
  visibleStates: { state: SessionPresentationState; count: number }[];
  sessionAriaLabel: string;
  /**
   * Applied to every group but the one that matters most (waiting, else the
   * first), so a cramped row keeps a single state and gives the rest of its
   * width to the title. The tooltip and accessible name keep the breakdown.
   */
  secondaryClassName?: string;
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
  secondaryClassName,
}: CollapsedSessionIndicatorsProps) {
  // Waiting, when present, is drawn last: nearest the card's controls, at the
  // one x every card's waiting ring lands on, with any other states ahead of
  // it rather than pushing it along the row.
  const waitingAt = visibleStates.findIndex((v) => v.state === "waiting");
  const ordered =
    waitingAt === -1
      ? visibleStates
      : [...visibleStates.filter((_, i) => i !== waitingAt), visibleStates[waitingAt]!];
  const leadIndex = waitingAt === -1 ? 0 : ordered.length - 1;
  return (
    // The breakdown is the only full reading once a narrow row drops groups,
    // so it stays while hovered or focused and can be hovered itself.
    <Tooltip autoDismiss={false} disableHoverableContent={false}>
      <TooltipTrigger asChild>
        <span
          className="flex items-center gap-1.5 shrink-0"
          role="img"
          aria-label={sessionAriaLabel}
          data-testid="collapsed-session-indicators"
        >
          {ordered.map(({ state, count }, index) => {
            const Icon = SESSION_ICONS[state];
            return (
              <span
                key={state}
                aria-hidden="true"
                data-state={state}
                className={cn(
                  "flex items-center gap-0.5 text-2xs font-medium text-text-secondary",
                  index !== leadIndex && secondaryClassName
                )}
              >
                <span className={cn("flex shrink-0", SESSION_COLORS[state])}>
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
