import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import {
  TableVirtuoso,
  Virtuoso,
  type ItemProps,
  type ListProps,
  type ListRange,
  type ScrollerProps,
  type TableProps,
  type TableVirtuosoHandle,
  type VirtuosoHandle,
} from "react-virtuoso";
import type {
  PluginDataTableProps,
  PluginDataTableSort,
  PluginLogViewProps,
  PluginVirtualListProps,
} from "@shared/types/plugin-sdk-react";
import { LIST_ROW_HOVER_CLASS, PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { useScrollShadowOverlays } from "@/components/ui/ScrollShadow";
import { cn } from "@/lib/utils";
import {
  field,
  fn,
  node,
  nonEmpty,
  oneOf,
  pickDomProps,
  pickRootProps,
  positive,
  str,
} from "./kitProps";
import { severityGlyph } from "./PluginKitPatterns";

const DEFAULT_ROW_PX = 28;
const DEFAULT_OVERSCAN_ROWS = 8;

// A focused list must not point `aria-activedescendant` at a row the reader
// scrolled out of the mounted window; the next arrow key scrolls it back.
function activeMounted(index: number, range: ListRange | null): boolean {
  return index >= 0 && (range === null || (index >= range.startIndex && index <= range.endIndex));
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function reactKey(value: unknown, fallback: number): string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
    ? value
    : fallback;
}

// A scroller that takes focus fills its pane edge to edge, so the global
// `*:focus-visible` ring is drawn inset rather than into the pane's clip.
const SCROLLER_RING_INSET = "focus-visible:-outline-offset-2";

// The grid is as tall as all its rows, so a ring of its own would be clipped
// away by the scroller. Its focus indicator is the cursor row instead: the one
// accent in the grid, painted only while the grid itself holds keyboard focus.
// Selection stays the neutral `aria-selected` fill, so the two never compete.
const GRID_FOCUS_RING =
  "outline-hidden focus-visible:[&_tr[data-active=true]]:outline focus-visible:[&_tr[data-active=true]]:outline-2 focus-visible:[&_tr[data-active=true]]:-outline-offset-2 focus-visible:[&_tr[data-active=true]]:outline-accent-primary";

interface ListContext {
  listProps: Record<string, unknown>;
  /**
   * A focusable list takes the keyboard on the scroller, which is the size of
   * the viewport, so the global ring frames what the reader can see; the list
   * element is as tall as all its rows and its own ring would be clipped away.
   */
  listFocusable: boolean;
  itemRole: "listitem" | "none";
  /**
   * The plugin's `id` and `data-*`, re-applied after the virtualiser's props
   * on a focusable scroller: Virtuoso stamps its own `data-testid` there, which
   * would otherwise overwrite a plugin's test id without a word.
   */
  identity: Record<string, string | number | boolean>;
}

function ListScroller({
  context,
  ref,
  ...props
}: ScrollerProps & { context: ListContext; ref?: Ref<HTMLDivElement> }) {
  if (!context.listFocusable) return <div {...props} ref={ref} tabIndex={0} />;
  // The virtualiser's own props go after the plugin's so its scroll wiring and
  // sizing win; only the plugin's identity goes after those.
  return <div {...context.listProps} {...props} {...context.identity} ref={ref} />;
}

function ListElement({
  context,
  ref,
  style,
  children,
}: ListProps & { context: ListContext; ref?: Ref<HTMLDivElement> }) {
  // A focusable list's role and keyboard live on the scroller, and this element
  // is a plain wrapper its options are still owned through.
  const listProps = context.listFocusable ? undefined : context.listProps;
  return (
    <div {...listProps} ref={ref} style={style}>
      {children}
    </div>
  );
}

// Virtuoso puts a wrapper round each row. It is the `listitem` of a plain list;
// in a listbox it steps aside so the plugin's `option` rows are owned directly.
function ListItem({
  context,
  item: _item,
  ...props
}: ItemProps<unknown> & { context: ListContext }) {
  return <div {...props} role={context.itemRole} />;
}

const LIST_COMPONENTS = { Scroller: ListScroller, List: ListElement, Item: ListItem };

function KitVirtualList(props: PluginVirtualListProps) {
  const {
    items,
    count: rowCount,
    renderItem,
    itemKey,
    estimatedItemSize,
    overscan,
    onEndReached,
    activeIndex,
    shadows,
    className,
    ...rest
  } = props;
  const data = Array.isArray(items) ? items : undefined;
  const total = data ? data.length : count(rowCount);
  const render = fn(renderItem);
  const keyOf = fn(itemKey);
  const endReached = fn(onEndReached);
  const rowPx = positive(estimatedItemSize, 10_000) ?? DEFAULT_ROW_PX;
  const overscanRows = typeof overscan === "number" ? count(overscan) : DEFAULT_OVERSCAN_ROWS;
  // Plugin style and ref would fight the virtualiser's own on this element.
  const { style: _style, ref: _ref, ...dom } = pickDomProps(rest);
  const role = str(dom.role);
  const [range, setRange] = useState<ListRange | null>(null);
  const target =
    typeof activeIndex === "number" &&
    Number.isInteger(activeIndex) &&
    activeIndex >= 0 &&
    activeIndex < total
      ? activeIndex
      : -1;
  const descendant =
    target >= 0 && !activeMounted(target, range) ? { "aria-activedescendant": undefined } : {};
  const context: ListContext = {
    listProps: { ...dom, role: role ?? "list", ...descendant },
    listFocusable: typeof dom.tabIndex === "number" && dom.tabIndex >= 0,
    itemRole: role ? "none" : "listitem",
    identity: pickRootProps(dom),
  };

  const handle = useRef<VirtuosoHandle>(null);
  useEffect(() => {
    if (target >= 0) handle.current?.scrollIntoView({ index: target });
  }, [target]);

  // Called either way (hooks), but only wired to the scroller when asked for.
  const { ref: shadowRef, topShadow, bottomShadow } = useScrollShadowOverlays();
  const withShadows = shadows === true;

  const list = (
    <Virtuoso
      ref={handle}
      scrollerRef={
        withShadows ? (el) => shadowRef(el instanceof HTMLElement ? el : null) : undefined
      }
      className={cn(SCROLLER_RING_INSET, str(className))}
      style={{ height: "100%" }}
      context={context}
      components={LIST_COMPONENTS}
      {...(data ? { data } : { totalCount: total })}
      defaultItemHeight={rowPx}
      increaseViewportBy={overscanRows * rowPx}
      computeItemKey={(index, item) => (keyOf ? reactKey(keyOf(index, item), index) : index)}
      itemContent={(index, item) => node(render?.(index, item))}
      endReached={endReached ? (index) => endReached(index) : undefined}
      rangeChanged={setRange}
    />
  );
  if (!withShadows) return list;
  return (
    <div className="relative h-full min-h-0">
      {topShadow}
      {bottomShadow}
      {list}
    </div>
  );
}

interface TableColumn {
  id: string;
  header: ReactNode;
  width: number | string | undefined;
  grow: boolean;
  align: "start" | "center" | "end";
  sortable: boolean;
  render: ((row: unknown, index: number) => unknown) | undefined;
}

function readColumns(columns: unknown): TableColumn[] {
  if (!Array.isArray(columns)) return [];
  const seen = new Set<string>();
  const out: TableColumn[] = [];
  for (const entry of columns) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = nonEmpty(field(entry, "id"));
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const width = field(entry, "width");
    const render = field(entry, "render");
    out.push({
      id,
      header: node(field(entry, "header")),
      width:
        typeof width === "string"
          ? width
          : typeof width === "number"
            ? positive(width, 10_000)
            : undefined,
      align: oneOf(field(entry, "align"), ["start", "center", "end"] as const) ?? "start",
      grow: field(entry, "grow") === true,
      sortable: field(entry, "sortable") === true,
      render:
        typeof render === "function"
          ? (row, index): unknown => Reflect.apply(render, undefined, [row, index])
          : undefined,
    });
  }
  return out;
}

