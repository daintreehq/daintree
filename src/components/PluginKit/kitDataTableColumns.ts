import { useEffect, useState, type CSSProperties } from "react";
import type { PluginDataTableProps } from "@shared/types/plugin-sdk-react";
import { field, fn, nonEmpty, oneOf, positive, str } from "./kitProps";
import { layoutColumns, readColumns, type TableColumn } from "./PluginKitLists";
import { clampWidth, declaredPx } from "./kitDataTableModel";
import { attempt, omitKey, stringList, useControllable, widthRecord } from "./kitDataTableShared";

const DEFAULT_MIN_WIDTH = 48;
const DEFAULT_MAX_WIDTH = 1200;
/** What an unsized column counts as when the table works out whether it must scroll sideways. */
const UNSIZED_MIN_PX = 120;
export const CHECK_COLUMN_PX = 32;
export const MENU_COLUMN_PX = 32;

type EditorKind = "text" | "number" | "select";

export interface RichColumn extends TableColumn {
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

export function readRichColumns(columns: unknown): RichColumn[] {
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

export interface DataTableColumns {
  /** The columns drawn: never none, whatever a default or a restored layout hid. */
  visible: RichColumn[];
  widthOf: (column: RichColumn) => number | string | undefined;
  /** A drag reports `final` once, on release; until then the width only shows. */
  resizeColumn: (columnId: string, px: number, final: boolean) => void;
  resetColumnWidth: (columnId: string) => void;
  showColumn: (columnId: string, shown: boolean) => void;
}

type ColumnStateProps = Pick<
  PluginDataTableProps,
  | "hiddenColumns"
  | "defaultHiddenColumns"
  | "onHiddenColumnsChange"
  | "columnWidths"
  | "defaultColumnWidths"
  | "onColumnWidthsChange"
>;

/** Which columns show and how wide, each controlled or the table's own. */
export function useDataTableColumns(
  allColumns: readonly RichColumn[],
  {
    hiddenColumns,
    defaultHiddenColumns,
    onHiddenColumnsChange,
    columnWidths,
    defaultColumnWidths,
    onColumnWidthsChange,
  }: ColumnStateProps
): DataTableColumns {
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
  const resizeColumn = (columnId: string, px: number, final: boolean) => {
    if (!final) {
      setDragWidth({ id: columnId, px });
      return;
    }
    setDragWidth(null);
    setWidths({ ...widths, [columnId]: px });
  };
  const resetColumnWidth = (columnId: string) => setWidths(omitKey(widths, columnId));
  const showColumn = (columnId: string, shown: boolean) =>
    setHidden(shown ? hidden.filter((id) => id !== columnId) : [...hidden, columnId]);
  return { visible, widthOf, resizeColumn, resetColumnWidth, showColumn };
}

export interface DataTableLayout {
  /** The scroller's width, once measured. */
  available: number | null;
  scrolledX: boolean;
  /** The checkbox column's width, or 0. */
  leading: number;
  /** The Columns rail's width, or 0. */
  trailing: number;
  railIndex: number | undefined;
  layout: ReturnType<typeof layoutColumns>;
  minTableWidth: number;
  sticky: boolean;
  /** Every cell of a row, for one that spans it. */
  fullSpan: number;
  colIndex: (column: RichColumn) => number;
  stickyStyle: (column: RichColumn) => CSSProperties | undefined;
  stickyClass: (column: RichColumn) => string | undefined;
  stickyEdge: (column: RichColumn) => { "data-sticky-edge": string } | null;
}

/** The table's geometry: the scroller's width, the column widths in it, and what is pinned. */
export function useDataTableLayout({
  scroller,
  allColumns,
  visible,
  widthOf,
  canSelect,
  columnsMenu,
  stickyFirstColumn,
}: {
  scroller: HTMLElement | null;
  allColumns: readonly RichColumn[];
  visible: readonly RichColumn[];
  widthOf: DataTableColumns["widthOf"];
  canSelect: boolean;
  columnsMenu: boolean | undefined;
  stickyFirstColumn: boolean | undefined;
}): DataTableLayout {
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
  const stickyStyle = (column: RichColumn): CSSProperties | undefined =>
    sticky && column.id === firstId ? { left: leading } : undefined;
  const stickyClass = (column: RichColumn) =>
    sticky && column.id === firstId ? "kit-dt-sticky" : undefined;
  // The pinned column's trailing edge, drawn once something scrolls under it.
  const stickyEdge = (column: RichColumn) =>
    sticky && column.id === firstId ? { "data-sticky-edge": "" } : null;

  // Logical column positions: hidden columns keep their numbers, so a reader
  // hears "column 6" for Created whichever columns are shown.
  const colOffset = canSelect ? 1 : 0;
  const colIndex = (column: RichColumn) =>
    allColumns.findIndex((candidate) => candidate.id === column.id) + 1 + colOffset;
  const fullSpan =
    visible.length + (canSelect ? 1 : 0) + (layout.filler ? 1 : 0) + (trailing ? 1 : 0);
  return {
    available,
    scrolledX,
    leading,
    trailing,
    railIndex,
    layout,
    minTableWidth,
    sticky,
    fullSpan,
    colIndex,
    stickyStyle,
    stickyClass,
    stickyEdge,
  };
}
