import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import { Columns3 } from "lucide-react";
import {
  TableVirtuoso,
  type ItemProps,
  type ListRange,
  type ScrollerProps,
  type TableBodyProps,
  type TableProps,
  type TableVirtuosoHandle,
} from "react-virtuoso";
import type { PluginDataTableProps } from "@shared/types/plugin-sdk-react";
import { Button } from "@/components/ui/button";
import { Checkbox, CheckboxGlyph } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  stopContextMenuPropagation,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { useSplitterKeys } from "@/hooks/useSplitterKeys";
import {
  LIST_ROW_HOVER_CLASS,
  PALETTE_ROW_CLASS,
  ROW_MENU_TARGET_CLASS,
} from "@/components/ui/paletteRowStyles";
import { LIST_LABEL_CLASS } from "@/components/ui/sectionLabel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useSelection } from "@/pluginUi/selection";
import { usePersistentViewState } from "@/pluginUi/viewState";
import {
  field,
  fn,
  hasContent,
  node,
  nonEmpty,
  oneOf,
  pickRootProps,
  positive,
  str,
  useKitOwnerAttributes,
} from "./kitProps";
import { CONTEXT_MENU_PARTS, isMenuKey, renderMenuEntries } from "./kitMenu";
import { useKitOverlayZClass } from "./kitScope";
import {
  ALIGN_CLASS,
  activeMounted,
  cellValue,
  DEFAULT_OVERSCAN_ROWS,
  DEFAULT_ROW_PX,
  GRID_FOCUS_RING,
  layoutColumns,
  pluginKitLists,
  reactKey,
  readColumns,
  readSort,
  SCROLLER_RING_INSET,
  SortGlyph,
  type TableColumn,
} from "./PluginKitLists";
import {
  buildTableItems,
  clampWidth,
  declaredPx,
  selectionOrder,
  groupKeyOf,
  type DrawnGroup,
  type DrawnItem,
  type DrawnRow,
  type RowKey,
  type SubRows,
} from "./kitDataTableModel";
import {
  createLazyScope,
  errorMessage,
  forgetLazyChildren,
  lazyChildrenVersion,
  peekLazyChildren,
  readLazyChildren,
  subscribeLazyChildren,
} from "./kitLazyChildren";
import { GatedLoading, GatedSpinner, TREE_INDENT_PX, TreeChevron, TreeGutter } from "./kitTreeRow";
import { severityGlyph } from "./PluginKitPatterns";
import { pluginKitTreeView } from "./PluginKitTreeView";
import { pluginKitObjectInspector } from "./PluginKitObjectInspector";
import "./kitDataTable.css";

const BasicDataTable = pluginKitLists.DataTable;

// A plugin callback that throws must not take the table down with it.
function attempt<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch (error) {
    console.warn("[PluginKit] DataTable callback threw", error);
    return fallback;
  }
}

function isRowKey(value: unknown): value is RowKey {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function keyList(value: unknown): RowKey[] | undefined {
  return Array.isArray(value) ? value.filter(isRowKey) : undefined;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : undefined;
}

function omitKey<V>(record: Record<string, V>, key: string): Record<string, V> {
  const out = { ...record };
  delete out[key];
  return out;
}

function widthRecord(value: unknown): Record<string, number> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, width] of Object.entries(value)) {
    if (typeof width === "number" && Number.isFinite(width) && width > 0) out[key] = width;
  }
  return out;
}

const DEFAULT_MIN_WIDTH = 48;
const DEFAULT_MAX_WIDTH = 1200;
/** What an unsized column counts as when the table works out whether it must scroll sideways. */
const UNSIZED_MIN_PX = 120;
const CHECK_COLUMN_PX = 32;
const MENU_COLUMN_PX = 32;
const RESIZE_STEP_PX = 8;
const RESIZE_BIG_STEP_PX = 32;

type EditorKind = "text" | "number" | "select";

interface RichColumn extends TableColumn {
  resizable: boolean;
  minWidth: number;
  maxWidth: number;
  hideable: boolean;
  menuLabel: string;
  editable: ((row: unknown) => boolean) | null;
  editor: EditorKind;
  editOptions: { value: string; label: string; disabled: boolean }[];
  editValue: ((row: unknown) => string) | undefined;
  validate: ((value: string, row: unknown) => string | undefined) | undefined;
}

function readOptions(value: unknown): RichColumn["editOptions"] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: RichColumn["editOptions"] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const optionValue = nonEmpty(field(entry, "value"));
    if (!optionValue || seen.has(optionValue)) continue;
    seen.add(optionValue);
    out.push({
      value: optionValue,
      label: str(field(entry, "label")) ?? optionValue,
      disabled: field(entry, "disabled") === true,
    });
  }
  return out;
}

function readRichColumns(columns: unknown): RichColumn[] {
  const base = readColumns(columns);
  const raw = new Map<string, object>();
  if (Array.isArray(columns)) {
    for (const entry of columns) {
      if (typeof entry !== "object" || entry === null) continue;
      const id = nonEmpty(field(entry, "id"));
      if (id !== undefined && !raw.has(id)) raw.set(id, entry);
    }
  }
  return base.map((column) => {
    const entry = raw.get(column.id) ?? {};
    const min = positive(field(entry, "minWidth"), 10_000) ?? DEFAULT_MIN_WIDTH;
    const max = Math.max(min, positive(field(entry, "maxWidth"), 10_000) ?? DEFAULT_MAX_WIDTH);
    const editable = field(entry, "editable");
    const editValue = field(entry, "editValue");
    const validate = field(entry, "validate");
    const header = field(entry, "header");
    return {
      ...column,
      resizable: field(entry, "resizable") === true,
      minWidth: min,
      maxWidth: max,
      hideable: field(entry, "hideable") !== false,
      menuLabel:
        nonEmpty(field(entry, "menuLabel")) ??
        (typeof header === "string" && header !== "" ? header : column.id),
      editable:
        editable === true
          ? () => true
          : typeof editable === "function"
            ? (row: unknown) =>
                attempt(() => Reflect.apply(editable, undefined, [row]) === true, false)
            : null,
      editor: oneOf(field(entry, "editor"), ["text", "number", "select"] as const) ?? "text",
      editOptions: readOptions(field(entry, "editOptions")),
      editValue:
        typeof editValue === "function"
          ? (row: unknown) => {
              const text: unknown = attempt(
                () => Reflect.apply(editValue, undefined, [row]),
                undefined
              );
              return typeof text === "string" ? text : "";
            }
          : undefined,
      validate:
        typeof validate === "function"
          ? (value: string, row: unknown) => {
              // A check that throws refuses the draft rather than letting it through.
              const message: unknown = attempt(
                () => Reflect.apply(validate, undefined, [value, row]),
                "Couldn't check this value"
              );
              return nonEmpty(message);
            }
          : undefined,
    };
  });
}

function startValue(column: RichColumn, row: unknown): string {
  if (column.editValue) return column.editValue(row);
  if (typeof row !== "object" || row === null) return "";
  const value = field(row, column.id);
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (typeof value !== "object" || value === null) return false;
  try {
    return typeof Reflect.get(value, "then") === "function";
  } catch {
    return false;
  }
}

