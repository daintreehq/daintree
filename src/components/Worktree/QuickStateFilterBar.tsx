import { useRef } from "react";
import { cn } from "@/lib/utils";
import { useToolbarRoving } from "@/hooks/useToolbarRoving";
import type { QuickStateFilter } from "@/lib/worktreeFilters";
import { CheckCircle2 } from "lucide-react";
import { HollowCircle, SpinnerCircle } from "@/components/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { STATE_COLORS } from "./terminalStateConfig";

/**
 * "Attention", not "Waiting", for the bucket that filters on a waiting agent.
 *
 * `agentState === "waiting"` covers an agent stopped on an error as well as one
 * asking a question, so this bucket has always been wider than the word — and
 * Pilot's matching segment, which can tell the two apart, ended up drawing an
 * errored run's glyph beside it. "Attention" is what both members want — a
 * look — without claiming anything about why, which is the only thing true of
 * an errored run and a polite question at once. Renamed on both surfaces at
 * once rather than on one: `PILOT_BAND_FILTER_LABEL` carries the same string,
 * and one bucket with two names across two surfaces is a vocabulary to learn
 * twice.
 *
 * The worktree filter popover's session checkbox keeps "Waiting", because there
 * it sits beside "Completed" and "Exited" as one state among states rather than
 * as a bucket over them.
 */
const FILTER_OPTIONS: { value: QuickStateFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "working", label: "Working" },
  { value: "waiting", label: "Attention" },
  { value: "finished", label: "Finished" },
];

const FILTER_VISUALS: Record<
  Exclude<QuickStateFilter, "all">,
  { Icon: React.ComponentType<{ className?: string }>; color: string; colorFaded: string }
> = {
  // colorFaded must stay a complete class literal — Tailwind's scanner can't
  // see dynamically assembled `${color}/40` strings.
  working: {
    Icon: SpinnerCircle,
    color: STATE_COLORS.working,
    colorFaded: "text-state-working/40",
  },
  waiting: { Icon: HollowCircle, color: STATE_COLORS.waiting, colorFaded: "text-state-waiting/40" },
  finished: {
    Icon: CheckCircle2,
    color: "text-category-blue",
    colorFaded: "text-category-blue/40",
  },
};

interface QuickStateFilterBarProps {
  value: QuickStateFilter;
  onChange: (value: QuickStateFilter) => void;
  counts?: Record<QuickStateFilter, number>;
  /**
   * Optional affordance pinned to the trailing edge of the filter row, past a
   * divider — currently the compact "arm matching terminals" icon button. Kept
   * as an opaque slot so this stays a pure presentational component.
   */
  trailing?: React.ReactNode;
}

export function QuickStateFilterBar({
  value,
  onChange,
  counts,
  trailing,
}: QuickStateFilterBarProps) {
  const workingActive = counts !== undefined && counts.working > 0;
  // This row already claimed `role="toolbar"` without implementing any of it,
  // which is worse than no role at all: it promises a screen-reader user one
  // tab stop with arrow navigation and delivered five separate tab stops and
  // dead arrow keys. The shared hook supplies the behaviour the role advertises.
  const toolbarRef = useRef<HTMLDivElement>(null);
  const handleToolbarKeyDown = useToolbarRoving(toolbarRef);
  return (
    <div
      ref={toolbarRef}
      onKeyDown={handleToolbarKeyDown}
      className="flex border-b border-border-default"
      role="toolbar"
      aria-label="Quick state filter"
    >
      {FILTER_OPTIONS.map((option, idx) => {
        const isActive = option.value === value;
        const rawCount = counts ? counts[option.value] : undefined;
        const hasCount = rawCount !== undefined;
        // An empty bucket keeps its icon and "0" digit but mutes the icon so
        // the zero registers at a glance; no counts at all means no fade.
        const shouldFadeIcon = hasCount && rawCount === 0;
        const visual = option.value === "all" ? null : FILTER_VISUALS[option.value];
        const isSpinningWorking = option.value === "working" && workingActive;
        const Icon = isSpinningWorking ? SpinnerCircle : visual?.Icon;
        // The status icon + count carry the meaning now that the text label is
        // gone; the name lives in the accessible name and the hover tooltip.
        const noun = rawCount === 1 ? "worktree" : "worktrees";
        const accessibleName = hasCount ? `${option.label}, ${rawCount} ${noun}` : option.label;
        return (
          <Tooltip key={option.value}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-pressed={isActive}
                aria-label={accessibleName}
                onClick={() => onChange(isActive ? "all" : option.value)}
                className={cn(
                  "inline-flex items-center justify-center gap-1 min-w-0 px-2 py-1.5 transition-colors",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary",
                  // "All" is the only labelled segment and always carries the
                  // total — give it the lion's share; the icon-only status
                  // segments split the rest equally.
                  option.value === "all" ? "flex-[2]" : "flex-1",
                  idx > 0 && "border-l border-border-default",
                  isActive
                    ? // Fallback keeps themes without the var byte-identical.
                      "bg-[var(--worktree-quick-state-active-bg,var(--color-overlay-subtle))] shadow-[inset_0_-2px_0_0_var(--color-text-secondary)]"
                    : "hover:bg-tint/[0.04]"
                )}
              >
                {Icon && visual ? (
                  <Icon
                    className={cn(
                      "w-3 h-3 shrink-0 transition-colors",
                      shouldFadeIcon ? visual.colorFaded : visual.color,
                      isSpinningWorking && "animate-spin-slow motion-reduce:animate-none"
                    )}
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "text-xs",
                      isActive ? "font-medium text-text-primary" : "text-text-secondary"
                    )}
                  >
                    All
                  </span>
                )}
                {hasCount && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "text-xs tabular-nums",
                      isActive ? "text-text-primary" : "text-text-secondary"
                    )}
                  >
                    {rawCount}
                  </span>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{option.label}</TooltipContent>
          </Tooltip>
        );
      })}
      {trailing && <div className="flex shrink-0 border-l border-border-default">{trailing}</div>}
    </div>
  );
}
