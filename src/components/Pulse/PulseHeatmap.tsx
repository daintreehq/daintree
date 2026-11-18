import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FocusEvent, KeyboardEvent, MouseEvent, PointerEvent } from "react";
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
import { pluralize } from "@/lib/pluralize";
import {
  isTooltipFocusOpenSuppressed,
  notifyTooltipPointerActivity,
} from "@/lib/tooltipDismissRegistry";

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

  return `${pluralize(cell.count, "commit")}`;
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
        "pulse-heat-cell relative overflow-hidden rounded-2xs shrink-0 border-0 p-0 cursor-default transition-[transform,background-color,box-shadow] duration-150",
        // Cells sit 3px apart, so an outside ring would land on the neighbours.
        "focus-visible:-outline-offset-2",
        cell.isMostRecentActive && "ring-1 ring-text-primary/25 ring-offset-1"
      )}
      aria-label={`${formatted}: ${getCountText(cell)}`}
      tabIndex={isActive ? 0 : -1}
    >
      {cell.count > 0 && <span aria-hidden="true" className="pulse-heat-cell-shape" />}
    </button>
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

type TipSource = "hover" | "focus" | "touch";

// A click is a PointerEvent in Chromium, and its pointerType names the input
// that produced it: "touch" for a tap, "mouse" or "pen" for those, empty for
// the click a keyboard activation synthesises.
function isTouchClick(event: MouseEvent): boolean {
  const native = event.nativeEvent;
  return "pointerType" in native && native.pointerType === "touch";
}