/** Whether a table needs anything past the basic DataTable. Exported for tests. */
export function usesRichDataTable(props: object): boolean {
  const read = (name: string): unknown => {
    try {
      return Reflect.get(props, name);
    } catch {
      return undefined;
    }
  };
  const isFn = (name: string) => typeof read(name) === "function";
  const selectable = read("selectable");
  const groupBy = read("groupBy");
  if (
    selectable === true ||
    isFn("selectable") ||
    (typeof groupBy === "string" && groupBy !== "") ||
    isFn("groupBy") ||
    isFn("getSubRows") ||
    (isFn("hasSubRows") && isFn("loadSubRows")) ||
    hasWidth(read("columnWidths")) ||
    hasWidth(read("defaultColumnWidths")) ||
    hasString(read("hiddenColumns")) ||
    hasString(read("defaultHiddenColumns")) ||
    read("columnsMenu") === true ||
    nonEmpty(read("viewStateKey")) !== undefined ||
    read("stickyFirstColumn") === true
  ) {
    return true;
  }
  const columns = read("columns");
  return (
    Array.isArray(columns) &&
    columns.some(
      (column) =>
        typeof column === "object" &&
        column !== null &&
        (field(column, "resizable") === true ||
          field(column, "editable") === true ||
          typeof field(column, "editable") === "function")
    )
  );
}

function hasWidth(value: unknown): boolean {
  try {
    return Object.keys(widthRecord(value) ?? {}).length > 0;
  } catch {
    return false;
  }
}

function hasString(value: unknown): boolean {
  return (stringList(value)?.length ?? 0) > 0;
}

interface CellEdit {
  key: RowKey;
  columnId: string;
  draft: string;
  error: string | undefined;
}

type CellMove = "next" | "previous" | null;

interface RichContext {
  items: readonly DrawnItem[];
  columns: readonly RichColumn[];
  interactive: boolean;
  selectable: boolean;
  activeIndex: number;
  isSelected: (row: DrawnRow) => boolean;
  rowId: (index: number) => string;
  tableProps: Record<string, unknown>;
  tableStyle: CSSProperties;
  scrolledX: boolean;
  /** Rows carry levels and positions only in a treegrid. */
  treegrid: boolean;
  /** A group's selection, with a checkbox column; null without one. */
  groupSelected: (group: DrawnGroup) => boolean | null;
  onRowClick: (index: number, event: MouseEvent<HTMLTableRowElement>) => void;
  menuIndex: number;
  openRowMenu: ((event: MouseEvent<HTMLElement>) => void) | undefined;
}

function RichScroller({
  context: _context,
  ref,
  ...props
}: ScrollerProps & { context: RichContext; ref?: Ref<HTMLDivElement> }) {
  return <div {...props} ref={ref} tabIndex={-1} />;
}

function RichTableElement({ context, style, children }: TableProps & { context: RichContext }) {
  return (
    <table
      {...context.tableProps}
      data-scrolled-x={context.scrolledX ? "" : undefined}
      style={{ ...style, ...context.tableStyle }}
      className={cn("text-xs", context.interactive && GRID_FOCUS_RING)}
    >
      {children}
    </table>
  );
}

function RichTableBody({
  context,
  ref,
  ...props
}: TableBodyProps & { context: RichContext; ref?: Ref<HTMLTableSectionElement> }) {
  if (!context.openRowMenu) return <tbody {...props} ref={ref} />;
  return (
    <ContextMenuTrigger asChild onContextMenu={context.openRowMenu}>
      <tbody {...props} ref={ref} />
    </ContextMenuTrigger>
  );
}

function RichTableRow({
  context,
  item: _item,
  ...props
}: ItemProps<DrawnItem> & { context: RichContext }) {
  const index = props["data-index"];
  const item = context.items[index];
  if (!item) return <tr {...props} />;
  const active = context.interactive && index === context.activeIndex;
  const common = {
    ...props,
    id: context.interactive ? context.rowId(index) : undefined,
    "aria-rowindex": index + 2,
    "data-active": active ? "true" : undefined,
    onClick: (event: MouseEvent<HTMLTableRowElement>) => context.onRowClick(index, event),
  };
  const tree = context.treegrid;
  if (item.kind === "group") {
    return (
      <tr
        {...common}
        aria-level={1}
        aria-expanded={!item.collapsed}
        aria-selected={context.groupSelected(item) ?? undefined}
        aria-posinset={item.posInSet}
        aria-setsize={item.setSize}
        data-group-row={item.groupKey}
        className="cursor-pointer"
      />
    );
  }
  if (item.kind === "status") {
    return (
      <tr
        {...common}
        aria-level={tree ? item.level : undefined}
        aria-posinset={tree ? 1 : undefined}
        aria-setsize={tree ? 1 : undefined}
        data-status-row={item.status}
      />
    );
  }
  const selected = context.isSelected(item);
  return (
    <tr
      {...common}
      aria-level={tree ? item.level : undefined}
      aria-posinset={tree ? item.posInSet : undefined}
      aria-setsize={tree ? item.setSize : undefined}
      aria-expanded={tree && item.expandable ? item.expanded : undefined}
      aria-selected={context.interactive ? selected : undefined}
      data-selected={!context.interactive && selected ? "true" : undefined}
      data-hoverable={context.interactive ? "" : undefined}
      data-state={index === context.menuIndex ? "open" : undefined}
      className={cn(
        PALETTE_ROW_CLASS,
        context.interactive && [LIST_ROW_HOVER_CLASS, "cursor-pointer"],
        context.openRowMenu && ROW_MENU_TARGET_CLASS
      )}
    />
  );
}

const RICH_COMPONENTS = {
  Scroller: RichScroller,
  Table: RichTableElement,
  TableBody: RichTableBody,
  TableRow: RichTableRow,
};

/**
 * Scrolls the cell being edited out from under the pinned column on the left
 * and the Columns rail on the right. Native focus scrolling ignores both.
 */
function revealEditCell(scroller: HTMLElement, rail: number): void {
  const cell = scroller.querySelector<HTMLElement>("td[data-edit-cell]");
  if (!cell) return;
  const view = scroller.getBoundingClientRect();
  const box = cell.getBoundingClientRect();
  let pinned = 0;
  for (const stuck of scroller.querySelectorAll<HTMLElement>("thead th.kit-dt-sticky")) {
    const rect = stuck.getBoundingClientRect();
    if (rect.left < view.left + view.width / 2) pinned = Math.max(pinned, rect.right - view.left);
  }
  const left = view.left + pinned;
  const right = view.right - rail;
  if (box.left < left) scroller.scrollLeft -= left - box.left;
  else if (box.right > right) scroller.scrollLeft += Math.min(box.right - right, box.left - left);
}

function useControllable<T>(
  controlled: T | undefined,
  initial: () => T,
  onChange: ((value: T) => void) | undefined
): [T, (value: T) => void] {
  const [own, setOwn] = useState<T>(initial);
  const value = controlled ?? own;
  const set = (next: T) => {
    if (controlled === undefined) setOwn(next);
    onChange?.(next);
  };
  return [value, set];
}

