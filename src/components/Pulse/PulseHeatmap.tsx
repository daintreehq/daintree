import { useMemo } from "react";
import type { CSSProperties } from "react";
import type { HeatCell, PulseRangeDays } from "@shared/types";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

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
    if (cells[i]!.count > 0) {
      hasRecentActivityBefore = true;
      break;
    }
  }

  if (!hasRecentActivityBefore) {
    return false;
  }

  for (let i = index + 1; i <= Math.min(cells.length - 1, index + MISSED_DAY_WINDOW); i += 1) {
    if (cells[i]!.count > 0) {
      return true;
    }
  }

  return false;
}

function getHeatCellBackground(level: HeatCell["level"]): string {
  const baseColor = "var(--pulse-heat-color, var(--color-state-working))";

  if (level === 4) {
    return baseColor;
  }

  const opacityVar =
    level === 3
      ? "var(--pulse-heat-high-opacity, 0.55)"
      : level === 2
        ? "var(--pulse-heat-medium-opacity, 0.35)"
        : "var(--pulse-heat-low-opacity, 0.18)";

  return `color-mix(in oklab, ${baseColor} calc(${opacityVar} * 100%), transparent)`;
}

function getCellStyle(cell: RenderCell): CSSProperties {
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
      .filter((cell) => !cell.isBeforeProject)
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
    const firstRowSize = normalizedCells.length % columnsPerRow || columnsPerRow;

    if (normalizedCells.length > 0) {
      result.push(normalizedCells.slice(0, firstRowSize));
      for (let i = firstRowSize; i < normalizedCells.length; i += columnsPerRow) {
        result.push(normalizedCells.slice(i, i + columnsPerRow));
      }
    }

    return result;
  }, [cells, compact]);

  const cellSize = compact ? COMPACT_CELL_SIZE_PX : CELL_SIZE_PX;
  const gap = compact ? COMPACT_GAP_PX : GAP_PX;
  const totalCells = rows.reduce((sum, r) => sum + r.length, 0);
  const columns = compact ? Math.min(COLUMNS_PER_ROW, totalCells) : COLUMNS_PER_ROW;
  const rowWidth = columns > 0 ? cellSize * columns + gap * (columns - 1) : 0;

  return (
    <div
      className="flex flex-col"
      style={{ gap: `${gap}px`, width: `${rowWidth}px` }}
      role="group"
      aria-label={`Activity over the last ${rangeDays} days`}
      data-testid="pulse-heatmap"
    >
      {rows.map((row, rowIndex) => (
        <div
          key={rowIndex}
          className={cn(
            "flex",
            rowIndex === 0 && rows.length > 1 && row.length < columns && "justify-end"
          )}
          style={{ gap: `${gap}px` }}
        >
          {row.map((cell) => {
            const date = new Date(cell.date);
            const formatted = date.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            });

            const ringStyle = (
              cell.isMostRecentActive
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
                      cell.isMostRecentActive && "ring-1 ring-daintree-accent/45 ring-offset-1"
                    )}
                    aria-label={`${formatted}: ${getTooltipText(cell)}`}
                    tabIndex={0}
                  />
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  <span className="font-medium">{formatted}</span>
                  <span className="ml-1 text-daintree-text/60">{getTooltipText(cell)}</span>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      ))}
    </div>
  );
}
