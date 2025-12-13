import { useEffect, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import type { PulseRangeDays, ProjectPulse } from "@shared/types";
import { usePulseStore, useProjectStore } from "@/store";
import { cn } from "@/lib/utils";
import { Loader2, AlertCircle, RefreshCw, Activity } from "lucide-react";
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

export function ProjectPulseCard({ worktreeId, className }: ProjectPulseCardProps) {
  const projectName = useProjectStore((s) => s.currentProject?.name);
  const { pulse, isLoading, error, rangeDays, fetchPulse, setRangeDays } = usePulseStore(
    useShallow((state) => ({
      pulse: state.getPulse(worktreeId),
      isLoading: state.isLoading(worktreeId),
      error: state.getError(worktreeId),
      rangeDays: state.rangeDays,
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
      <div className={cn("p-4 bg-white/[0.02] rounded-lg border border-white/5", className)}>
        <div className="flex items-center gap-2 text-canopy-text/50">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-xs">Loading activity data...</span>
        </div>
      </div>
    );
  }

  if (error && !pulse) {
    return (
      <div className={cn("p-4 bg-white/[0.02] rounded-lg border border-white/5", className)}>
        <div className="flex items-center gap-2 text-canopy-text/50">
          <AlertCircle className="w-4 h-4 text-red-400/70" />
          <span className="text-xs">{error}</span>
          <button
            onClick={handleRefresh}
            className="ml-auto p-1 hover:bg-white/10 rounded transition-colors"
            aria-label="Retry"
          >
            <RefreshCw className="w-3 h-3" />
          </button>
        </div>
      </div>
    );
  }

  if (!pulse) {
    return null;
  }

  return (
    <div className={cn("bg-white/[0.02] rounded-lg border border-white/5", className)}>
      <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-emerald-400/70" />
          <span className="text-sm font-medium text-canopy-text/80">{title}</span>
          {isLoading && <Loader2 className="w-3 h-3 animate-spin text-canopy-text/40" />}
        </div>

        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="text-xs text-canopy-text/50 hover:text-canopy-text/70 transition-colors px-2 py-1 rounded hover:bg-white/5"
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
                  className={cn(option.value === rangeDays && "bg-white/5")}
                >
                  {option.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <button
            onClick={handleRefresh}
            disabled={isLoading}
            className="p-1 text-canopy-text/40 hover:text-canopy-text/70 hover:bg-white/5 rounded transition-colors disabled:opacity-50"
            aria-label="Refresh"
          >
            <RefreshCw className={cn("w-3 h-3", isLoading && "animate-spin")} />
          </button>
        </div>
      </div>

      <div className="p-4 space-y-4">
        <PulseHeatmap cells={pulse.heatmap} rangeDays={pulse.rangeDays} />

        <p className="text-xs text-canopy-text/60 italic">{getCoachLine(pulse)}</p>

        <div className="border-t border-white/5 pt-3">
          <PulseSummary pulse={pulse} />
        </div>
      </div>
    </div>
  );
}