/** The widest a column without a `width` grows before the rest is left as trailing space. */
export const FLEX_COLUMN_MAX_PX = 480;

interface ColumnLayout {
  widths: (number | string | undefined)[];
  /** A trailing, unlabelled column that takes the width no column claims. */
  filler: boolean;
}

/** A column width in px: 0 for none, null for a length that cannot be summed. */
function pxWidth(width: number | string | undefined): number | null {
  if (width === undefined) return 0;
  if (typeof width === "number") return width;
  const match = /^\s*(\d+(?:\.\d+)?)px\s*$/.exec(width);
  return match ? Number(match[1]) : null;
}

/**
 * How wide each column is drawn. The table is fixed-layout and full-width, so
 * whatever the sized columns leave goes to the unsized ones; alone, one of
 * them would stretch across the pane and push every column after it to the
 * far edge. Unsized columns stop at FLEX_COLUMN_MAX_PX instead and a filler
 * takes the remainder, and a table of sized columns keeps exactly the widths
 * it asked for. A `grow` column opts back into taking everything. Exported for
 * tests.
 */
export function layoutColumns(
  columns: readonly { width: number | string | undefined; grow: boolean }[],
  available: number | null
): ColumnLayout {
  const widths = columns.map((column) => column.width);
  // `grow` means "take the leftover", which only an unsized column can do.
  if (columns.length === 0 || columns.some((column) => column.grow && column.width === undefined)) {
    return { widths, filler: false };
  }
  const flexible = columns.filter((column) => column.width === undefined).length;
  if (flexible === 0) return { widths, filler: true };
  // Only px can be summed against the measured width; a relative length (a
  // percentage, `rem`, `ch`) or an unmeasured table keeps the plain share.
  const px = columns.map((column) => pxWidth(column.width));
  if (available === null || px.some((value) => value === null)) {
    return { widths, filler: false };
  }
  const sized = px.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  if ((available - sized) / flexible <= FLEX_COLUMN_MAX_PX) return { widths, filler: false };
  return { widths: widths.map((width) => width ?? FLEX_COLUMN_MAX_PX), filler: true };
}

