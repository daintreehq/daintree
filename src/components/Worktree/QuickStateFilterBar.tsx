import { cn } from "@/lib/utils";
import type { QuickStateFilter } from "@/lib/worktreeFilters";

const FILTER_OPTIONS: { value: QuickStateFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "working", label: "Working" },
  { value: "waiting", label: "Waiting" },
  { value: "finished", label: "Finished" },
];

interface QuickStateFilterBarProps {
  value: QuickStateFilter;
  onChange: (value: QuickStateFilter) => void;
  counts?: Record<"working" | "waiting" | "finished", number>;
}

export function QuickStateFilterBar({ value, onChange, counts }: QuickStateFilterBarProps) {
  return (
    <div
      className="flex items-center gap-1 px-4 py-1.5 border-b border-border-default"
      role="toolbar"
      aria-label="Quick state filter"
    >
      {FILTER_OPTIONS.map((option) => {
        const isActive = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={isActive}
            onClick={() => onChange(isActive ? "all" : option.value)}
            className={cn(
              "inline-flex items-center px-2 py-0.5 text-[11px] rounded-full transition-colors",
              isActive
                ? "bg-tint/[0.12] text-daintree-text font-medium"
                : "text-daintree-text/50 hover:text-daintree-text/70 hover:bg-tint/[0.04]"
            )}
          >
            {option.label}
            {counts && option.value !== "all" && ` (${counts[option.value]})`}
          </button>
        );
      })}
    </div>
  );
}