function CellEditor({
  column,
  edit,
  label,
  onDraft,
  onCommit,
  onCancel,
}: {
  column: RichColumn;
  edit: CellEdit;
  label: string;
  onDraft: (draft: string) => void;
  /** False when the draft was refused and the editor stays open. */
  onCommit: (draft: string, move: CellMove) => boolean;
  onCancel: () => void;
}) {
  // Enter, Tab and Escape settle the edit themselves; the blur that follows
  // as focus goes back to the grid must not commit it a second time.
  const settled = useRef(false);
  const errorId = useId();
  const settle = (run: () => boolean | void) => {
    if (settled.current) return;
    settled.current = true;
    if (run() === false) settled.current = false;
  };
  const invalid = edit.error !== undefined;
  const described = invalid ? { "aria-describedby": errorId, "aria-invalid": true } : {};

  // A select commits as soon as a choice is made; a refused choice keeps the
  // list open (Radix closes it after every choice) with the message showing.
  const [open, setOpen] = useState(true);
  const refused = useRef(false);
  const control =
    column.editor === "select" ? (
      <Select
        open={open}
        value={edit.draft === "" ? undefined : edit.draft}
        onValueChange={(value) => {
          onDraft(value);
          settle(() => {
            const accepted = onCommit(value, null);
            refused.current = !accepted;
            return accepted;
          });
        }}
        onOpenChange={(next) => {
          if (next) {
            setOpen(true);
            return;
          }
          if (refused.current) {
            refused.current = false;
            return;
          }
          setOpen(false);
          settle(onCancel);
        }}
      >
        <SelectTrigger
          aria-label={label}
          density="compact"
          {...described}
          className="h-6 w-full min-w-0"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent
          onKeyDown={(event) => {
            // The list holds focus while open; Tab still moves to the next cell.
            if (event.key !== "Tab") return;
            event.preventDefault();
            event.stopPropagation();
            settle(() => onCommit(edit.draft, event.shiftKey ? "previous" : "next"));
          }}
        >
          {column.editOptions.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : (
      <Input
        autoFocus
        density="compact"
        type={column.editor === "number" ? "number" : "text"}
        aria-label={label}
        invalid={invalid}
        {...described}
        value={edit.draft}
        onChange={(event) => onDraft(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            settle(() => onCommit(event.currentTarget.value, null));
          } else if (event.key === "Escape") {
            event.preventDefault();
            settle(onCancel);
          } else if (event.key === "Tab") {
            event.preventDefault();
            settle(() => onCommit(event.currentTarget.value, event.shiftKey ? "previous" : "next"));
          }
        }}
        onBlur={(event) => settle(() => onCommit(event.currentTarget.value, null))}
        className="h-6 w-full min-w-0 px-1.5 focus-visible:outline-offset-0"
      />
    );
  // One structure whether or not there is an error, so the field is never
  // remounted (and blurred) when a refusal arrives.
  return (
    <>
      <Tooltip open={invalid}>
        <TooltipTrigger asChild>{control}</TooltipTrigger>
        <TooltipContent side="bottom" align="start">
          {edit.error}
        </TooltipContent>
      </Tooltip>
      <span id={errorId} className="sr-only">
        {edit.error}
      </span>
    </>
  );
}

function ColumnResizeHandle({
  column,
  width,
  onResize,
  onReset,
}: {
  column: RichColumn;
  width: number | undefined;
  onResize: (px: number, final: boolean) => void;
  onReset: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  // An unsized column has no width of its own until it is measured.
  const [measured, setMeasured] = useState<number | null>(null);
  const [handle, setHandle] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const cell = handle?.parentElement;
    if (!cell || typeof ResizeObserver === "undefined") return;
    const measure = () => setMeasured(cell.getBoundingClientRect().width || null);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(cell);
    return () => observer.disconnect();
  }, [handle]);
  const value = clampWidth(width ?? measured ?? column.minWidth, column.minWidth, column.maxWidth);
  const onKeyDown = useSplitterKeys({
    growKey: "ArrowRight",
    value,
    min: column.minWidth,
    max: column.maxWidth,
    step: RESIZE_STEP_PX,
    largeStep: RESIZE_BIG_STEP_PX,
    onChange: (next) => onResize(clampWidth(next, column.minWidth, column.maxWidth), true),
    onReset,
  });
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    const startX = event.clientX;
    const startWidth = width ?? target.parentElement?.getBoundingClientRect().width ?? value;
    // RTL drags grow the column to the left.
    const direction = getComputedStyle(target).direction === "rtl" ? -1 : 1;
    target.setPointerCapture?.(event.pointerId);
    setDragging(true);
    let last = startWidth;
    const move = (moveEvent: PointerEvent) => {
      last = clampWidth(
        startWidth + (moveEvent.clientX - startX) * direction,
        column.minWidth,
        column.maxWidth
      );
      onResize(last, false);
    };
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
      setDragging(false);
      onResize(last, true);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  };
  return (
    <ResizeHandle
      ref={setHandle}
      growKey="ArrowRight"
      edge="right"
      label={`Resize ${column.menuLabel}`}
      value={value}
      min={column.minWidth}
      max={column.maxWidth}
      isResizing={dragging}
      onReset={onReset}
      onPointerDown={onPointerDown}
      onKeyDown={(event) => {
        if (onKeyDown(event)) event.stopPropagation();
      }}
      onClick={(event) => event.stopPropagation()}
      className="z-[4] touch-none"
    />
  );
}

