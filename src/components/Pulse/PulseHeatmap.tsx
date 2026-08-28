import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import type { HeatCell, PulseRangeDays } from "@shared/types";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

interface PulseHeatmapProps {
  cells: HeatCell[];
  rangeDays: PulseRangeDays;
  compact?: boolean;
  describedBy?: string;
}

export function getPulseHeatmapRowWidth({
  dayCount,
  compact,
}: {
  dayCount: number;
  compact: boolean;
}): number {
  const columns = compact ? Math.min(COLUMNS_PER_ROW, dayCount) : COLUMNS_PER_ROW;
  const cellSize = compact ? COMPACT_CELL_SIZE_PX : CELL_SIZE_PX;
  const gap = compact ? COMPACT_GAP_PX : GAP_PX;
  return columns > 0 ? cellSize * columns + gap * (columns - 1) : 0;
}

const COLUMNS_PER_ROW = 60;
const CELL_SIZE_PX = 10;
const GAP_PX = 3;
const COMPACT_CELL_SIZE_PX = 6;
const COMPACT_GAP_PX = 2;

// Per-theme opaque heat stops (pulse-heat-1..4) step in both lightness and
// chroma (GitHub light-contributions model) rather than one hue at four alphas
// — an alpha ramp over the empty cell left level-1 sub-JND and washed light
// themes out. Each stop falls back to the legacy hue@alpha composite so the map
// degrades gracefully on themes that haven't authored opaque stops yet.
function legacyHeatComposite(level: 1 | 2 | 3 | 4): string {
  const baseColor = "var(--pulse-heat-color, var(--color-state-working))";
  if (level === 4) return baseColor;
  const opacityVar =
    level === 3
      ? "var(--pulse-heat-high-opacity, 0.55)"
      : level === 2
        ? "var(--pulse-heat-medium-opacity, 0.35)"
        : "var(--pulse-heat-low-opacity, 0.18)";
  return `color-mix(in oklab, ${baseColor} calc(${opacityVar} * 100%), transparent)`;
}

function getHeatCellBackground(level: HeatCell["level"]): string {
  // Static per-level references (not a template literal) so the
  // EXTENSION_KEYS drift scanner registers each opaque stop (pulse-heat-1..4)
  // as a consumer.
  switch (Math.max(1, Math.min(4, level))) {
    case 4:
      return `var(--pulse-heat-4, ${legacyHeatComposite(4)})`;
    case 3:
      return `var(--pulse-heat-3, ${legacyHeatComposite(3)})`;
    case 2:
      return `var(--pulse-heat-2, ${legacyHeatComposite(2)})`;
    default:
      return `var(--pulse-heat-1, ${legacyHeatComposite(1)})`;
  }
}

const EMPTY_CELL_BACKGROUND = "var(--pulse-empty-bg, var(--theme-surface-panel))";

// Single source of truth for a heat level's fill, shared by the rendered cells
// and the legend swatches. Level 0 is the empty (no-commits) cell. Routing the
// legend through this guarantees its swatches span the same opacity ramp the
// cells use — otherwise a theme that omits the opaque pulse-heat-1..4 stops
// renders graduated cells but a flat, full-strength legend (levels 1-3 would
// fall back to the un-mixed base colour), so "Less → More" wouldn't cover the
// actual range on screen.
export function getPulseHeatLevelBackground(level: 0 | 1 | 2 | 3 | 4): string {
  return level === 0 ? EMPTY_CELL_BACKGROUND : getHeatCellBackground(level);
}

// A day with no commits is just quiet — every zero cell reads the same,
// whatever its neighbours did. The heatmap has no way to express failure.
function getCellStyle(cell: HeatCell): CSSProperties {
  if (cell.count === 0) {
    return { background: EMPTY_CELL_BACKGROUND };
  }

  return {
    background: getHeatCellBackground(cell.level),
  };
}

