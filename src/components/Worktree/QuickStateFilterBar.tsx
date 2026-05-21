import { cn } from "@/lib/utils";
import type { QuickStateFilter } from "@/lib/worktreeFilters";
import { HollowCircle, SpinnerCircle } from "@/components/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { STATE_COLORS } from "./terminalStateConfig";

const FILTER_OPTIONS: { value: QuickStateFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "working", label: "Working" },
  { value: "waiting", label: "Waiting" },
  { value: "finished", label: "Finished" },
];

const FILTER_VISUALS: Record<
  Exclude<QuickStateFilter, "all">,
  { Icon: React.ComponentType<{ className?: string }>; color: string }
> = {
  working: { Icon: HollowCircle, color: STATE_COLORS.working },
  waiting: { Icon: HollowCircle, color: STATE_COLORS.waiting },
  finished: { Icon: HollowCircle, color: "text-category-blue" },
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
  return (
    <div
      className="flex border-b border-border-default"
      role="toolbar"
      aria-label="Quick state filter"
    >
      {FILTER_OPTIONS.map((option, idx) => {
        const isActive = option.value === value;
        const rawCount = counts ? counts[option.value] : undefined;
        const hasCount = rawCount !== undefined;
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
                  "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-daintree-accent",
                  // "All" is the only labelled segment and always carries the
                  // total — give it the lion's share; the icon-only status
                  // segments split the rest equally.
                  option.value === "all" ? "flex-[2]" : "flex-1",
                  idx > 0 && "border-l border-border-default",
                  isActive
                    ? "bg-overlay-subtle shadow-[inset_0_-2px_0_0_var(--color-text-secondary)]"
                    : "hover:bg-tint/[0.04]"
                )}
              >
                {Icon && visual ? (
                  <Icon
                    className={cn(
                      "w-3 h-3 shrink-0",
                      visual.color,
                      isSpinningWorking && "animate-spin-slow motion-reduce:animate-none"
                    )}
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "text-xs",
                      isActive ? "font-medium text-daintree-text" : "text-daintree-text/60"
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
                      isActive ? "text-daintree-text" : "text-daintree-text/50"
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
