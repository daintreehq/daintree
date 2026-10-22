import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type Ref,
} from "react";
import {
  Virtuoso,
  type ItemProps,
  type ListProps,
  type ListRange,
  type ScrollerProps,
  type VirtuosoHandle,
} from "react-virtuoso";
import type {
  PluginSelectionGesture,
  PluginSelectionKey,
  PluginVirtualGridProps,
  PluginVirtualGridSelection,
} from "@shared/types/plugin-sdk-react";
import { LIST_ROW_HOVER_CLASS, PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { useScrollShadowOverlays } from "@/components/ui/ScrollShadow";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { guardCallbacks } from "./kitDiagnostics";
import { field, fn, node, pickRootProps, positive, str } from "./kitProps";
import { AUTO_GRID_DEFAULT_MIN_PX, AUTO_GRID_LIMIT_PX, GAP_PX, gapOf } from "./PluginKitLayoutCore";
import { activeMounted, fromCellControl, reactKey, SCROLLER_RING_INSET } from "./PluginKitLists";

const DEFAULT_ITEM_PX = 180;
const DEFAULT_OVERSCAN_ROWS = 2;
// Narrower columns would only put more cards in every mounted row.
const MIN_COLUMN_PX = 16;

const attempt = guardCallbacks("VirtualGrid");

// The grid is as tall as all its rows, so its own ring would be clipped by the
// scroller; the cursor cell is the indicator instead, the one accent in the
// grid, drawn only while the grid holds keyboard focus. Selection stays the
// neutral `aria-selected` fill.
const CELL_FOCUS_RING =
  "outline-hidden focus-visible:[&_[role=gridcell][data-active=true]]:outline focus-visible:[&_[role=gridcell][data-active=true]]:outline-2 focus-visible:[&_[role=gridcell][data-active=true]]:-outline-offset-2 focus-visible:[&_[role=gridcell][data-active=true]]:outline-accent-primary";

/**
 * As many columns as fit, none narrower than `minColumnWidth` unless one alone
 * is wider than the grid, capped by `maxColumns`. One column until measured.
 * Exported for tests.
 */
export function gridColumns(
  width: number,
  minColumnWidth: unknown,
  maxColumns: unknown,
  gapPx: number
): number {
  const min = Math.max(
    positive(minColumnWidth, AUTO_GRID_LIMIT_PX) ?? AUTO_GRID_DEFAULT_MIN_PX,
    MIN_COLUMN_PX
  );
  const fit = width > 0 ? Math.max(1, Math.floor((width + gapPx) / (min + gapPx))) : 1;
  const max =
    typeof maxColumns === "number" && Number.isInteger(maxColumns) && maxColumns >= 1
      ? maxColumns
      : undefined;
  return max === undefined ? fit : Math.min(fit, max);
}

/**
 * Where a navigation key moves the cursor in a row-major grid: Left and Right
 * step through the items in reading order, Up and Down keep the column (Down
 * onto a short last row lands on its last item), Home and End stay in the
 * row, and with `wide` (Ctrl or Cmd held) Home and End go to the first and
 * last item. `null` for a key that is not navigation. Exported for tests.
 */
export function gridStep(
  key: string,
  index: number,
  total: number,
  columns: number,
  wide: boolean
): number | null {
  if (total <= 0) return null;
  const last = total - 1;
  const from = Math.min(Math.max(index, 0), last);
  const rowStart = from - (from % columns);
  const rowEnd = Math.min(rowStart + columns - 1, last);
  switch (key) {
    case "Home":
      return wide ? 0 : rowStart;
    case "End":
      return wide ? last : rowEnd;
    case "ArrowLeft":
      return wide ? null : Math.max(from - 1, 0);
    case "ArrowRight":
      return wide ? null : Math.min(from + 1, last);
    case "ArrowUp":
      return wide ? null : from - columns >= 0 ? from - columns : from;
    case "ArrowDown":
      if (wide) return null;
      if (from + columns <= last) return from + columns;
      return rowEnd < last ? last : from;
    default:
      return null;
  }
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * A `useSelection` result read defensively; `undefined` unless it can at
 * least select. A method that throws is reported and does nothing.
 */
function readSelection(value: unknown): PluginVirtualGridSelection | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const isSelected = field(value, "isSelected");
  const handleSelect = field(value, "handleSelect");
  if (typeof isSelected !== "function" || typeof handleSelect !== "function") return undefined;
  const call = (method: unknown, args: unknown[]): unknown =>
    typeof method === "function"
      ? attempt(() => Reflect.apply(method, value, args), undefined)
      : undefined;
  const anchor = field(value, "anchor");
  return {
    count: count(field(value, "count")),
    anchor: typeof anchor === "string" || typeof anchor === "number" ? anchor : null,
    isSelected: (id: PluginSelectionKey) => call(isSelected, [id]) === true,
    handleSelect: (id: PluginSelectionKey, gesture?: PluginSelectionGesture) =>
      void call(handleSelect, [id, gesture]),
    handleNavigate: (id: PluginSelectionKey, gesture?: PluginSelectionGesture) =>
      void call(field(value, "handleNavigate"), [id, gesture]),
    selectAll: () => void call(field(value, "selectAll"), []),
    clear: () => void call(field(value, "clear"), []),
  };
}

interface GridContext {
  interactive: boolean;
  /**
   * Role, name, keyboard and the plugin's identity: on the scroller of a
   * keyboard grid, which takes focus at the viewport's size, and on the
   * element holding the rows of a plain one.
   */
  rootProps: Record<string, unknown>;
  columns: number;
  gapPx: number;
}

function GridScroller({
  context,
  ref,
  ...props
}: ScrollerProps & { context: GridContext; ref?: Ref<HTMLDivElement> }) {
  if (!context.interactive) return <div {...props} ref={ref} tabIndex={0} />;
  // After the virtualiser's own props, so its test id never replaces the plugin's.
  return <div {...props} {...context.rootProps} ref={ref} />;
}

function GridList({
  context,
  ref,
  style,
  children,
}: ListProps & { context: GridContext; ref?: Ref<HTMLDivElement> }) {
  const listProps = context.interactive ? undefined : context.rootProps;
  return (
    <div {...listProps} ref={ref} style={style}>
      {children}
    </div>
  );
}

// Each virtualised item is one row of cards. The gap above a row is padding
// rather than margin, so the virtualiser measures it with the row.
function GridRow({
  context,
  item: _item,
  style,
  ...props
}: ItemProps<unknown> & { context: GridContext }) {
  const row = props["data-index"];
  return (
    <div
      {...props}
      role={context.interactive ? "row" : "none"}
      aria-rowindex={context.interactive ? row + 1 : undefined}
      style={{
        ...style,
        display: "grid",
        gridTemplateColumns: `repeat(${context.columns}, minmax(0, 1fr))`,
        columnGap: context.gapPx,
        paddingTop: row > 0 ? context.gapPx : 0,
      }}
    />
  );
}

const GRID_COMPONENTS = { Scroller: GridScroller, List: GridList, Item: GridRow };

function KitVirtualGrid(props: PluginVirtualGridProps) {
  const {
    items,
    count: itemCount,
    renderItem,
    itemKey,
    onItemActivate,
    minColumnWidth,
    maxColumns,
    gap,
    estimatedItemSize,
    overscan,
    onEndReached,
    activeIndex,
    onActiveIndexChange,
    selection: rawSelection,
    shadows,
    className,
    ...rest
  } = props;
  const data = Array.isArray(items) ? items : undefined;
  const total = data ? data.length : count(itemCount);
  const render = fn(renderItem);
  const keyFn = fn(itemKey);
  const activateFn = fn(onItemActivate);
  const endReached = fn(onEndReached);
  const onActiveChange = fn(onActiveIndexChange);
  const selection = readSelection(rawSelection);
  const interactive = selection !== undefined || activateFn !== undefined;
  const gapPx = GAP_PX[gapOf(gap, "md")];
  const rowPx = (positive(estimatedItemSize, 10_000) ?? DEFAULT_ITEM_PX) + gapPx;
  const overscanRows = typeof overscan === "number" ? count(overscan) : DEFAULT_OVERSCAN_ROWS;

  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // Before paint, so the first frame already has its columns: Virtuoso hands
  // out its scroller only from a passive effect, so it is found in the frame.
  // The rows span the scroller's client width (its viewport is absolutely
  // placed, so padding does not inset them). A hidden pane reads 0 and keeps
  // the columns it had.
  useLayoutEffect(() => {
    const scroller = frame.current?.querySelector<HTMLElement>("[data-virtuoso-scroller]");
    if (!scroller) return;
    const measure = () => {
      const next = scroller.clientWidth;
      if (next > 0) setWidth((previous) => (previous === next ? previous : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);
  const columns = gridColumns(width, minColumnWidth, maxColumns, gapPx);
  const rowCount = Math.ceil(total / columns);

  const keyOf = (index: number): string | number =>
    keyFn ? reactKey(keyFn(index, data?.[index]), index) : index;

  // A controlled cursor, else the grid's own; in a plain grid only the item
  // to keep in view. Clamped at read time, so a shrinking list never points
  // past its end.
  const given =
    typeof activeIndex === "number" && Number.isInteger(activeIndex) ? activeIndex : undefined;
  const [cursor, setCursor] = useState(-1);
  const requested = given ?? (interactive ? cursor : -1);
  const current = total === 0 || requested < 0 ? -1 : Math.min(requested, total - 1);
  const currentRow = current >= 0 ? Math.floor(current / columns) : -1;

  const handle = useRef<VirtuosoHandle>(null);
  const reveal = (index: number) =>
    handle.current?.scrollIntoView({ index: Math.floor(index / columns) });
  const [range, setRange] = useState<ListRange | null>(null);

  // The plugin's own `activeIndex` is kept in view as it changes; one that
  // only echoes the cursor this grid just reported is already where the key
  // or click put it.
  const echoed = useRef<number | null>(null);
  const columnsNow = useRef(columns);
  useLayoutEffect(() => {
    columnsNow.current = columns;
  });
  const controlled = given !== undefined && current >= 0 ? current : -1;
  // Not before the first measurement: until then there is one column, and
  // the row would be the wrong one.
  const measured = width > 0;
  useEffect(() => {
    if (!measured) return;
    const echo = echoed.current;
    echoed.current = null;
    if (controlled < 0 || controlled === echo) return;
    handle.current?.scrollIntoView({ index: Math.floor(controlled / columnsNow.current) });
  }, [controlled, measured]);

  // A regroup moves the cursor's card to another row; keep it in view while
  // the grid has focus, and leave the scroll alone when it does not.
  const lastColumns = useRef(columns);
  useEffect(() => {
    if (lastColumns.current === columns) return;
    lastColumns.current = columns;
    const root = frame.current;
    if (currentRow >= 0 && root !== null && root.contains(document.activeElement)) {
      handle.current?.scrollIntoView({ index: currentRow });
    }
  }, [columns, currentRow]);

  const moveCursor = (index: number) => {
    echoed.current = index;
    setCursor(index);
    onActiveChange?.(index);
  };
  const activate = (index: number) => activateFn?.(index, data?.[index]);

  // Focus from a press is placed by the click that follows; only focus from
  // the keyboard puts the cursor on the first item.
  const pressed = useRef(false);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.nativeEvent.isComposing) return;
    const primary = isMac() ? event.metaKey : event.ctrlKey;
    if (selection && primary && !event.altKey && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selection.selectAll();
      return;
    }
    if (event.altKey || total === 0) return;
    if (event.key === "Escape" && selection && selection.count > 0) {
      event.preventDefault();
      event.stopPropagation();
      selection.clear();
      return;
    }
    const step = gridStep(event.key, current, total, columns, event.metaKey || event.ctrlKey);
    // With no cursor yet (focus came from a press between cards), an arrow
    // finds the first item rather than stepping past it.
    const next = step !== null && current < 0 && event.key.startsWith("Arrow") ? 0 : step;
    if (next !== null) {
      event.preventDefault();
      moveCursor(next);
      reveal(next);
      if (event.shiftKey && selection) {
        // A range needs somewhere to start: the item the cursor left.
        if (selection.anchor === null && current >= 0) selection.handleSelect(keyOf(current));
        selection.handleNavigate(keyOf(next), event);
      }
      return;
    }
    if (event.metaKey || event.ctrlKey || current < 0) return;
    if (event.key === " ") {
      event.preventDefault();
      if (selection) selection.handleSelect(keyOf(current), event);
      else activate(current);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (activateFn) activate(current);
      else selection?.handleSelect(keyOf(current), event);
    }
  };

  const onCellClick = (index: number, event: MouseEvent<HTMLElement>) => {
    if (fromCellControl(event)) return;
    moveCursor(index);
    const primary = isMac() ? event.metaKey : event.ctrlKey;
    if (selection && (event.shiftKey || primary)) {
      selection.handleSelect(keyOf(index), event);
      return;
    }
    if (activateFn) activate(index);
    else selection?.handleSelect(keyOf(index), event);
  };

  const baseId = useId();
  const cellId = (index: number) => `${baseId}cell-${index}`;
  // Spread first so the grid's own attributes win over a plugin's.
  const identity = pickRootProps(rest, { aria: true });
  const label = str(props["aria-label"]) ?? "";
  const release = () => {
    pressed.current = false;
  };
  const rootProps: Record<string, unknown> = interactive
    ? {
        ...identity,
        role: "grid",
        "aria-label": label,
        "aria-rowcount": rowCount,
        "aria-colcount": columns,
        tabIndex: 0,
        // Never at a cell scrolled out of the mounted window; the next arrow
        // key scrolls it back.
        "aria-activedescendant":
          current >= 0 && activeMounted(currentRow, range) ? cellId(current) : undefined,
        onKeyDown,
        onPointerDown: () => {
          pressed.current = true;
        },
        onPointerUp: release,
        onPointerCancel: release,
        onBlur: (event: FocusEvent<HTMLDivElement>) => {
          const to = event.relatedTarget;
          if (!(to instanceof Node && event.currentTarget.contains(to))) release();
        },
        onFocus: (event: FocusEvent<HTMLDivElement>) => {
          const fromPress = pressed.current;
          release();
          if (event.target !== event.currentTarget || total === 0 || fromPress) return;
          const at = current < 0 ? 0 : current;
          if (current < 0) moveCursor(0);
          if (!activeMounted(Math.floor(at / columns), range)) reveal(at);
        },
      }
    : { ...identity, role: "list", "aria-label": label };

  const context: GridContext = { interactive, rootProps, columns, gapPx };

  const cell = (index: number) => {
    const item = data?.[index];
    const key = keyOf(index);
    const active = interactive && index === current;
    const selected = selection?.isSelected(key) === true;
    return (
      <div
        key={key}
        id={interactive ? cellId(index) : undefined}
        role={interactive ? "gridcell" : "listitem"}
        aria-colindex={interactive ? (index % columns) + 1 : undefined}
        aria-selected={selection ? selected : undefined}
        data-active={active ? "true" : undefined}
        onClick={interactive ? (event) => onCellClick(index, event) : undefined}
        className={cn(
          "min-w-0",
          interactive && [
            PALETTE_ROW_CLASS,
            LIST_ROW_HOVER_CLASS,
            "cursor-pointer rounded-[var(--radius-md)] p-1",
          ]
        )}
      >
        {node(render?.(index, item, { active, selected }))}
      </div>
    );
  };

  // Paging follows the mounted range, the same rendered rows Virtuoso's own
  // end detection reads: once the last row is mounted, each new item count is
  // reported once, including a page that only fills out the last row, which
  // adds no row for Virtuoso to report. A count that drops is reported again
  // when it grows back.
  const lastRowMounted = rowCount > 0 && range !== null && range.endIndex >= rowCount - 1;
  const reported = useRef(-1);
  useEffect(() => {
    if (total < reported.current) reported.current = -1;
    if (!endReached || !lastRowMounted || total === 0 || reported.current === total) return;
    reported.current = total;
    endReached(total - 1);
  }, [endReached, lastRowMounted, total]);

  const { ref: shadowRef, topShadow, bottomShadow } = useScrollShadowOverlays();
  const withShadows = shadows === true;

  return (
    <div ref={frame} className="relative h-full min-h-0">
      {withShadows ? topShadow : null}
      {withShadows ? bottomShadow : null}
      <Virtuoso
        ref={handle}
        scrollerRef={
          withShadows ? (el) => shadowRef(el instanceof HTMLElement ? el : null) : undefined
        }
        className={cn(
          interactive ? CELL_FOCUS_RING : SCROLLER_RING_INSET,
          "overflow-x-hidden [scrollbar-gutter:stable]",
          str(className)
        )}
        style={{ height: "100%" }}
        context={context}
        components={GRID_COMPONENTS}
        totalCount={rowCount}
        defaultItemHeight={rowPx}
        increaseViewportBy={overscanRows * rowPx}
        itemContent={(row) => {
          const cells = [];
          const end = Math.min((row + 1) * columns, total);
          for (let index = row * columns; index < end; index++) cells.push(cell(index));
          return cells;
        }}
        rangeChanged={setRange}
      />
    </div>
  );
}

export const pluginKitVirtualGrid = {
  VirtualGrid: KitVirtualGrid,
};