function getTooltipText(cell: HeatCell): string {
  if (cell.count === 0) {
    return "No commits";
  }

  return `${cell.count} commit${cell.count !== 1 ? "s" : ""}`;
}

function PulseHeatmapCell({
  cell,
  cellSize,
  isActive,
  onCellRef,
}: {
  cell: HeatCell;
  cellSize: number;
  isActive: boolean;
  onCellRef: (date: string, el: HTMLButtonElement | null) => void;
}) {
  const cellRef = useCallback(
    (el: HTMLButtonElement | null) => {
      onCellRef(cell.date, el);
    },
    [cell.date, onCellRef]
  );
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
    // 0ms: dense scrub-hover surface — skip-delay alone doesn't cover the cold first-cell hover (mirrors GitHub contribution-heatmap)
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <button
          ref={cellRef}
          type="button"
          role="gridcell"
          data-cell-date={cell.date}
          // Clamp to >=1 for the CSS-level cue so a future renderer that emits
          // a positive-count cell with level: 0 doesn't render a 0-sized
          // CanvasText shape under forced-colors. The data layer currently
          // never produces this combination, but the input type permits it.
          data-heat-level={cell.count > 0 && cell.level > 0 ? Math.min(4, cell.level) : undefined}
          style={{
            width: `${cellSize}px`,
            height: `${cellSize}px`,
            ...getCellStyle(cell),
            ...ringStyle,
          }}
          className={cn(
            "pulse-heat-cell relative overflow-hidden rounded-[2px] shrink-0 border-0 p-0 cursor-default transition-[transform,background-color,box-shadow] duration-150",
            cell.isMostRecentActive && "ring-1 ring-daintree-text/25 ring-offset-1"
          )}
          aria-label={`${formatted}: ${getTooltipText(cell)}`}
          tabIndex={isActive ? 0 : -1}
        >
          {cell.count > 0 && <span aria-hidden="true" className="pulse-heat-cell-shape" />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        <span className="font-medium">{formatted}</span>
        <span className="ml-1 text-text-secondary">{getTooltipText(cell)}</span>
      </TooltipContent>
    </Tooltip>
  );
}