const ALIGN_CLASS = { start: "text-start", center: "text-center", end: "text-end" } as const;

function cellValue(row: unknown, column: TableColumn, index: number): ReactNode {
  if (column.render) return node(column.render(row, index));
  if (typeof row !== "object" || row === null) return null;
  const value = field(row, column.id);
  return typeof value === "string" || typeof value === "number" ? value : null;
}

interface TableContext {
  columns: TableColumn[];
  interactive: boolean;
  activeIndex: number;
  selectedKey: string | number | undefined;
  keyOf: (row: unknown, index: number) => string | number;
  rowId: (index: number) => string;
  tableProps: Record<string, unknown>;
  activate: (index: number) => void;
}

function TableScroller({
  context,
  ref,
  ...props
}: ScrollerProps & { context: TableContext; ref?: Ref<HTMLDivElement> }) {
  return <div {...props} ref={ref} tabIndex={context.interactive ? -1 : 0} />;
}

function TableElement({ context, style, children }: TableProps & { context: TableContext }) {
  return (
    <table
      {...context.tableProps}
      style={{ ...style, tableLayout: "fixed", width: "100%", borderCollapse: "collapse" }}
      className={cn("text-xs", context.interactive && GRID_FOCUS_RING)}
    >
      {children}
    </table>
  );
}

function TableRow({ context, item, ...props }: ItemProps<unknown> & { context: TableContext }) {
  const index = props["data-index"];
  const key = context.keyOf(item, index);
  const selected = context.selectedKey !== undefined && key === context.selectedKey;
  const { interactive } = context;
  return (
    <tr
      {...props}
      id={interactive ? context.rowId(index) : undefined}
      aria-rowindex={index + 2}
      // `aria-selected` belongs to grid rows; a static table marks its row for the CSS only.
      aria-selected={interactive ? selected : undefined}
      data-selected={!interactive && selected ? "true" : undefined}
      data-active={interactive && index === context.activeIndex ? "true" : undefined}
      onClick={interactive ? () => context.activate(index) : undefined}
      className={cn(PALETTE_ROW_CLASS, interactive && [LIST_ROW_HOVER_CLASS, "cursor-pointer"])}
    />
  );
}

const TABLE_COMPONENTS = { Scroller: TableScroller, Table: TableElement, TableRow };

function readSort(sort: unknown): PluginDataTableSort | null {
  if (typeof sort !== "object" || sort === null) return null;
  const columnId = nonEmpty(field(sort, "columnId"));
  const direction = oneOf(field(sort, "direction"), ["asc", "desc"] as const);
  return columnId && direction ? { columnId, direction } : null;
}

function SortGlyph({ direction }: { direction: "asc" | "desc" | undefined }) {
  if (!direction) return null;
  const Glyph = direction === "asc" ? ArrowUp : ArrowDown;
  return <Glyph className="h-3 w-3 shrink-0" aria-hidden="true" />;
}