function RichDataTable(props: PluginDataTableProps) {
  const {
    columns,
    rows,
    rowKey,
    sort,
    onSortChange,
    onRowClick,
    rowMenu,
    selectedRowKey,
    empty,
    estimatedRowSize,
    onEndReached,
    "aria-label": ariaLabel,
    className,
    selectable,
    selectedRowKeys,
    defaultSelectedRowKeys,
    onSelectedRowKeysChange,
    groupBy,
    groupLabel,
    collapsedGroups,
    defaultCollapsedGroups,
    onCollapsedGroupsChange,
    getSubRows,
    hasSubRows,
    loadSubRows,
    expandedRowKeys,
    defaultExpandedRowKeys,
    onExpandedRowKeysChange,
    columnWidths,
    defaultColumnWidths,
    onColumnWidthsChange,
    hiddenColumns,
    defaultHiddenColumns,
    onHiddenColumnsChange,
    columnsMenu,
    viewStateKey: _viewStateKey,
    stickyFirstColumn,
    onCellEdit,
    ...rest
  } = props;
  const rootAttributes = pickRootProps(rest);
  const allColumns = readRichColumns(columns);
  const data: readonly unknown[] = Array.isArray(rows) ? rows : [];
  const current = readSort(sort);
  const handleSort = fn(onSortChange);
  const rowClick = fn(onRowClick);
  const menuFor = fn(rowMenu);
  const endReached = fn(onEndReached);
  const cellEdit = fn(onCellEdit);
  const overlayZ = useKitOverlayZClass();
  const owner = useKitOwnerAttributes();
  const rowPx = positive(estimatedRowSize, 10_000) ?? DEFAULT_ROW_PX;
  const keyField = typeof rowKey === "string" ? rowKey : undefined;
  const keyFn = typeof rowKey === "function" ? rowKey : undefined;
  const keyOf = (row: unknown, index: number): RowKey => {
    if (keyFn)
      return reactKey(
        attempt(() => keyFn(row, index), index),
        index
      );
    if (keyField && typeof row === "object" && row !== null) {
      return reactKey(field(row, keyField), index);
    }
    return index;
  };
  const singleKey = isRowKey(selectedRowKey) ? selectedRowKey : undefined;

  // Columns: hidden, then widths.
  const [hidden, setHidden] = useControllable<string[]>(
    stringList(hiddenColumns),
    () => stringList(defaultHiddenColumns) ?? [],
    fn(onHiddenColumnsChange)
  );
  const hiddenSet = new Set(hidden);
  const unhidden = allColumns.filter((column) => !column.hideable || !hiddenSet.has(column.id));
  // A table always shows a column, whatever a default or a restored layout hid.
  const visible = unhidden.length > 0 ? unhidden : allColumns.slice(0, 1);
  const [widths, setWidths] = useControllable<Record<string, number>>(
    widthRecord(columnWidths),
    () => widthRecord(defaultColumnWidths) ?? {},
    fn(onColumnWidthsChange)
  );
  // A drag shows its width live and reports once, on release.
  const [dragWidth, setDragWidth] = useState<{ id: string; px: number } | null>(null);
  const widthOf = (column: RichColumn): number | string | undefined => {
    if (dragWidth?.id === column.id) return dragWidth.px;
    const set = widths[column.id];
    return set !== undefined ? clampWidth(set, column.minWidth, column.maxWidth) : column.width;
  };

  // Groups and sub-rows.
  const groupField = typeof groupBy === "string" && groupBy !== "" ? groupBy : undefined;
  const groupFn = typeof groupBy === "function" ? groupBy : undefined;
  const groupOf =
    groupField !== undefined || groupFn !== undefined
      ? (row: unknown): string => {
          if (groupFn) return groupKeyOf(attempt(() => groupFn(row), ""));
          if (groupField && typeof row === "object" && row !== null) {
            return groupKeyOf(field(row, groupField));
          }
          return "";
        }
      : undefined;
  const [collapsed, setCollapsed] = useControllable<string[]>(
    stringList(collapsedGroups),
    () => stringList(defaultCollapsedGroups) ?? [],
    fn(onCollapsedGroupsChange)
  );
  const [expanded, setExpanded] = useControllable<RowKey[]>(
    keyList(expandedRowKeys),
    () => keyList(defaultExpandedRowKeys) ?? [],
    fn(onExpandedRowKeysChange)
  );
  const subRowsFn = fn(getSubRows);
  const hasSubFn = fn(hasSubRows);
  const loadFn = fn(loadSubRows);
  const tree = subRowsFn !== undefined || (hasSubFn !== undefined && loadFn !== undefined);
  const [lazyScope] = useState(createLazyScope);
  // Re-reads the lazy cache when a load settles anywhere.
  const lazyRevision = useSyncExternalStore(
    subscribeLazyChildren,
    lazyChildrenVersion,
    lazyChildrenVersion
  );
  const subRowsOf = tree
    ? (row: unknown, open: boolean): SubRows => {
        const given = subRowsFn ? attempt(() => subRowsFn(row), null) : null;
        if (Array.isArray(given) && given.length > 0) return { kind: "rows", rows: given };
        if (!loadFn || !hasSubFn || !attempt(() => hasSubFn(row), false)) return { kind: "none" };
        const entry = open
          ? readLazyChildren<unknown>(lazyScope, row, () => loadFn(row))
          : peekLazyChildren<unknown>(lazyScope, row);
        if (!entry) return { kind: "unloaded" };
        if (entry.status === "done") {
          return entry.items.length > 0 ? { kind: "rows", rows: entry.items } : { kind: "none" };
        }
        return entry.status === "error"
          ? { kind: "error", message: entry.message }
          : { kind: "loading" };
      }
    : undefined;

  const items = buildTableItems({
    rows: data,
    keyOf,
    groupOf,
    collapsedGroups: new Set(collapsed),
    expanded: new Set(expanded),
    subRowsOf,
    revision: lazyRevision,
  });

  // Selection.
  const selectFn = typeof selectable === "function" ? selectable : undefined;
  const canSelect = selectable === true || selectFn !== undefined;
  const selectableRow = (row: unknown) =>
    canSelect && (!selectFn || attempt(() => selectFn(row) === true, false));
  const selectionIds = canSelect ? selectionOrder(items, selectableRow) : [];
  const controlledKeys = keyList(selectedRowKeys);
  const selection = useSelection<RowKey>({
    ids: selectionIds,
    mode: "multiple",
    ...(controlledKeys
      ? { selected: controlledKeys }
      : { defaultSelected: keyList(defaultSelectedRowKeys) ?? [] }),
    onSelectedChange: fn(onSelectedRowKeysChange),
  });
  const isSelected = (row: DrawnRow) =>
    (canSelect && selection.isSelected(row.key)) ||
    (singleKey !== undefined && row.key === singleKey);

  // A group's selectable rows, whether it is folded or not.
  const groupKeys = (group: DrawnGroup): RowKey[] =>
    canSelect ? group.keys.filter((_key, index) => selectableRow(group.rows[index])) : [];
  const groupState = (group: DrawnGroup): boolean | "indeterminate" => {
    const keys = groupKeys(group);
    const on = keys.filter((key) => selection.isSelected(key)).length;
    return on === 0 ? false : on === keys.length ? true : "indeterminate";
  };
  const toggleGroupSelection = (group: DrawnGroup) => {
    const keys = groupKeys(group);
    if (keys.length === 0) return;
    const allOn = groupState(group) === true;
    const next = new Set(selection.selected);
    for (const key of keys) {
      if (allOn) next.delete(key);
      else next.add(key);
    }
    selection.select([...next]);
  };

  const editableColumns = visible.filter((column) => column.editable !== null);
  const canEdit = editableColumns.length > 0;
  const interactive =
    rowClick !== undefined || menuFor !== undefined || canSelect || tree || !!groupOf || canEdit;

  const [cursorId, setCursorId] = useState<string | null>(null);
  const found = cursorId === null ? -1 : items.findIndex((item) => item.id === cursorId);
  const activeIndex = items.length === 0 ? -1 : found;
  const baseId = useId();
  const rowId = (index: number) => `${baseId}row-${index}`;
  const handle = useRef<TableVirtuosoHandle>(null);
  const [range, setRange] = useState<ListRange | null>(null);
  const [revealIndex, setRevealIndex] = useState(-1);
  useEffect(() => {
    if (revealIndex >= 0) handle.current?.scrollIntoView({ index: revealIndex });
  }, [revealIndex]);
  const moveCursor = (index: number, reveal = true) => {
    const item = items[index];
    if (!item) return;
    setCursorId(item.id);
    if (reveal) setRevealIndex(index);
  };

  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [available, setAvailable] = useState<number | null>(null);
  const [scrolledX, setScrolledX] = useState(false);
  useEffect(() => {
    if (scroller === null) return;
    const onScroll = () => setScrolledX(scroller.scrollLeft > 0);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    if (typeof ResizeObserver === "undefined") {
      return () => scroller.removeEventListener("scroll", onScroll);
    }
    const measure = () => setAvailable(scroller.clientWidth || null);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [scroller]);
  const focusGrid = () => scroller?.querySelector("table")?.focus({ preventScroll: true });

  const leading = canSelect ? CHECK_COLUMN_PX : 0;
  const trailing = columnsMenu === true ? MENU_COLUMN_PX : 0;
  // The Columns rail is the last column of the grid, counted like the others,
  // so every row has the same cells in the same numbered positions.
  const railIndex = columnsMenu === true ? allColumns.length + (canSelect ? 2 : 1) : undefined;
  const sized = visible.map((column) => ({ width: widthOf(column), grow: column.grow }));
  const layout = layoutColumns(sized, available === null ? null : available - leading - trailing);
  const minTableWidth =
    leading +
    trailing +
    visible.reduce((sum, column) => sum + (declaredPx(widthOf(column)) ?? UNSIZED_MIN_PX), 0);
  const sticky = stickyFirstColumn === true && visible.length > 0;
  const firstId = visible[0]?.id;

  // Edits.
  const [edit, setEdit] = useState<CellEdit | null>(null);
  const [pending, setPending] = useState<Record<string, { draft: string; generation: number }>>({});
  // Saves that failed while the reader was editing elsewhere: the cell keeps
  // the draft and the error until it is edited again.
  const [failures, setFailures] = useState<Record<string, { draft: string; error: string }>>({});
  const saveGeneration = useRef(0);
  const latestSave = useRef(new Map<string, number>());
  const [message, setMessage] = useState("");
  const cellId = (key: RowKey, columnId: string) => `${typeof key}:${key}\u0000${columnId}`;
  const editableIn = (row: unknown) =>
    editableColumns.filter((column) => column.editable !== null && column.editable(row));
  const rowItemByKey = (key: RowKey): { item: DrawnRow; index: number } | null => {
    const index = items.findIndex((item) => item.kind === "row" && item.key === key);
    const item = items[index];
    return item?.kind === "row" ? { item, index } : null;
  };
  const beginEdit = (row: DrawnRow, column: RichColumn, draft?: string, error?: string) => {
    const failure = failures[cellId(row.key, column.id)];
    setEdit({
      key: row.key,
      columnId: column.id,
      draft: draft ?? failure?.draft ?? startValue(column, row.row),
      error: error ?? failure?.error,
    });
  };
  const nextEditable = (from: DrawnRow, columnId: string, move: "next" | "previous") => {
    const start = items.findIndex((item) => item.id === from.id);
    const step = move === "next" ? 1 : -1;
    for (let index = start; index >= 0 && index < items.length; index += step) {
      const item = items[index];
      if (item?.kind !== "row") continue;
      const cells = editableIn(item.row);
      if (cells.length === 0) continue;
      if (index === start) {
        const at = cells.findIndex((column) => column.id === columnId);
        const candidate = cells[at + step];
        if (at >= 0 && candidate) return { item, index, column: candidate };
        continue;
      }
      const column = move === "next" ? cells[0] : cells[cells.length - 1];
      if (column) return { item, index, column };
    }
    return null;
  };
  const commitEdit = (draft: string, move: CellMove): boolean => {
    if (!edit) return true;
    const located = rowItemByKey(edit.key);
    const column = visible.find((candidate) => candidate.id === edit.columnId);
    if (!located || !column) {
      setEdit(null);
      return true;
    }
    const { item } = located;
    const id = cellId(item.key, column.id);
    if (failures[id]) setFailures((map) => omitKey(map, id));
    const refusal = column.validate?.(draft, item.row);
    if (refusal) {
      setEdit({ ...edit, draft, error: refusal });
      setMessage(refusal);
      return false;
    }
    const target = move ? nextEditable(item, column.id, move) : null;
    const leave = () => {
      if (target) {
        moveCursor(target.index);
        beginEdit(target.item, target.column);
      } else {
        setEdit(null);
        focusGrid();
      }
    };
    if ((draft === startValue(column, item.row) && edit.error === undefined) || !cellEdit) {
      leave();
      return true;
    }
    const failed: CellEdit = { key: item.key, columnId: column.id, draft, error: undefined };
    let result: unknown;
    try {
      result = cellEdit(item.row, column.id, draft);
    } catch (error) {
      // A save that throws at once is a failed save: the editor stays where it
      // is, focused, on the draft.
      const text = errorMessage(error);
      setMessage(text);
      setEdit({ ...failed, error: text });
      return false;
    }
    leave();
    if (!isThenable(result)) return true;
    // Each save of a cell is its own generation: only the newest one settles
    // the cell, so an older save landing late cannot clear a newer one's
    // spinner or bring back a draft the newer save replaced.
    saveGeneration.current += 1;
    const generation = saveGeneration.current;
    latestSave.current.set(id, generation);
    setPending((map) => ({ ...map, [id]: { draft, generation } }));
    const settleSave = (error: unknown, failedSave: boolean) => {
      setPending((map) => (map[id]?.generation === generation ? omitKey(map, id) : map));
      if (!failedSave) return;
      const text = errorMessage(error);
      setMessage(text);
      if (latestSave.current.get(id) !== generation) return;
      // Reopen only into an idle table. An edit the reader has moved on to
      // keeps its draft, and the failed cell keeps its own, marked, until
      // it is edited again.
      setFailures((map) => ({ ...map, [id]: { draft, error: text } }));
      // Reopening focuses the field, so it happens only while the reader is
      // still in this table; anywhere else the marked cell waits for them.
      const active = typeof document === "undefined" ? null : document.activeElement;
      if (scroller === null || active === null || !scroller.contains(active)) return;
      setEdit((current) => current ?? { ...failed, error: text });
    };
    Promise.resolve(result).then(
      () => settleSave(undefined, false),
      (error: unknown) => settleSave(error, true)
    );
    return true;
  };
  // An editor opened (or reached by Tab) under the pinned column or the
  // Columns rail is scrolled out from under them.
  const editKey = edit === null ? null : cellId(edit.key, edit.columnId);
  useEffect(() => {
    if (editKey !== null && scroller !== null) revealEditCell(scroller, trailing);
  }, [editKey, scroller, trailing]);
  const cancelEdit = () => {
    setEdit(null);
    focusGrid();
  };
  const editRow = (index: number) => {
    const item = items[index];
    if (item?.kind !== "row") return false;
    const cells = editableIn(item.row);
    const column = cells[0];
    if (!column) return false;
    beginEdit(item, column);
    return true;
  };

  // Expansion.
  // Closing a branch the cursor is inside moves the cursor up to it, so the
  // keyboard never loses its place to a row that just disappeared.
  const cursorItem = activeIndex >= 0 ? items[activeIndex] : undefined;
  const cursorUnder = (ancestor: RowKey): boolean => {
    let parent =
      cursorItem?.kind === "row" || cursorItem?.kind === "status" ? cursorItem.parentKey : null;
    for (let guard = 0; parent !== null && guard < 64; guard += 1) {
      if (parent === ancestor) return true;
      const above = items.find((item) => item.kind === "row" && item.key === parent);
      parent = above?.kind === "row" ? above.parentKey : null;
    }
    return false;
  };
  const toggleGroup = (groupKey: string, open: boolean) => {
    const isOpen = !collapsed.includes(groupKey);
    if (isOpen === open) return;
    if (!open && cursorItem?.kind === "row" && cursorItem.groupKey === groupKey) {
      setCursorId(`group:${groupKey}`);
    } else if (!open && cursorItem?.kind === "status") {
      const owner = items.find((item) => item.kind === "row" && item.key === cursorItem.parentKey);
      if (owner?.kind === "row" && owner.groupKey === groupKey) setCursorId(`group:${groupKey}`);
    }
    setCollapsed(open ? collapsed.filter((key) => key !== groupKey) : [...collapsed, groupKey]);
  };
  const toggleRow = (row: DrawnRow, open: boolean) => {
    if (!row.expandable || row.expanded === open) return;
    if (!open && cursorUnder(row.key)) setCursorId(row.id);
    setExpanded(open ? [...expanded, row.key] : expanded.filter((key) => key !== row.key));
  };

  const activate = (index: number) => {
    const item = items[index];
    if (item?.kind === "row") rowClick?.(item.row, item.index);
  };

  const onRowClickAt = (index: number, event: MouseEvent<HTMLTableRowElement>) => {
    const item = items[index];
    if (!item || !interactive) return;
    moveCursor(index, false);
    if (item.kind === "group") {
      toggleGroup(item.groupKey, item.collapsed);
      return;
    }
    if (item.kind !== "row") return;
    const primary = isMac() ? event.metaKey : event.ctrlKey;
    if (canSelect && selectableRow(item.row) && (event.shiftKey || primary)) {
      selection.handleSelect(item.key, event);
      return;
    }
    if (rowClick) activate(index);
    else if (canSelect && selectableRow(item.row)) selection.select(item.key);
  };

  // The entries outlive the close so the menu does not empty while it animates out.
  const [menu, setMenu] = useState<{ index: number; items: readonly unknown[]; open: boolean }>({
    index: -1,
    items: [],
    open: false,
  });
  const openRowMenu = (event: MouseEvent<HTMLElement>) => {
    const target = event.target instanceof Element ? event.target.closest("tr[data-index]") : null;
    const index =
      target !== null && target.parentElement === event.currentTarget
        ? Number(target.getAttribute("data-index"))
        : -1;
    const item = Number.isInteger(index) ? items[index] : undefined;
    const entries =
      item?.kind === "row" ? attempt(() => menuFor?.(item.row, item.index), null) : undefined;
    if (!Array.isArray(entries) || entries.length === 0) {
      event.preventDefault();
      return;
    }
    stopContextMenuPropagation(event);
    moveCursor(index, false);
    setMenu({ index, items: entries, open: true });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    if (event.target !== event.currentTarget) return;
    const item = activeIndex >= 0 ? items[activeIndex] : undefined;
    if (menuFor && isMenuKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      const row = activeIndex >= 0 ? document.getElementById(rowId(activeIndex)) : null;
      if (row === null) return;
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(
        new globalThis.MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 8,
          clientY: rect.top + rect.height / 2,
        })
      );
      return;
    }
    const primary = isMac() ? event.metaKey : event.ctrlKey;
    if (primary && !event.altKey && event.key.toLowerCase() === "a" && canSelect) {
      event.preventDefault();
      selection.selectAll();
      return;
    }
    if (primary && event.key === "Enter" && item?.kind === "row") {
      event.preventDefault();
      activate(activeIndex);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || items.length === 0) return;
    if (event.key === "Escape" && canSelect && selection.count > 0) {
      event.preventDefault();
      event.stopPropagation();
      selection.clear();
      return;
    }
    const last = items.length - 1;
    const from = activeIndex;
    let next: number | null = null;
    if (event.key === "ArrowDown") next = from < 0 ? 0 : Math.min(from + 1, last);
    else if (event.key === "ArrowUp") next = from < 0 ? last : Math.max(from - 1, 0);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next !== null) {
      event.preventDefault();
      moveCursor(next);
      const target = items[next];
      if (event.shiftKey && canSelect && target?.kind === "row" && selectableRow(target.row)) {
        if (selection.anchor === null && item?.kind === "row" && selectableRow(item.row)) {
          selection.select(item.key);
        }
        selection.selectRange(target.key);
      }
      return;
    }
    if (!item) return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (item.kind === "group" && item.collapsed) toggleGroup(item.groupKey, true);
      else if (item.kind === "group") moveCursor(Math.min(from + 1, last));
      else if (item.kind === "row" && item.expandable && !item.expanded) toggleRow(item, true);
      else if (item.kind === "row" && item.expanded) moveCursor(Math.min(from + 1, last));
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (item.kind === "group") {
        toggleGroup(item.groupKey, false);
        return;
      }
      if (item.kind === "row" && item.expanded) {
        toggleRow(item, false);
        return;
      }
      const parentKey = item.kind === "row" ? item.parentKey : item.parentKey;
      const parentIndex =
        parentKey !== null
          ? items.findIndex((candidate) => candidate.kind === "row" && candidate.key === parentKey)
          : item.kind === "row" && item.groupKey !== null
            ? items.findIndex(
                (candidate) => candidate.kind === "group" && candidate.groupKey === item.groupKey
              )
            : -1;
      if (parentIndex >= 0) moveCursor(parentIndex);
      return;
    }
    if (item.kind === "group" && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      // Space selects a selectable group's rows, as it does a row's; Enter folds.
      if (event.key === " " && groupKeys(item).length > 0) toggleGroupSelection(item);
      else toggleGroup(item.groupKey, item.collapsed);
      return;
    }
    if (item.kind === "status") {
      if ((event.key === "Enter" || event.key === " ") && item.status === "error") {
        event.preventDefault();
        forgetLazyChildren(lazyScope, item.parentRow);
      }
      return;
    }
    if (item.kind !== "row") return;
    if (event.key === "F2") {
      event.preventDefault();
      editRow(from);
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      if (canSelect && selectableRow(item.row)) selection.toggle(item.key);
      else activate(from);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (!editRow(from)) activate(from);
    }
  };

  const label = str(ariaLabel) ?? "";
  const role = tree || groupOf ? "treegrid" : "grid";
  const tableProps: Record<string, unknown> = interactive
    ? {
        role,
        "aria-label": label,
        "aria-rowcount": items.length + 1,
        "aria-colcount": railIndex ?? allColumns.length + (canSelect ? 1 : 0),
        "aria-multiselectable": canSelect ? true : undefined,
        tabIndex: 0,
        "aria-activedescendant": activeMounted(activeIndex, range) ? rowId(activeIndex) : undefined,
        ...(menuFor ? { "data-row-menu": "" } : {}),
        onKeyDown,
        onFocus: (event: FocusEvent<HTMLTableElement>) => {
          if (event.target !== event.currentTarget || items.length === 0) return;
          const at = activeIndex < 0 ? 0 : activeIndex;
          if (activeIndex < 0) moveCursor(0, false);
          if (!activeMounted(at, range)) handle.current?.scrollIntoView({ index: at });
        },
      }
    : {
        "aria-label": label,
        "aria-rowcount": items.length + 1,
        "aria-colcount": railIndex ?? allColumns.length + (canSelect ? 1 : 0),
      };

  const context: RichContext = {
    items,
    columns: visible,
    interactive,
    selectable: canSelect,
    activeIndex,
    isSelected,
    rowId,
    tableProps,
    tableStyle: {
      tableLayout: "fixed",
      width: "100%",
      minWidth: minTableWidth,
      borderCollapse: "collapse",
    },
    scrolledX,
    treegrid: role === "treegrid" && interactive,
    groupSelected: (group) => (groupKeys(group).length > 0 ? groupState(group) === true : null),
    onRowClick: onRowClickAt,
    menuIndex: menu.open ? menu.index : -1,
    openRowMenu: menuFor ? openRowMenu : undefined,
  };

  if (data.length === 0 && hasContent(empty)) {
    return (
      <div {...rootAttributes} className={cn("h-full", str(className))}>
        {node(empty)}
      </div>
    );
  }

  const stickyStyle = (column: RichColumn): CSSProperties | undefined =>
    sticky && column.id === firstId ? { left: leading } : undefined;
  const stickyClass = (column: RichColumn) =>
    sticky && column.id === firstId ? "kit-dt-sticky" : undefined;
  // The pinned column's trailing edge, drawn once something scrolls under it.
  const stickyEdge = (column: RichColumn) =>
    sticky && column.id === firstId ? { "data-sticky-edge": "" } : null;

  const selectableKeysShown = selectionIds;
  const shownSelected = selectableKeysShown.filter((key) => selection.isSelected(key)).length;
  const headerChecked: boolean | "indeterminate" =
    shownSelected === 0
      ? false
      : shownSelected === selectableKeysShown.length
        ? true
        : "indeterminate";

  // Logical column positions: hidden columns keep their numbers, so a reader
  // hears "column 6" for Created whichever columns are shown.
  const colOffset = canSelect ? 1 : 0;
  const colIndex = (column: RichColumn) =>
    allColumns.findIndex((candidate) => candidate.id === column.id) + 1 + colOffset;

  const header = () => (
    <tr aria-rowindex={1}>
      {canSelect ? (
        <th
          scope="col"
          aria-colindex={1}
          style={{ width: CHECK_COLUMN_PX, ...(sticky ? { left: 0 } : null) }}
          className={cn("border-b border-divider bg-surface-canvas p-0", sticky && "kit-dt-sticky")}
        >
          <span className="flex h-full items-center justify-center">
            <Checkbox
              size="sm"
              aria-label="Select all rows"
              disabled={selectableKeysShown.length === 0}
              checked={headerChecked}
              onCheckedChange={() => {
                if (headerChecked === true) selection.clear();
                else selection.selectAll();
              }}
            />
          </span>
        </th>
      ) : null}
      {visible.map((column, columnIndex) => {
        const width = layout.widths[columnIndex];
        const direction = current?.columnId === column.id ? current.direction : undefined;
        return (
          <th
            key={column.id}
            scope="col"
            aria-colindex={colIndex(column)}
            // Named by its label alone: the resize handle inside has a name of its own.
            aria-labelledby={column.resizable ? `${baseId}h-${columnIndex}` : undefined}
            aria-sort={
              column.sortable
                ? direction === "asc"
                  ? "ascending"
                  : direction === "desc"
                    ? "descending"
                    : "none"
                : undefined
            }
            {...stickyEdge(column)}
            style={{ ...(width === undefined ? null : { width }), ...stickyStyle(column) }}
            className={cn(
              "relative border-b border-divider bg-surface-canvas px-3 py-1.5 font-medium text-text-secondary",
              ALIGN_CLASS[column.align],
              stickyClass(column)
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
                <span id={`${baseId}h-${columnIndex}`} className="truncate">
                  {column.header}
                </span>
                <SortGlyph direction={direction} />
              </button>
            ) : (
              <span id={`${baseId}h-${columnIndex}`} className="block truncate">
                {column.header}
              </span>
            )}
            {column.resizable ? (
              <ColumnResizeHandle
                column={column}
                width={declaredPx(widthOf(column))}
                onResize={(px, final) => {
                  if (!final) {
                    setDragWidth({ id: column.id, px });
                    return;
                  }
                  setDragWidth(null);
                  setWidths({ ...widths, [column.id]: px });
                }}
                onReset={() => setWidths(omitKey(widths, column.id))}
              />
            ) : null}
          </th>
        );
      })}
      {layout.filler ? (
        <th aria-hidden="true" className="border-b border-divider bg-surface-canvas p-0" />
      ) : null}
      {columnsMenu === true ? (
        <th
          scope="col"
          aria-colindex={railIndex}
          style={{ width: MENU_COLUMN_PX, right: 0 }}
          className="kit-dt-sticky border-b border-divider bg-surface-canvas p-0"
        >
          <span className="flex h-full items-center justify-center">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Columns"
                  className="text-text-secondary"
                >
                  <Columns3 aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent {...owner} align="end" className={overlayZ}>
                <DropdownMenuLabel>Columns</DropdownMenuLabel>
                {allColumns.map((column) => {
                  const shown = visible.some((candidate) => candidate.id === column.id);
                  const lastShown = shown && visible.length === 1;
                  return (
                    <DropdownMenuCheckboxItem
                      key={column.id}
                      checked={shown}
                      disabled={!column.hideable || lastShown}
                      // Several columns are usually toggled at once: the menu stays open.
                      onSelect={(event) => event.preventDefault()}
                      onCheckedChange={(checked) =>
                        setHidden(
                          checked === true
                            ? hidden.filter((id) => id !== column.id)
                            : [...hidden, column.id]
                        )
                      }
                    >
                      {column.menuLabel}
                    </DropdownMenuCheckboxItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </th>
      ) : null}
    </tr>
  );

  const fullSpan =
    visible.length + (canSelect ? 1 : 0) + (layout.filler ? 1 : 0) + (trailing ? 1 : 0);
  const labelFor = (groupKey: string, groupRows: readonly unknown[]): ReactNode => {
    const custom = fn(groupLabel);
    if (custom) {
      const given: unknown = attempt(() => custom(groupKey, groupRows), null);
      if (hasContent(given)) return node(given);
    }
    return groupKey === "" ? "None" : groupKey;
  };

  const renderGroup = (item: DrawnGroup) => {
    const keys = groupKeys(item);
    const state = groupState(item);
    const label = labelFor(item.groupKey, item.rows);
    return (
      <td colSpan={fullSpan} className="h-7 border-b border-divider bg-surface p-0">
        {/* The group's box sits in the checkbox column, over its rows' boxes,
            and its chevron where the rows' own chevrons start. */}
        <div className="sticky left-0 flex h-7 w-max max-w-full items-center">
          {canSelect ? (
            <span className="flex w-8 shrink-0 items-center justify-center">
              {keys.length > 0 ? (
                <span
                  role="checkbox"
                  aria-checked={state === "indeterminate" ? "mixed" : state}
                  aria-label={`Select ${typeof label === "string" ? label : item.groupKey || "None"}`}
                  tabIndex={-1}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleGroupSelection(item);
                  }}
                  className="flex h-6 w-6 items-center justify-center"
                >
                  <CheckboxGlyph size="sm" checked={state} />
                </span>
              ) : null}
            </span>
          ) : null}
          <span className="flex min-w-0 items-center gap-1.5 px-3">
            <TreeChevron
              expanded={!item.collapsed}
              onToggle={() => toggleGroup(item.groupKey, item.collapsed)}
            />
            <span className={cn(LIST_LABEL_CLASS, "min-w-0 truncate")}>{label}</span>
            <span className="text-3xs font-medium tabular-nums text-text-secondary">
              {item.rows.length}
            </span>
          </span>
        </div>
      </td>
    );
  };

  const renderStatus = (item: Extract<DrawnItem, { kind: "status" }>) => (
    <td colSpan={fullSpan} className="h-7 p-0">
      <div
        className="sticky left-0 flex h-7 w-max max-w-full items-center gap-1.5 px-3 text-text-secondary"
        style={{ paddingInlineStart: 12 + leading + item.depth * TREE_INDENT_PX + 20 }}
      >
        {item.status === "loading" ? (
          <GatedLoading />
        ) : (
          <>
            {severityGlyph("error", "h-3 w-3")}
            <span className="min-w-0 truncate">{item.message || "Couldn't load"}</span>
            <Button
              variant="ghost"
              size="xs"
              tabIndex={-1}
              onClick={(event) => {
                event.stopPropagation();
                forgetLazyChildren(lazyScope, item.parentRow);
              }}
            >
              Retry
            </Button>
          </>
        )}
      </div>
    </td>
  );

  const renderCell = (item: DrawnRow, column: RichColumn, columnIndex: number) => {
    const editing = edit !== null && edit.key === item.key && edit.columnId === column.id;
    const pendingDraft = pending[cellId(item.key, column.id)]?.draft;
    const failure = failures[cellId(item.key, column.id)];
    const canEditCell = column.editable !== null && column.editable(item.row);
    let content: ReactNode;
    if (editing) {
      content = (
        <CellEditor
          column={column}
          edit={edit}
          label={`Edit ${column.menuLabel}`}
          onDraft={(draft) => setEdit({ ...edit, draft })}
          onCommit={commitEdit}
          onCancel={cancelEdit}
        />
      );
    } else if (failure !== undefined) {
      content = (
        <span className="flex min-w-0 items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex shrink-0" aria-hidden="true">
                {severityGlyph("error", "h-3 w-3")}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="start">
              {failure.error}
            </TooltipContent>
          </Tooltip>
          <span className="min-w-0 truncate text-text-secondary">{failure.draft}</span>
          <span className="sr-only">{`Not saved: ${failure.error}`}</span>
        </span>
      );
    } else if (pendingDraft !== undefined) {
      const option = column.editOptions.find((entry) => entry.value === pendingDraft);
      content = (
        <span className="flex min-w-0 items-center gap-1.5 text-text-secondary" aria-busy="true">
          <span className="min-w-0 truncate">{option?.label ?? pendingDraft}</span>
          <GatedSpinner />
          <span className="sr-only">Saving</span>
        </span>
      );
    } else {
      content = attempt(() => cellValue(item.row, column, item.index), null);
    }
    const isTreeColumn = tree && columnIndex === 0;
    return (
      <td
        key={column.id}
        {...stickyEdge(column)}
        aria-colindex={colIndex(column)}
        aria-readonly={column.editable !== null && !canEditCell ? true : undefined}
        data-edit-cell={editing ? "" : undefined}
        style={stickyStyle(column)}
        onDoubleClick={
          canEditCell && !editing
            ? (event) => {
                event.stopPropagation();
                moveCursor(
                  items.findIndex((candidate) => candidate.id === item.id),
                  false
                );
                beginEdit(item, column);
              }
            : undefined
        }
        className={cn(
          "overflow-hidden text-ellipsis whitespace-nowrap px-3 py-1.5 text-text-primary",
          editing && "py-0.5 pl-1.5 pr-1.5",
          ALIGN_CLASS[column.align],
          stickyClass(column)
        )}
      >
        {isTreeColumn ? (
          <span
            className="flex min-w-0 items-center gap-1"
            style={{ paddingInlineStart: item.depth * TREE_INDENT_PX }}
          >
            {item.expandable ? (
              <TreeChevron
                expanded={item.expanded}
                onToggle={() => toggleRow(item, !item.expanded)}
              />
            ) : (
              <TreeGutter />
            )}
            <span className="min-w-0 flex-1 truncate">{content}</span>
          </span>
        ) : (
          content
        )}
      </td>
    );
  };

  const renderItem = (index: number) => {
    const item = items[index];
    if (!item) return null;
    if (item.kind === "group") return renderGroup(item);
    if (item.kind === "status") return renderStatus(item);
    const selected = canSelect && selection.isSelected(item.key);
    return [
      ...(canSelect
        ? [
            <td
              key={"\u0000check"}
              aria-colindex={1}
              style={sticky ? { left: 0 } : undefined}
              onClick={(event) => {
                event.stopPropagation();
                if (!selectableRow(item.row)) return;
                moveCursor(index, false);
                if (event.shiftKey) selection.selectRange(item.key, { additive: true });
                else selection.toggle(item.key);
              }}
              className={cn("p-0", sticky && "kit-dt-sticky")}
            >
              {selectableRow(item.row) ? (
                <span className="flex h-full items-center justify-center">
                  <CheckboxGlyph size="sm" checked={selected} />
                </span>
              ) : null}
            </td>,
          ]
        : []),
      ...visible.map((column, columnIndex) => renderCell(item, column, columnIndex)),
      ...(layout.filler ? [<td key={"\u0000filler"} aria-hidden="true" className="p-0" />] : []),
      // Under the Columns button the body keeps the same opaque edge, so a
      // column scrolling beneath it is cut on the same line in every row.
      ...(trailing
        ? [
            <td
              key={"\u0000menu"}
              aria-colindex={railIndex}
              style={{ right: 0 }}
              className="kit-dt-sticky p-0"
            />,
          ]
        : []),
    ];
  };

  const table = (
    <TableVirtuoso
      {...rootAttributes}
      ref={handle}
      scrollerRef={(element) => setScroller(element instanceof HTMLElement ? element : null)}
      className={cn(SCROLLER_RING_INSET, str(className))}
      style={{ height: "100%" }}
      data={items}
      context={context}
      components={RICH_COMPONENTS}
      defaultItemHeight={rowPx}
      increaseViewportBy={DEFAULT_OVERSCAN_ROWS * rowPx}
      computeItemKey={(index) => items[index]?.id ?? index}
      fixedHeaderContent={header}
      rangeChanged={setRange}
      itemContent={(index) => renderItem(index)}
      endReached={endReached ? (index) => endReached(index) : undefined}
      onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
        // Rows never take focus (they unmount as they scroll), so a click in
        // the body pulls it to the grid and the keys keep working.
        const target = event.target instanceof Element ? event.target : null;
        if (!interactive || !target?.closest("tbody")) return;
        if (target.closest("input, button, select, textarea, [role=combobox]")) return;
        if (edit) return;
        requestAnimationFrame(() => {
          // A double-click opens an editor between this press and the frame;
          // pulling focus to the grid then would blur and commit it.
          const active = document.activeElement;
          if (active instanceof HTMLElement && active.closest("td")) return;
          focusGrid();
        });
      }}
    />
  );
  const withStatus = (
    <>
      {table}
      <span className="sr-only" role="status" aria-live="polite">
        {message}
      </span>
    </>
  );
  if (!menuFor) return withStatus;
  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (!open) setMenu((state) => ({ ...state, open: false }));
      }}
    >
      {withStatus}
      <ContextMenuContent {...owner} className={overlayZ}>
        {renderMenuEntries(CONTEXT_MENU_PARTS, menu.items)}
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface SavedTableState {
  widths: Record<string, number>;
  hidden: string[];
  collapsed: string[];
  expanded: RowKey[];
}

