import { useEffect, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import type { PulseRangeDays, ProjectPulse } from "@shared/types";
import { usePulseStore, useProjectStore } from "@/store";
import { cn } from "@/lib/utils";
import { Loader2, AlertCircle, RefreshCw, Activity, GitBranch } from "lucide-react";
import { PulseHeatmap } from "./PulseHeatmap";
import { PulseSummary } from "./PulseSummary";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

interface ProjectPulseCardProps {
  worktreeId: string;
  className?: string;
}

const RANGE_OPTIONS: { value: PulseRangeDays; label: string }[] = [
  { value: 60, label: "60 days" },
  { value: 120, label: "120 days" },
  { value: 180, label: "180 days" },
];

function getCoachLine(pulse: ProjectPulse): string {
  const sortedCells = [...pulse.heatmap]
    .filter((cell) => !isNaN(new Date(cell.date).getTime()))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const today = sortedCells.find((c) => c.isToday) ?? sortedCells.at(-1);

  const last7Days = sortedCells.slice(-7).filter((c) => c.count > 0).length;

  if (today && today.count > 0) {
    return "Nice — progress logged today.";
  }
  if (pulse.currentStreakDays && pulse.currentStreakDays > 0) {
    return "One small commit today keeps your streak going.";
  }
  if (last7Days > 0) {
    return `Momentum's building: ${last7Days} active day${last7Days !== 1 ? "s" : ""} this week.`;
  }
  return "Make a tiny win: ship one small change today.";
}

const MAX_RETRIES = 3;

export function ProjectPulseCard({ worktreeId, className }: ProjectPulseCardProps) {
  const projectName = useProjectStore((s) => s.currentProject?.name);
  const { pulse, isLoading, error, rangeDays, retryCount, fetchPulse, setRangeDays } =
    usePulseStore(
      useShallow((state) => ({
        pulse: state.getPulse(worktreeId),
        isLoading: state.isLoading(worktreeId),
        error: state.getError(worktreeId),
        rangeDays: state.rangeDays,
        retryCount: state.getRetryCount(worktreeId),
        fetchPulse: state.fetchPulse,
        setRangeDays: state.setRangeDays,
      }))
    );

  const title = projectName ? `${projectName} Project Pulse` : "Project Pulse";

  useEffect(() => {
    if (!pulse && !isLoading && !error) {
      fetchPulse(worktreeId);
    }
  }, [worktreeId, pulse, isLoading, error, fetchPulse]);

  const handleRefresh = useCallback(() => {
    fetchPulse(worktreeId, true);
  }, [worktreeId, fetchPulse]);

  const handleRangeChange = useCallback(
    (days: PulseRangeDays) => {
      setRangeDays(days);
      fetchPulse(worktreeId);
    },
    [setRangeDays, fetchPulse, worktreeId]
  );

  const currentRangeLabel =
    RANGE_OPTIONS.find((o) => o.value === rangeDays)?.label ?? `${rangeDays} days`;

  if (isLoading && !pulse) {
    return (
      <div
        className={cn(
          "p-4 bg-[var(--color-surface)] rounded-[var(--radius-lg)] border border-canopy-border",
          className
        )}
      >
        <div
          className="flex items-center gap-2 text-canopy-text/50"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
          <span className="text-xs">Loading activity data...</span>
        </div>
      </div>
    );
  }

  if (!pulse && error === null) {
    return (
      <div
        className={cn(
          "p-4 bg-[var(--color-surface)] rounded-[var(--radius-lg)] border border-canopy-border",
          className
        )}
      >
        <div className="flex items-center gap-2 text-canopy-text/50">
          <GitBranch className="w-4 h-4 text-blue-400/70" aria-hidden="true" />
          <span className="text-xs">
            New repository — make your first commit to start tracking activity
          </span>
        </div>
      </div>
    );
  }

  if (error && !pulse) {
    const isRetrying = retryCount > 0 && retryCount < MAX_RETRIES;

    return (
      <div
        className={cn(
          "p-4 bg-[var(--color-surface)] rounded-[var(--radius-lg)] border border-canopy-border",
          className
        )}
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-canopy-text/50" role="alert">
            <AlertCircle className="w-4 h-4 text-canopy-error/70" aria-hidden="true" />
            <span className="text-xs">{error}</span>
            <button
              onClick={handleRefresh}
              className="ml-auto p-1 hover:bg-[var(--color-surface-highlight)] rounded transition-colors"
              aria-label="Retry now"
            >
              <RefreshCw className="w-3 h-3" aria-hidden="true" />
            </button>
          </div>
          {isRetrying && (
            <div
              className="flex items-center gap-2 text-canopy-text/40"
              role="status"
              aria-live="polite"
            >
              <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
              <span className="text-xs">
                Retrying ({retryCount}/{MAX_RETRIES})...
              </span>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!pulse) {
    return null;
  }

  return (
    <div
      className={cn(
        "w-fit bg-[var(--color-surface)] rounded-[var(--radius-lg)] border border-canopy-border",
        className
      )}
    >
      <div className="px-4 py-3 border-b border-canopy-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-emerald-400/70" />
          <span className="text-sm font-medium text-canopy-text/80">{title}</span>
          {isLoading && <Loader2 className="w-3 h-3 animate-spin text-canopy-text/40" />}
        </div>

        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="text-xs text-canopy-text/50 hover:text-canopy-text/70 transition-colors px-2 py-1 rounded hover:bg-[var(--color-surface-highlight)]"
                aria-label="Change time range"
              >
                {currentRangeLabel}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {RANGE_OPTIONS.map((option) => (
                <DropdownMenuItem
                  key={option.value}
                  onClick={() => handleRangeChange(option.value)}
                  className={cn(
                    option.value === rangeDays && "bg-[var(--color-surface-highlight)]"
                  )}
                >
                  {option.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <button
            onClick={handleRefresh}
            disabled={isLoading}
            className="p-1 text-canopy-text/40 hover:text-canopy-text/70 hover:bg-[var(--color-surface-highlight)] rounded transition-colors disabled:opacity-50"
            aria-label="Refresh"
          >
            <RefreshCw className={cn("w-3 h-3", isLoading && "animate-spin")} />
          </button>
        </div>
      </div>

      <div className="p-4 space-y-4">
        <PulseHeatmap cells={pulse.heatmap} rangeDays={pulse.rangeDays} />

        <p className="text-xs text-canopy-text/60 italic">{getCoachLine(pulse)}</p>

        <div className="border-t border-canopy-border pt-3">
          <PulseSummary pulse={pulse} />
        </div>
      </div>
    </div>
  );
}
