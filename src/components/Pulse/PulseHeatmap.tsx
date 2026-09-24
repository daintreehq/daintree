import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import type { HeatCell, PulseRangeDays } from "@shared/types";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import {
  DAYS_PER_WEEK,
  WEEKDAY_LABELS,
  buildPulseCalendar,
  moveInCalendar,
  parseLocalDay,
  type CalendarKey,
} from "./pulseCalendar";

interface PulseHeatmapProps {
  cells: HeatCell[];
  rangeDays: PulseRangeDays;
  describedBy?: string;
}

const CELL_SIZE_PX = 10;
const GAP_PX = 3;
const PITCH_PX = CELL_SIZE_PX + GAP_PX;
const WEEKDAY_GUTTER_PX = 24;
const MONTH_ROW_PX = 14;
const TODAY_LABEL_PX = 36;

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

function getCountText(cell: HeatCell): string {
  if (cell.count === 0) {
    return "No commits";
  }

  return `${cell.count} commit${cell.count !== 1 ? "s" : ""}`;
}

function formatDay(cell: HeatCell): string {
  const day = parseLocalDay(cell.date);
  const formatted = day
    ? day.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
    : cell.date;
  return cell.isToday ? `Today, ${formatted}` : formatted;
}

function PulseHeatmapCell({
  cell,
  col,
  isActive,
  onCellRef,
}: {
  cell: HeatCell;
  col: number;
  isActive: boolean;
  onCellRef: (date: string, el: HTMLButtonElement | null) => void;
}) {
  const cellRef = useCallback(
    (el: HTMLButtonElement | null) => {
      onCellRef(cell.date, el);
    },
    [cell.date, onCellRef]
  );
  const formatted = formatDay(cell);

  const ringStyle = (
    cell.isMostRecentActive
      ? { "--tw-ring-offset-color": "var(--pulse-ring-offset, var(--pulse-card-bg))" }
      : {}
  ) as CSSProperties;

  return (
    // 0ms: dense scrub-hover surface — skip-delay alone doesn't cover the cold first-cell hover (mirrors GitHub contribution-heatmap).
    // autoDismiss off: this tooltip is the only place a day's date and count
    // are shown, so it stays while the cell is hovered or focused rather than
    // vanishing mid-read after the app-wide hint window.
    <Tooltip delayDuration={0} autoDismiss={false}>
      <TooltipTrigger asChild>
        <button
          ref={cellRef}
          type="button"
          role="gridcell"
          aria-colindex={col + 1}
          data-cell-date={cell.date}
          // Forced colors strips the ring's box-shadow; this hook lets that
          // mode redraw the latest-active marker as an outline.
          data-latest-active={cell.isMostRecentActive ? "" : undefined}
          // Clamp to >=1 for the CSS-level cue so a future renderer that emits
          // a positive-count cell with level: 0 doesn't render a 0-sized
          // CanvasText shape under forced-colors. The data layer currently
          // never produces this combination, but the input type permits it.
          data-heat-level={cell.count > 0 && cell.level > 0 ? Math.min(4, cell.level) : undefined}
          style={{
            width: `${CELL_SIZE_PX}px`,
            height: `${CELL_SIZE_PX}px`,
            ...getCellStyle(cell),
            ...ringStyle,
          }}
          className={cn(
            "pulse-heat-cell relative overflow-hidden rounded-[2px] shrink-0 border-0 p-0 cursor-default transition-[transform,background-color,box-shadow] duration-150",
            cell.isMostRecentActive && "ring-1 ring-daintree-text/25 ring-offset-1"
          )}
          aria-label={`${formatted}: ${getCountText(cell)}`}
          tabIndex={isActive ? 0 : -1}
        >
          {cell.count > 0 && <span aria-hidden="true" className="pulse-heat-cell-shape" />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        <span className="font-medium">{formatted}</span>
        <span className="ml-1 text-text-secondary">{getCountText(cell)}</span>
      </TooltipContent>
    </Tooltip>
  );
}

const KEYS: readonly CalendarKey[] = [
  "ArrowRight",
  "ArrowLeft",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
];

function isCalendarKey(key: string): key is CalendarKey {
  return (KEYS as readonly string[]).includes(key);
}

/**
 * A week-column calendar: one column per week, one row per weekday, month
 * names over the weeks where a month begins. Laid out this way the range fits
 * the card at its widest (180 days is 27 columns), the newest days sit at the
 * right edge where the eye ends, and weekly rhythm — weekends, a quiet week —
 * lines up across rows instead of hiding 60 days apart in a strip.
 */
export function PulseHeatmap({ cells, rangeDays, describedBy }: PulseHeatmapProps) {
  const calendar = useMemo(() => buildPulseCalendar(cells), [cells]);
  const { weeks, monthLabels, positions, days } = calendar;
  const gridWidth = weeks.length > 0 ? weeks.length * PITCH_PX - GAP_PX : 0;
  const today = days.find((cell) => cell.isToday);
  const todayRow = today ? positions.get(today.date)?.row : undefined;

  const cellRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const initialFocusKey = useMemo(() => {
    const recent = days.filter((cell) => cell.isMostRecentActive).pop();
    return (recent ?? days[days.length - 1])?.date ?? null;
  }, [days]);

  // Roving tabindex: only the active cell holds tabIndex=0. Keep the active
  // key in state because JSX needs it during render.
  const [activeCellKey, setActiveCellKey] = useState<string | null>(null);
  useEffect(() => {
    cellRefs.current.forEach((_, key) => {
      if (!positions.has(key)) cellRefs.current.delete(key);
    });
    if (activeCellKey && !positions.has(activeCellKey)) {
      setActiveCellKey(null);
    }
  }, [positions, activeCellKey]);

  const focusCell = useCallback((date: string) => {
    const node = cellRefs.current.get(date);
    if (!node) return;
    cellRefs.current.forEach((el) => {
      el.tabIndex = -1;
    });
    node.tabIndex = 0;
    node.focus();
    setActiveCellKey(date);
  }, []);

  const registerCellRef = useCallback((date: string, el: HTMLButtonElement | null) => {
    if (el) cellRefs.current.set(date, el);
    else cellRefs.current.delete(date);
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      // Don't swallow Alt/Shift+Arrow combos — Alt+Arrow is browser/OS history
      // navigation on some platforms; Shift+Arrow is reserved for selection.
      if (event.altKey || event.shiftKey) return;
      const key = event.key;
      if (!isCalendarKey(key)) return;

      const date = (event.target as HTMLElement).getAttribute("data-cell-date");
      const from = date ? positions.get(date) : undefined;
      if (!from) return;

      event.preventDefault();
      const to = moveInCalendar(calendar, from, key, event.ctrlKey || event.metaKey);
      const target = to ? weeks[to.col]?.[to.row] : null;
      if (target) focusCell(target.date);
    },
    [calendar, positions, weeks, focusCell]
  );

  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: `${WEEKDAY_GUTTER_PX}px ${gridWidth}px ${TODAY_LABEL_PX}px`,
        gridTemplateRows: `${MONTH_ROW_PX}px auto`,
      }}
    >
      <div
        aria-hidden="true"
        data-testid="pulse-heatmap-months"
        className="relative col-start-2 select-none text-3xs leading-none text-text-secondary"
      >
        {monthLabels.map(({ col, label }) => (
          <span key={col} className="absolute top-0" style={{ left: `${col * PITCH_PX}px` }}>
            {label}
          </span>
        ))}
      </div>

      <div
        aria-hidden="true"
        className="col-start-1 row-start-2 flex select-none flex-col text-3xs text-text-secondary"
        style={{ gap: `${GAP_PX}px` }}
      >
        {WEEKDAY_LABELS.map((label, row) => (
          <span key={row} style={{ height: `${CELL_SIZE_PX}px`, lineHeight: `${CELL_SIZE_PX}px` }}>
            {label}
          </span>
        ))}
      </div>

      {/* Today is always the grid's last day, but "the last cell" is a rule a
          reader has to know; the label says it. It sits beside today's row,
          past the grid's edge, where it never competes with a cell. */}
      <div aria-hidden="true" className="relative col-start-3 row-start-2 select-none">
        {todayRow !== undefined && (
          <span
            data-testid="pulse-heatmap-today"
            className="absolute left-1.5 text-3xs text-text-secondary"
            style={{ top: `${todayRow * PITCH_PX}px`, lineHeight: `${CELL_SIZE_PX}px` }}
          >
            Today
          </span>
        )}
      </div>

      <div
        className="col-start-2 row-start-2 flex flex-col"
        style={{ gap: `${GAP_PX}px` }}
        role="grid"
        aria-label={`Activity over the last ${rangeDays} days, one column per week`}
        aria-describedby={describedBy}
        aria-rowcount={DAYS_PER_WEEK}
        aria-colcount={weeks.length}
        data-testid="pulse-heatmap"
        onKeyDown={handleKeyDown}
      >
        {WEEKDAY_LABELS.map((_, row) => (
          <div
            key={row}
            role="row"
            aria-rowindex={row + 1}
            className="flex"
            style={{ gap: `${GAP_PX}px` }}
          >
            {weeks.map((week, col) => {
              const cell = week[row];
              return cell ? (
                <PulseHeatmapCell
                  key={cell.date}
                  cell={cell}
                  col={col}
                  isActive={cell.date === (activeCellKey ?? initialFocusKey)}
                  onCellRef={registerCellRef}
                />
              ) : (
                // A day outside the range: space held, nothing drawn, nothing
                // announced — it is not a quiet day, the range just ends.
                <span
                  key={`gap-${col}`}
                  aria-hidden="true"
                  className="shrink-0"
                  style={{ width: `${CELL_SIZE_PX}px`, height: `${CELL_SIZE_PX}px` }}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