function KitDataTable({
  columns,
  rows,
  rowKey,
  sort,
  onSortChange,
  onRowClick,
  selectedRowKey,
  empty,
  estimatedRowSize,
  onEndReached,
  "aria-label": ariaLabel,
  className,
  ...rest
}: PluginDataTableProps) {
  // `aria-*` belongs on the grid inside, which names itself; the root takes `id` and `data-*`.
  const rootAttributes = pickRootProps(rest);
  const cols = readColumns(columns);
  const data: readonly unknown[] = Array.isArray(rows) ? rows : [];
  const current = readSort(sort);
  const handleSort = fn(onSortChange);
  const rowClick = fn(onRowClick);
  const endReached = fn(onEndReached);
  const interactive = rowClick !== undefined;
  const rowPx = positive(estimatedRowSize, 10_000) ?? DEFAULT_ROW_PX;
  const keyField = typeof rowKey === "string" ? rowKey : undefined;
  const keyFn = typeof rowKey === "function" ? rowKey : undefined;
  const keyOf = (row: unknown, index: number): string | number => {
    if (keyFn) return reactKey(keyFn(row, index), index);
    if (keyField && typeof row === "object" && row !== null) {
      return reactKey(field(row, keyField), index);
    }
    return index;
  };
  const selectedKey =
    typeof selectedRowKey === "string" || typeof selectedRowKey === "number"
      ? selectedRowKey
      : undefined;

  const [cursor, setCursor] = useState(-1);
  const activeIndex = data.length === 0 ? -1 : Math.min(cursor, data.length - 1);
  const baseId = useId();
  const rowId = (index: number) => `${baseId}row-${index}`;
  const handle = useRef<TableVirtuosoHandle>(null);
  const [revealIndex, setRevealIndex] = useState(-1);
  useEffect(() => {
    if (revealIndex >= 0) handle.current?.scrollIntoView({ index: revealIndex });
  }, [revealIndex]);

  const activate = (index: number) => {
    setCursor(index);
    const row = data[index];
    if (index >= 0 && index < data.length) rowClick?.(row, index);
  };

  const [range, setRange] = useState<ListRange | null>(null);

  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [available, setAvailable] = useState<number | null>(null);
  useEffect(() => {
    if (scroller === null || typeof ResizeObserver === "undefined") return;
    const measure = () => setAvailable(scroller.clientWidth || null);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scroller]);
  const layout = layoutColumns(cols, available);

  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    // Keys on a header's sort button are the button's, not the grid cursor's.
    if (event.target !== event.currentTarget) return;
    if (event.metaKey || event.ctrlKey || event.altKey || data.length === 0) return;
    const last = data.length - 1;
    const from = activeIndex;
    let next: number | null = null;
    if (event.key === "ArrowDown") next = from < 0 ? 0 : Math.min(from + 1, last);
    else if (event.key === "ArrowUp") next = from < 0 ? last : Math.max(from - 1, 0);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next !== null) {
      event.preventDefault();
      setCursor(next);
      setRevealIndex(next);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && from >= 0) {
      event.preventDefault();
      activate(from);
    }
  };

  const label = str(ariaLabel) ?? "";
  const tableProps: Record<string, unknown> = interactive
    ? {
        role: "grid",
        "aria-label": label,
        "aria-rowcount": data.length + 1,
        tabIndex: 0,
        "aria-activedescendant": activeMounted(activeIndex, range) ? rowId(activeIndex) : undefined,
        onKeyDown,
        // The first arrow press should not be the one that finds the cursor.
        // The cursor row is the grid's focus indicator, so focus arriving
        // must find it on screen: the first row when there is no cursor yet,
        // else the cursor scrolled back into the mounted window.
        onFocus: () => {
          if (data.length === 0) return;
          const at = cursor < 0 ? 0 : activeIndex;
          if (cursor < 0) setCursor(0);
          if (!activeMounted(at, range)) handle.current?.scrollIntoView({ index: at });
        },
      }
    : { "aria-label": label, "aria-rowcount": data.length + 1 };

  const context: TableContext = {
    columns: cols,
    interactive,
    activeIndex,
    selectedKey,
    keyOf,
    rowId,
    tableProps,
    activate,
  };

  if (data.length === 0 && empty !== undefined && empty !== null) {
    return (
      <div {...rootAttributes} className={cn("h-full", str(className))}>
        {node(empty)}
      </div>
    );
  }

  const header = () => (
    <tr aria-rowindex={1}>
      {cols.map((column, columnIndex) => {
        const width = layout.widths[columnIndex];
        const direction = current?.columnId === column.id ? current.direction : undefined;
        return (
          <th
            key={column.id}
            scope="col"
            aria-sort={
              column.sortable
                ? direction === "asc"
                  ? "ascending"
                  : direction === "desc"
                    ? "descending"
                    : "none"
                : undefined
            }
            style={width === undefined ? undefined : { width }}
            className={cn(
              "border-b border-divider bg-surface-canvas px-3 py-1.5 font-medium text-text-secondary",
              ALIGN_CLASS[column.align]
            )}
          >
            {column.sortable && handleSort ? (
              <button
                type="button"
                onClick={() =>
                  handleSort({
                    columnId: column.id,
                    direction: direction === "asc" ? "desc" : "asc",
                  })
                }
                className={cn(
                  "inline-flex max-w-full items-center gap-1 rounded-[var(--radius-sm)] transition-colors duration-150 ease-out hover:text-text-primary",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary",
                  direction && "text-text-primary",
                  column.align === "end" && "flex-row-reverse"
                )}
              >
                <span className="truncate">{column.header}</span>
                <SortGlyph direction={direction} />
              </button>
            ) : (
              <span className="block truncate">{column.header}</span>
            )}
          </th>
        );
      })}
      {layout.filler ? (
        <th aria-hidden="true" className="border-b border-divider bg-surface-canvas p-0" />
      ) : null}
    </tr>
  );

  return (
    <TableVirtuoso
      {...rootAttributes}
      ref={handle}
      scrollerRef={(element) => setScroller(element instanceof HTMLElement ? element : null)}
      className={cn(SCROLLER_RING_INSET, str(className))}
      style={{ height: "100%" }}
      data={data}
      context={context}
      components={TABLE_COMPONENTS}
      defaultItemHeight={rowPx}
      increaseViewportBy={DEFAULT_OVERSCAN_ROWS * rowPx}
      computeItemKey={(index, row) => keyOf(row, index)}
      fixedHeaderContent={header}
      rangeChanged={setRange}
      itemContent={(index, row) => [
        ...cols.map((column) => (
          <td
            key={column.id}
            className={cn(
              "overflow-hidden text-ellipsis whitespace-nowrap px-3 py-1.5 text-text-primary",
              ALIGN_CLASS[column.align]
            )}
          >
            {cellValue(row, column, index)}
          </td>
        )),
        ...(layout.filler ? [<td key={"\u0000filler"} aria-hidden="true" className="p-0" />] : []),
      ]}
      endReached={endReached ? (index) => endReached(index) : undefined}
    />
  );
}

