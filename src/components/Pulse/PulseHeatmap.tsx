import { useMemo } from "react";
import type { CSSProperties } from "react";
import type { HeatCell, PulseRangeDays } from "@shared/types";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";

interface PulseHeatmapProps {
  cells: HeatCell[];
  rangeDays: PulseRangeDays;
  compact?: boolean;
}

interface RenderCell extends HeatCell {
  isMissedDay: boolean;
}

const COLUMNS_PER_ROW = 60;
const CELL_SIZE_PX = 10;
const GAP_PX = 3;
const COMPACT_CELL_SIZE_PX = 6;
const COMPACT_GAP_PX = 2;
const MISSED_DAY_WINDOW = 4;

function isMissedDay(cells: HeatCell[], index: number): boolean {
  const cell = cells[index];
  if (!cell || cell.count > 0 || cell.isBeforeProject || cell.isToday) {
    return false;
  }

  let hasRecentActivityBefore = false;
  for (let i = Math.max(0, index - MISSED_DAY_WINDOW); i < index; i += 1) {
    if (cells[i].count > 0) {
      hasRecentActivityBefore = true;
      break;
    }
  }

  if (!hasRecentActivityBefore) {
    return false;
  }

  for (let i = index + 1; i <= Math.min(cells.length - 1, index + MISSED_DAY_WINDOW); i += 1) {
    if (cells[i].count > 0) {
      return true;
    }
  }

  return false;
}

function getHeatCellBackground(level: HeatCell["level"]): string {
  if (level === 4) {
    return "var(--color-state-working)";
  }

  const opacityVar =
    level === 3
      ? "var(--pulse-heat-high-opacity, 0.55)"
      : level === 2
        ? "var(--pulse-heat-medium-opacity, 0.35)"
        : "var(--pulse-heat-low-opacity, 0.18)";

  return `color-mix(in oklab, var(--color-state-working) calc(${opacityVar} * 100%), transparent)`;
}

function getCellStyle(cell: RenderCell): CSSProperties {
  if (cell.isBeforeProject) {
    return { background: "var(--pulse-before-bg, var(--theme-surface-sidebar))" };
  }

  if (cell.isMissedDay) {
    return { background: "var(--pulse-missed-bg)" };
  }

  if (cell.count === 0) {
    return { background: "var(--pulse-empty-bg, var(--theme-surface-panel))" };
  }

  return {
    background: getHeatCellBackground(cell.level),
  };
}

function getTooltipText(cell: RenderCell): string {
  if (cell.isBeforeProject) {
    return "Before project started";
  }

  if (cell.isMissedDay) {
    return "Missed day";
  }

  if (cell.count === 0) {
    return "No commits";
  }

  return `${cell.count} commit${cell.count !== 1 ? "s" : ""}`;
}

export function PulseHeatmap({ cells, rangeDays, compact = false }: PulseHeatmapProps) {
  const rows = useMemo(() => {
    const normalizedCells = [...cells]
      .filter((cell) => !Number.isNaN(new Date(cell.date).getTime()))
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      .map((cell, index, allCells) => ({
        ...cell,
        level: Math.max(0, Math.min(4, cell.level)) as HeatCell["level"],
        isMissedDay: isMissedDay(allCells, index),
      }));

    const columnsPerRow = compact
      ? Math.min(COLUMNS_PER_ROW, normalizedCells.length)
      : COLUMNS_PER_ROW;
    const result: RenderCell[][] = [];

    for (let i = 0; i < normalizedCells.length; i += columnsPerRow) {
      result.push(normalizedCells.slice(i, i + columnsPerRow));
    }

    return result;
  }, [cells, compact]);

  const cellSize = compact ? COMPACT_CELL_SIZE_PX : CELL_SIZE_PX;
  const gap = compact ? COMPACT_GAP_PX : GAP_PX;
  const columns = compact ? Math.min(COLUMNS_PER_ROW, cells.length) : COLUMNS_PER_ROW;
  const rowWidth = columns > 0 ? cellSize * columns + gap * (columns - 1) : 0;

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
              const date = new Date(cell.date);
              const formatted = date.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              });

              const ringStyle = (
                cell.isToday || cell.isMostRecentActive
                  ? { "--tw-ring-offset-color": "var(--pulse-ring-offset, var(--pulse-card-bg))" }
                  : {}
              ) as CSSProperties;

              return (
                <Tooltip key={cell.date} delayDuration={0}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      style={{
                        width: `${cellSize}px`,
                        height: `${cellSize}px`,
                        ...getCellStyle(cell),
                        ...ringStyle,
                      }}
                      className={cn(
                        "rounded-[2px] shrink-0 border-0 p-0 cursor-default transition-[transform,background-color,box-shadow] duration-150",
                        cell.isToday && "ring-2 ring-canopy-accent ring-offset-1",
                        cell.isMostRecentActive &&
                          !cell.isToday &&
                          "ring-1 ring-canopy-accent/45 ring-offset-1"
                      )}
                      aria-label={`${formatted}: ${getTooltipText(cell)}`}
                      tabIndex={0}
                    />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    <span className="font-medium">{formatted}</span>
                    <span className="ml-1 text-canopy-text/60">{getTooltipText(cell)}</span>
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
