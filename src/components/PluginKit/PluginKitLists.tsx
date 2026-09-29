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
import { cn } from "@/lib/utils";
import { field, fn, node, nonEmpty, oneOf, pickDomProps, positive, str } from "./kitProps";
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

// The focus ring lives on the scroller, drawn inset, because the element that
// holds focus (the list or the grid) is as tall as all its rows and its own
// ring would be clipped to nothing by the scroller.
const SCROLLER_FOCUS_RING =
  "has-[[data-kit-focus]:focus-visible]:outline has-[[data-kit-focus]:focus-visible]:outline-2 has-[[data-kit-focus]:focus-visible]:-outline-offset-2 has-[[data-kit-focus]:focus-visible]:outline-accent-primary";

interface ListContext {
  listProps: Record<string, unknown>;
  /** The keyboard lives on the list element, so the scroller stays out of the tab order. */
  listFocusable: boolean;
  itemRole: "listitem" | "none";
}

function ListScroller({
  context,
  ref,
  ...props
}: ScrollerProps & { context: ListContext; ref?: Ref<HTMLDivElement> }) {
  return <div {...props} ref={ref} tabIndex={context.listFocusable ? -1 : 0} />;
}

function ListElement({
  context,
  ref,
  style,
  children,
}: ListProps & { context: ListContext; ref?: Ref<HTMLDivElement> }) {
  const focusable = context.listFocusable;
  return (
    <div
      {...context.listProps}
      ref={ref}
      style={style}
      data-kit-focus={focusable ? "" : undefined}
      // eslint-disable-next-line component-contract/no-unpaired-outline-suppression -- the scroller draws this element's ring (SCROLLER_FOCUS_RING)
      className={focusable ? "outline-hidden" : undefined}
    >
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
  };

  const handle = useRef<VirtuosoHandle>(null);
  useEffect(() => {
    if (target >= 0) handle.current?.scrollIntoView({ index: target });
  }, [target]);

  return (
    <Virtuoso
      ref={handle}
      className={cn(SCROLLER_FOCUS_RING, str(className))}
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
}

interface TableColumn {
  id: string;
  header: ReactNode;
  width: number | string | undefined;
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
      sortable: field(entry, "sortable") === true,
      render:
        typeof render === "function"
          ? (row, index): unknown => Reflect.apply(render, undefined, [row, index])
          : undefined,
    });
  }
  return out;
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
      data-kit-focus={context.interactive ? "" : undefined}
      // eslint-disable-next-line component-contract/no-unpaired-outline-suppression -- the scroller draws the grid's ring (SCROLLER_FOCUS_RING)
      className={cn("group/grid text-xs", context.interactive && "outline-hidden")}
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
      className={cn(
        PALETTE_ROW_CLASS,
        interactive && [
          LIST_ROW_HOVER_CLASS,
          "cursor-pointer",
          "group-focus-visible/grid:data-[active=true]:outline group-focus-visible/grid:data-[active=true]:outline-2 group-focus-visible/grid:data-[active=true]:-outline-offset-2 group-focus-visible/grid:data-[active=true]:outline-accent-primary",
        ]
      )}
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
}: PluginDataTableProps) {
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
        onFocus: () => {
          if (cursor < 0 && data.length > 0) setCursor(0);
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
    return <div className={cn("h-full", str(className))}>{node(empty)}</div>;
  }

  const header = () => (
    <tr aria-rowindex={1}>
      {cols.map((column) => {
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
            style={column.width === undefined ? undefined : { width: column.width }}
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
    </tr>
  );

  return (
    <TableVirtuoso
      ref={handle}
      className={cn(SCROLLER_FOCUS_RING, str(className))}
      style={{ height: "100%" }}
      data={data}
      context={context}
      components={TABLE_COMPONENTS}
      defaultItemHeight={rowPx}
      increaseViewportBy={DEFAULT_OVERSCAN_ROWS * rowPx}
      computeItemKey={(index, row) => keyOf(row, index)}
      fixedHeaderContent={header}
      rangeChanged={setRange}
      itemContent={(index, row) =>
        cols.map((column) => (
          <td
            key={column.id}
            className={cn(
              "overflow-hidden text-ellipsis whitespace-nowrap px-3 py-1.5 text-text-primary",
              ALIGN_CLASS[column.align]
            )}
          >
            {cellValue(row, column, index)}
          </td>
        ))
      }
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