const DEFAULT_MAX_LINES = 5000;
const MAX_LINES_CEILING = 100_000;

function LogLine({
  entry,
  monospace,
  wrap,
}: {
  entry: unknown;
  monospace: boolean;
  wrap: boolean;
}) {
  const text =
    typeof entry === "string"
      ? entry
      : typeof entry === "object" && entry !== null
        ? str(field(entry, "text"))
        : undefined;
  const severity =
    typeof entry === "object" && entry !== null ? field(entry, "severity") : undefined;
  const glyph = severityGlyph(severity, "mt-0.5 h-3 w-3");
  return (
    <div
      className={cn(
        "flex gap-1.5 px-3 text-xs leading-5 text-text-primary",
        monospace && "font-mono",
        wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"
      )}
    >
      {glyph}
      {glyph ? <span className="sr-only">{`${String(severity)}: `}</span> : null}
      <span className="min-w-0">{text ?? ""}</span>
    </div>
  );
}

function KitLogView({
  lines,
  maxLines,
  follow,
  monospace,
  wrap,
  "aria-label": ariaLabel,
  className,
  ...rest
}: PluginLogViewProps) {
  const all: readonly unknown[] = Array.isArray(lines) ? lines : [];
  const max =
    Math.floor(positive(maxLines, MAX_LINES_CEILING) ?? DEFAULT_MAX_LINES) || DEFAULT_MAX_LINES;
  const dropped = all.length > max ? all.length - max : 0;
  const visible = dropped > 0 ? all.slice(dropped) : all;
  const following = follow !== false;
  const mono = monospace !== false;
  const wrapped = wrap !== false;
  return (
    <Virtuoso
      {...pickRootProps(rest, { aria: true })}
      // A live region would read out every line of a busy job; the log is
      // there to be read on demand, from the keyboard as well as the wheel.
      role="log"
      aria-live="off"
      aria-label={str(ariaLabel) ?? ""}
      tabIndex={0}
      className={cn(
        "py-1 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary",
        str(className)
      )}
      style={{ height: "100%" }}
      data={visible}
      // Keyed by line number in `lines`, so a line keeps its row as older ones drop.
      computeItemKey={(index) => dropped + index}
      defaultItemHeight={20}
      increaseViewportBy={400}
      atBottomThreshold={24}
      initialTopMostItemIndex={following ? Math.max(0, visible.length - 1) : 0}
      followOutput={(atBottom) => (following && atBottom ? "auto" : false)}
      itemContent={(_index, entry) => <LogLine entry={entry} monospace={mono} wrap={wrapped} />}
    />
  );
}

export const pluginKitLists = {
  VirtualList: KitVirtualList,
  DataTable: KitDataTable,
  LogView: KitLogView,
};