export function PulseHeatmap({
  cells,
  rangeDays,
  compact = false,
  describedBy,
}: PulseHeatmapProps) {
  const rows = useMemo(() => {
    const normalizedCells = [...cells]
      .filter((cell) => !Number.isNaN(new Date(cell.date).getTime()))
      .filter((cell) => !cell.isBeforeProject)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      .map((cell) => ({
        ...cell,
        level: Math.max(0, Math.min(4, cell.level)) as HeatCell["level"],
      }));

    const columnsPerRow = compact
      ? Math.min(COLUMNS_PER_ROW, normalizedCells.length)
      : COLUMNS_PER_ROW;
    const result: HeatCell[][] = [];
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
  const rowWidth = getPulseHeatmapRowWidth({ dayCount: totalCells, compact });

  const cellRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const initialFocusKey = useMemo(() => {
    for (const row of rows) {
      for (const cell of row) {
        if (cell.isMostRecentActive) return cell.date;
      }
    }
    return rows[0]?.[0]?.date ?? null;
  }, [rows]);

  // Roving tabindex: only the active cell holds tabIndex=0. Keep the active
  // key in state because JSX needs it during render.
  const [activeCellKey, setActiveCellKey] = useState<string | null>(null);
  useEffect(() => {
    const validKeys = new Set<string>();
    rows.forEach((row) => row.forEach((c) => validKeys.add(c.date)));
    cellRefs.current.forEach((_, key) => {
      if (!validKeys.has(key)) cellRefs.current.delete(key);
    });
    if (activeCellKey && !validKeys.has(activeCellKey)) {
      setActiveCellKey(null);
    }
  }, [rows, activeCellKey]);

  const focusCell = useCallback(
    (rowIndex: number, colIndex: number) => {
      const row = rows[rowIndex];
      if (!row) return;
      const target = row[colIndex];
      if (!target) return;
      const node = cellRefs.current.get(target.date);
      if (!node) return;
      cellRefs.current.forEach((el) => {
        el.tabIndex = -1;
      });
      node.tabIndex = 0;
      node.focus();
      setActiveCellKey(target.date);
    },
    [rows]
  );

  const registerCellRef = useCallback((date: string, el: HTMLButtonElement | null) => {
    if (el) cellRefs.current.set(date, el);
    else cellRefs.current.delete(date);
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      // Don't swallow Alt/Shift+Arrow combos — Alt+Arrow is browser/OS history
      // navigation on some platforms; Shift+Arrow is reserved for selection.
      if (event.altKey || event.shiftKey) return;

      const target = event.target as HTMLElement;
      const date = target.getAttribute("data-cell-date");
      if (!date) return;

      let rowIndex = -1;
      let colIndex = -1;
      for (let r = 0; r < rows.length; r += 1) {
        const row = rows[r]!;
        for (let c = 0; c < row.length; c += 1) {
          if (row[c]!.date === date) {
            rowIndex = r;
            colIndex = c;
            break;
          }
        }
        if (rowIndex !== -1) break;
      }
      if (rowIndex === -1) return;

      const lastRow = rows.length - 1;
      const lastCol = (rows[rowIndex]?.length ?? 0) - 1;

      switch (event.key) {
        case "ArrowRight": {
          event.preventDefault();
          if (colIndex < lastCol) {
            focusCell(rowIndex, colIndex + 1);
          } else if (rowIndex < lastRow) {
            focusCell(rowIndex + 1, 0);
          }
          break;
        }
        case "ArrowLeft": {
          event.preventDefault();
          if (colIndex > 0) {
            focusCell(rowIndex, colIndex - 1);
          } else if (rowIndex > 0) {
            const prevRow = rows[rowIndex - 1]!;
            focusCell(rowIndex - 1, prevRow.length - 1);
          }
          break;
        }
        case "ArrowDown": {
          event.preventDefault();
          if (rowIndex < lastRow) {
            const nextRow = rows[rowIndex + 1]!;
            focusCell(rowIndex + 1, Math.min(colIndex, nextRow.length - 1));
          }
          break;
        }
        case "ArrowUp": {
          event.preventDefault();
          if (rowIndex > 0) {
            const prevRow = rows[rowIndex - 1]!;
            focusCell(rowIndex - 1, Math.min(colIndex, prevRow.length - 1));
          }
          break;
        }
        case "Home": {
          event.preventDefault();
          if (event.ctrlKey || event.metaKey) {
            focusCell(0, 0);
          } else {
            focusCell(rowIndex, 0);
          }
          break;
        }
        case "End": {
          event.preventDefault();
          if (event.ctrlKey || event.metaKey) {
            const last = rows[lastRow];
            if (last) focusCell(lastRow, last.length - 1);
          } else {
            focusCell(rowIndex, lastCol);
          }
          break;
        }
      }
    },
    [rows, focusCell]
  );

  return (
    <div
      className="flex flex-col"
      style={{ gap: `${gap}px`, width: `${rowWidth}px` }}
      role="grid"
      aria-label={`Activity over the last ${rangeDays} days`}
      aria-describedby={describedBy}
      aria-rowcount={rows.length}
      aria-colcount={columns}
      data-testid="pulse-heatmap"
      onKeyDown={handleKeyDown}
    >
      {rows.map((row, rowIndex) => (
        <div
          key={rowIndex}
          role="row"
          className={cn(
            "flex",
            rowIndex === 0 && rows.length > 1 && row.length < columns && "justify-end"
          )}
          style={{ gap: `${gap}px` }}
        >
          {row.map((cell) => (
            <PulseHeatmapCell
              key={cell.date}
              cell={cell}
              cellSize={cellSize}
              isActive={cell.date === (activeCellKey ?? initialFocusKey)}
              onCellRef={registerCellRef}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