// The card is portaled over the days above the one it names, which are the ones
// a finger reaches for next, so a tap meant for one of them lands on the card.
// The day beneath the finger is the one asked for.
function cellDateUnder(grid: HTMLElement, x: number, y: number): string | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (grid.contains(el))
      return el.closest("[data-cell-date]")?.getAttribute("data-cell-date") ?? null;
  }
  return null;
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

  // One tooltip for the whole grid, anchored to the hovered, focused or tapped
  // cell by position, instead of a Radix tree per cell (up to 180 per card).
  // The date stays set after a close so the card keeps its text through the
  // exit fade. Hover, focus and touch share it: whichever moved last owns the
  // readout.
  const [tip, setTip] = useState<{
    date: string | null;
    open: boolean;
    source: TipSource | null;
  }>({ date: null, open: false, source: null });
  const gridRef = useRef<HTMLDivElement>(null);
  const pointerDownRef = useRef(false);
  const tipPosition = tip.date ? positions.get(tip.date) : undefined;
  const tipCell = tipPosition ? weeks[tipPosition.col]?.[tipPosition.row] : undefined;

  // A tap's readout has no pointer or focus to end it, so one whose day left
  // the range would otherwise sit there empty.
  useEffect(() => {
    setTip((prev) =>
      prev.open && prev.date !== null && !positions.has(prev.date)
        ? { ...prev, open: false, source: null }
        : prev
    );
  }, [positions]);

  const cellDateOf = (grid: HTMLElement, target: EventTarget): string | null => {
    // The card is portaled but still a React child of the grid, so its pointer
    // events bubble here; only a node actually inside the grid is a cell.
    if (!(target instanceof Element) || !grid.contains(target)) return null;
    return target.closest("[data-cell-date]")?.getAttribute("data-cell-date") ?? null;
  };

  // `source` is who owns the readout: the pointer leaving only closes what the
  // pointer opened, and a blur only what focus opened, so one input ending
  // never wipes out the other's. A tap's readout is neither: the pointerleave a
  // lifted finger fires and a blur between days leave it up, and it closes on a
  // second tap, a tap elsewhere, a scroll, Escape, or focus leaving the grid for
  // another control (`handleBlur`).
  const showTip = (date: string, source: TipSource) => {
    setTip((prev) =>
      prev.date === date &&
      prev.open &&
      // Focus coming back to the day a tap has open (the window regaining it)
      // is that tap's readout, not a new owner of it.
      (prev.source === source || (source === "focus" && prev.source === "touch"))
        ? prev
        : { date, open: true, source }
    );
  };

  const hideTip = (...sources: TipSource[]) => {
    setTip((prev) =>
      prev.open && (sources.length === 0 || (prev.source !== null && sources.includes(prev.source)))
        ? { ...prev, open: false, source: null }
        : prev
    );
  };

  // The day a tap opened closes on a tap of the same day; any other day, or one
  // whose readout focus or hover opened, takes the readout over.
  const toggleTouchTip = (date: string) => {
    setTip((prev) =>
      prev.open && prev.date === date && prev.source === "touch"
        ? { ...prev, open: false, source: null }
        : { date, open: true, source: "touch" }
    );
  };

  const handlePointerOver = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    notifyTooltipPointerActivity();
    const date = cellDateOf(event.currentTarget, event.target);
    if (date) showTip(date, "hover");
    else hideTip("hover");
  };

  const handlePointerLeave = () => hideTip("hover");

  // A press hands the screen to whatever the cell does, and the focus it
  // causes is not a request for a tooltip: mirrors the shared trigger. The
  // flag is cleared on a timer rather than pointerup, which never arrives
  // here when the press is released outside the grid. A finger's press leaves
  // the readout alone: the tap's click decides it, and closing here would only
  // be undone a moment later.
  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    pointerDownRef.current = true;
    setTimeout(() => {
      pointerDownRef.current = false;
    }, 0);
    if (event.pointerType !== "touch") hideTip();
  };

  // A touch screen has no hover, and the focus a tap causes is a side effect,
  // so the click is where a tap states its request for a day's readout. Every
  // other activation (a mouse click, a keyboard Enter or Space) hands the
  // screen to the cell and closes it, as before.
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!isTouchClick(event)) {
      hideTip();
      return;
    }
    const grid = event.currentTarget;
    const { target } = event;
    const date =
      target instanceof Node && !grid.contains(target)
        ? cellDateUnder(grid, event.clientX, event.clientY)
        : cellDateOf(grid, target);
    if (date) toggleTouchTip(date);
    else hideTip();
  };

  const handleFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (pointerDownRef.current || isTooltipFocusOpenSuppressed()) return;
    const date = cellDateOf(event.currentTarget, event.target);
    if (date) showTip(date, "focus");
  };

  // Focus leaving the grid for another control ends a tap's readout along with
  // a focus one: with auto-dismiss off nothing else would, and the card would
  // sit over whatever the keyboard user moved on to. Focus going nowhere (the
  // window losing it, a tap on bare space) leaves a tap's readout to the taps
  // and presses that dismiss it.
  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && !event.currentTarget.contains(next)) hideTip("focus", "touch");
    else hideTip("focus");
  };

  const handleTipOpenChange = (next: boolean) => {
    if (!next) hideTip();
  };

  // Radix closes the card on any press outside it, ahead of the click that
  // finishes the tap: a tap on the open day would close it on the press and
  // the click would reopen it, and a tap on another day would flash shut
  // between the two. A press in the grid is the grid's to resolve; one
  // anywhere else still dismisses.
  const handleCardPointerDownOutside = (event: {
    detail: { originalEvent: { target: EventTarget | null } };
    preventDefault: () => void;
  }) => {
    const { target } = event.detail.originalEvent;
    if (target instanceof Node && gridRef.current?.contains(target)) event.preventDefault();
  };

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
        ref={gridRef}
        className="relative col-start-2 row-start-2 flex flex-col"
        style={{ gap: `${GAP_PX}px` }}
        role="grid"
        aria-label={`Activity over the last ${rangeDays} days, one column per week`}
        aria-describedby={describedBy}
        aria-rowcount={DAYS_PER_WEEK}
        aria-colcount={weeks.length}
        data-testid="pulse-heatmap"
        onKeyDown={handleKeyDown}
        onPointerOver={handlePointerOver}
        onPointerLeave={handlePointerLeave}
        onPointerDown={handlePointerDown}
        onClick={handleClick}
        onFocus={handleFocus}
        onBlur={handleBlur}
      >
        {/* 0ms: dense scrub-hover surface (mirrors GitHub's contribution
            heatmap). autoDismiss off: this tooltip is the only place a day's
            date and count are shown, so it stays while the cell is hovered,
            focused or tapped rather than vanishing mid-read after the app-wide
            hint window. */}
        <Tooltip open={tip.open} onOpenChange={handleTipOpenChange} autoDismiss={false}>
          <TooltipTrigger asChild>
            <span
              aria-hidden="true"
              data-testid="pulse-heatmap-tooltip-anchor"
              className="pointer-events-none absolute"
              style={{
                left: `${(tipPosition?.col ?? 0) * PITCH_PX}px`,
                top: `${(tipPosition?.row ?? 0) * PITCH_PX}px`,
                width: `${CELL_SIZE_PX}px`,
                height: `${CELL_SIZE_PX}px`,
              }}
            />
          </TooltipTrigger>
          <TooltipContent
            side="top"
            className="text-xs"
            onPointerDownOutside={handleCardPointerDownOutside}
          >
            {tipCell && (
              <>
                <span className="font-medium">{formatDay(tipCell)}</span>
                <span className="ml-1 text-text-secondary">{getCountText(tipCell)}</span>
              </>
            )}
          </TooltipContent>
        </Tooltip>
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
