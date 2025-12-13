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
  "bg-[var(--color-surface-highlight)]",
  "bg-emerald-700/50",
  "bg-emerald-600/60",
  "bg-emerald-500/70",
  "bg-emerald-400/80",
] as const;

const BEFORE_PROJECT_COLOR = "bg-canopy-bg";
const MISSED_DAY_COLOR = "bg-[color-mix(in_oklab,var(--color-status-error)_20%,transparent)]";

const COLUMNS_PER_ROW = 60;
const CELL_SIZE_PX = 10;
const GAP_PX = 3;

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

  const cellSize = compact ? 6 : CELL_SIZE_PX;
  const gap = compact ? 2 : GAP_PX;

  // Calculate exact width: (cellSize * columns) + (gap * (columns - 1))
  const rowWidth = cellSize * COLUMNS_PER_ROW + gap * (COLUMNS_PER_ROW - 1);

  return (
    <TooltipProvider delayDuration={0} skipDelayDuration={0}>
      <div
        className="flex flex-col"
        style={{ gap: `${gap}px`, width: `${rowWidth}px` }}
        role="img"
        aria-label={`Activity over the last ${rangeDays} days`}
      >
        {rows.map((row, rowIndex) => (
          <div key={rowIndex} className="flex" style={{ gap: `${gap}px` }}>
            {row.map((cell) => {
              // Determine the appropriate color class
              let colorClass: string;
              if (cell.isBeforeProject) {
                colorClass = BEFORE_PROJECT_COLOR;
              } else if (cell.count === 0) {
                colorClass = MISSED_DAY_COLOR;
              } else {
                colorClass = HEAT_COLORS[cell.level];
              }

              const date = new Date(cell.date);
              const formatted = date.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              });

              const tooltipText = cell.isBeforeProject
                ? "Before project started"
                : `${cell.count} commit${cell.count !== 1 ? "s" : ""}`;

              return (
                <Tooltip key={cell.date} delayDuration={0}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      style={{ width: `${cellSize}px`, height: `${cellSize}px` }}
                      className={cn(
                        colorClass,
                        "rounded-full shrink-0 transition-[transform,background-color] duration-150 border-0 p-0 cursor-default",
                        cell.isToday && "ring-1 ring-canopy-accent/40",
                        cell.isMostRecentActive && !cell.isToday && "ring-1 ring-emerald-400/40"
                      )}
                      aria-label={`${formatted}: ${tooltipText}`}
                      tabIndex={0}
                    />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    <span className="font-medium">{formatted}</span>
                    <span className="text-canopy-text/60 ml-1">{tooltipText}</span>
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