// `viewStateKey` remembers the reader's layout through the view's persisted
// bag; anything the plugin controls itself still wins.
function PersistedDataTable(props: PluginDataTableProps & { viewStateKey: string }) {
  const [saved, setSaved] = usePersistentViewState<SavedTableState>(
    `dataTable:${props.viewStateKey}`,
    () => ({
      widths: widthRecord(props.defaultColumnWidths) ?? {},
      hidden: stringList(props.defaultHiddenColumns) ?? [],
      collapsed: stringList(props.defaultCollapsedGroups) ?? [],
      expanded: keyList(props.defaultExpandedRowKeys) ?? [],
    })
  );
  const widths = widthRecord(saved.widths) ?? {};
  const hidden = stringList(saved.hidden) ?? [];
  const collapsed = stringList(saved.collapsed) ?? [];
  const expanded = keyList(saved.expanded) ?? [];
  return (
    <RichDataTable
      {...props}
      columnWidths={props.columnWidths ?? widths}
      onColumnWidthsChange={(next) => {
        setSaved((state) => ({ ...state, widths: next }));
        fn(props.onColumnWidthsChange)?.(next);
      }}
      hiddenColumns={props.hiddenColumns ?? hidden}
      onHiddenColumnsChange={(next) => {
        setSaved((state) => ({ ...state, hidden: next }));
        fn(props.onHiddenColumnsChange)?.(next);
      }}
      collapsedGroups={props.collapsedGroups ?? collapsed}
      onCollapsedGroupsChange={(next) => {
        setSaved((state) => ({ ...state, collapsed: next }));
        fn(props.onCollapsedGroupsChange)?.(next);
      }}
      expandedRowKeys={props.expandedRowKeys ?? expanded}
      onExpandedRowKeysChange={(next) => {
        setSaved((state) => ({ ...state, expanded: next }));
        fn(props.onExpandedRowKeysChange)?.(next);
      }}
    />
  );
}

/**
 * The kit's DataTable: the basic table until a plugin asks for selection,
 * groups, sub-rows, column sizing or editing, then the rich one, drawn from
 * the same rows, header and cells.
 */
function KitDataTable(props: PluginDataTableProps) {
  if (!usesRichDataTable(props)) return <BasicDataTable {...props} />;
  const key = nonEmpty(props.viewStateKey);
  if (key) return <PersistedDataTable {...props} viewStateKey={key} />;
  return <RichDataTable {...props} />;
}

export const pluginKitDataTables = {
  DataTable: KitDataTable,
  ...pluginKitTreeView,
  ...pluginKitObjectInspector,
};
