import { useMemo } from "react";
import type { HeatCell, PulseRangeDays } from "@shared/types";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "../ui/tooltip";

interface PulseHeatmapProps {
  cells: HeatCell[];
  rangeDays: PulseRangeDays;
  compact?: boolean;
}

const HEAT_COLORS = [
  "bg-white/[0.04]",
  "bg-emerald-700/50",
  "bg-emerald-600/60",
  "bg-emerald-500/70",
  "bg-emerald-400/80",
] as const;

const COLUMNS_PER_ROW = 60;

export function PulseHeatmap({ cells, rangeDays, compact = false }: PulseHeatmapProps) {
  const rows = useMemo(() => {
    const sortedCells = [...cells]
      .filter((cell) => {
        const date = new Date(cell.date);
        return !isNaN(date.getTime());
      })
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      .map((cell) => ({
        ...cell,
        level: Math.max(0, Math.min(4, cell.level)) as HeatCell["level"],
      }));

    // Split cells into rows of 60
    const result: HeatCell[][] = [];
    for (let i = 0; i < sortedCells.length; i += COLUMNS_PER_ROW) {
      result.push(sortedCells.slice(i, i + COLUMNS_PER_ROW));
    }

    return result;
  }, [cells]);

  const cellSize = compact ? "w-2 h-2" : "w-2.5 h-2.5";
  const gap = compact ? "gap-[2px]" : "gap-[3px]";

  return (
    <TooltipProvider>
      <div
        className={cn("flex flex-col", gap)}
        role="img"
        aria-label={`Activity over the last ${rangeDays} days`}
      >
        {rows.map((row, rowIndex) => (
          <div key={rowIndex} className={cn("flex", gap)}>
            {row.map((cell) => {
              const colorClass = HEAT_COLORS[cell.level];
              const date = new Date(cell.date);
              const formatted = date.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              });

              return (
                <Tooltip key={cell.date} delayDuration={150}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        cellSize,
                        colorClass,
                        "rounded-[var(--radius-xs)] transition-all border-0 p-0 cursor-default",
                        cell.isToday && "ring-1 ring-white/30",
                        cell.isMostRecentActive && !cell.isToday && "ring-1 ring-emerald-400/40"
                      )}
                      aria-label={`${formatted}: ${cell.count} commit${cell.count !== 1 ? "s" : ""}`}
                      tabIndex={0}
                    />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    <span className="font-medium">{formatted}</span>
                    <span className="text-canopy-text/60 ml-1">
                      {cell.count} commit{cell.count !== 1 ? "s" : ""}
                    </span>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        ))}
      </div>
    </TooltipProvider>
  );
}
