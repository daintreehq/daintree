import { useState } from "react";
import { TableVirtuoso } from "react-virtuoso";
import type { PluginDataTableProps } from "@shared/types/plugin-sdk-react";
import { ContextMenu, ContextMenuContent } from "@/components/ui/context-menu-base";
import { cn } from "@/lib/utils";
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
import { CONTEXT_MENU_PARTS, renderMenuEntries } from "./kitMenu";
import { useKitOverlayZClass } from "./kitScope";
import {
  activeMounted,
  DEFAULT_OVERSCAN_ROWS,
  DENSITY_ROW_PX,
  pluginKitLists,
  reactKey,
  readDensity,
  readSort,
  SCROLLER_RING_INSET,
} from "./PluginKitLists";
import {
  buildTableItems,
  groupKeyOf,
  readTotals,
  type RowKey,
  type SubRows,
} from "./kitDataTableModel";
import { peekLazyChildren, readLazyChildren, useLazyScope } from "./kitLazyChildren";
import { pluginKitTreeView } from "./PluginKitTreeView";
import { pluginKitObjectInspector } from "./PluginKitObjectInspector";
import "./kitDataTable.css";
import { attempt, keyList, stringList, useControllable, widthRecord } from "./kitDataTableShared";
import { readRichColumns, useDataTableColumns, useDataTableLayout } from "./kitDataTableColumns";
import { useDataTableSelection } from "./kitDataTableSelection";
import { useDataTableCursor, useDataTableInteractions } from "./kitDataTableNavigation";
import { useDataTableEditing } from "./kitDataTableEditing";
import {
  PlainTableSections,
  RICH_COMPONENTS,
  RichTableElement,
  type RichContext,
} from "./kitDataTableRows";
import { richTableRenderers } from "./kitDataTableRendering";

const BasicDataTable = pluginKitLists.DataTable;

function isRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a table needs anything past the basic DataTable. Exported for tests.
 * A sizing or visibility prop counts once it is given, empty or not: clearing
 * `hiddenColumns` must not swap the table for the basic one and lose its focus
 * and scroll mid-update.
 */
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
    isRecord(read("columnWidths")) ||
    isRecord(read("defaultColumnWidths")) ||
    Array.isArray(read("hiddenColumns")) ||
    Array.isArray(read("defaultHiddenColumns")) ||
    read("columnsMenu") === true ||
    nonEmpty(read("viewStateKey")) !== undefined ||
    read("stickyFirstColumn") === true ||
    read("virtualize") === false
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
    virtualize,
    density,
    rowDividers,
    striped,
    totals,
    totalsLabel,
    editAffordance,
    groupTotals,
    groupCount,
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
  const overlayZ = useKitOverlayZClass();
  const owner = useKitOwnerAttributes();
  const plain = virtualize === false;
  const size = readDensity(density);
  const dividers = rowDividers === true;
  const stripes = striped === true;
  const editCue = oneOf(editAffordance, ["hover", "none"] as const) !== "none";
  const footTotals = readTotals(totals);
  const subtotals = readTotals(groupTotals);
  const rowPx = positive(estimatedRowSize, 10_000) ?? DENSITY_ROW_PX[size];
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

  const columnState = useDataTableColumns(allColumns, {
    hiddenColumns,
    defaultHiddenColumns,
    onHiddenColumnsChange,
    columnWidths,
    defaultColumnWidths,
    onColumnWidthsChange,
  });
  const { visible, widthOf } = columnState;

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
  // Re-reads the lazy cache when one of this instance's loads settles.
  const { scope: lazyScope, revision: lazyRevision } = useLazyScope();
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

  const rowSelection = useDataTableSelection(items, {
    selectable,
    selectedRowKeys,
    defaultSelectedRowKeys,
    onSelectedRowKeysChange,
    selectedRowKey,
  });
  const { canSelect, isSelected, groupKeys, groupState } = rowSelection;

  const cursor = useDataTableCursor(items, plain);
  const { activeIndex, baseId, rowId, handle, range, setRange, moveCursor } = cursor;

  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const focusGrid = () => scroller?.querySelector("table")?.focus({ preventScroll: true });

  const geometry = useDataTableLayout({
    scroller,
    allColumns,
    visible,
    widthOf,
    canSelect,
    columnsMenu,
    stickyFirstColumn,
  });
  const { available, scrolledX, trailing, railIndex, minTableWidth } = geometry;

  const editing = useDataTableEditing({
    items,
    visible,
    onCellEdit,
    scroller,
    trailing,
    moveCursor,
    focusGrid,
  });
  const { canEdit, message } = editing;
  const interactive =
    rowClick !== undefined || menuFor !== undefined || canSelect || tree || !!groupOf || canEdit;

  const {
    toggleGroup,
    toggleRow,
    onRowClickAt,
    menu,
    closeMenu,
    openRowMenu,
    onKeyDown,
    onFocus,
    onPointerDown,
  } = useDataTableInteractions({
    items,
    cursor,
    rowSelection,
    editing,
    scroller,
    focusGrid,
    plain,
    interactive,
    collapsed,
    setCollapsed,
    expanded,
    setExpanded,
    lazyScope,
    rowClick,
    menuFor,
  });

  const label = str(ariaLabel) ?? "";
  const role = tree || groupOf ? "treegrid" : "grid";
  // The header, every drawn item, and the totals row.
  const rowCount = items.length + 1 + (footTotals ? 1 : 0);
  const tableProps: Record<string, unknown> = interactive
    ? {
        role,
        "aria-label": label,
        "aria-rowcount": rowCount,
        "aria-colcount": railIndex ?? allColumns.length + (canSelect ? 1 : 0),
        "aria-multiselectable": canSelect ? true : undefined,
        tabIndex: 0,
        "aria-activedescendant": activeMounted(activeIndex, range) ? rowId(activeIndex) : undefined,
        ...(menuFor ? { "data-row-menu": "" } : {}),
        onKeyDown,
        onFocus,
      }
    : {
        "aria-label": label,
        "aria-rowcount": rowCount,
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
    density: size,
    striped: stripes,
  };

  if (data.length === 0 && hasContent(empty)) {
    return (
      <div {...rootAttributes} className={cn(!plain && "h-full", str(className))}>
        {node(empty)}
      </div>
    );
  }

  const { header, renderItem, footer } = richTableRenderers({
    items,
    data,
    allColumns,
    columns: columnState,
    geometry,
    rowSelection,
    editing,
    baseId,
    moveCursor,
    toggleGroup,
    toggleRow,
    lazyScope,
    tree,
    size,
    dividers,
    stripes,
    editCue,
    overlayZ,
    owner,
    sort: current,
    onSort: handleSort,
    columnsMenu,
    groupLabel,
    groupCount,
    subtotals,
    footTotals,
    totalsLabel,
    rowCount,
  });

  // Every row drawn, as tall as its rows: the table sizes to its content and
  // only scrolls sideways, when its columns are wider than the pane.
  const table = plain ? (
    <div
      {...rootAttributes}
      ref={setScroller}
      tabIndex={interactive || available === null || minTableWidth <= available ? undefined : 0}
      className={cn(SCROLLER_RING_INSET, "overflow-x-auto", str(className))}
      onPointerDown={onPointerDown}
    >
      <RichTableElement context={context} style={{ borderSpacing: 0 }}>
        <PlainTableSections
          context={context}
          header={header}
          footer={footer}
          renderItem={renderItem}
        />
      </RichTableElement>
    </div>
  ) : (
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
      fixedFooterContent={footer}
      rangeChanged={setRange}
      itemContent={(index) => renderItem(index)}
      endReached={endReached ? (index) => endReached(index) : undefined}
      onPointerDown={onPointerDown}
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
        if (!open) closeMenu();
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
 * the same rows, header and cells. A `viewStateKey` names the saved view, so
 * a different key is a different table and starts from that key's state.
 */
function KitDataTable(props: PluginDataTableProps) {
  if (!usesRichDataTable(props)) return <BasicDataTable {...props} />;
  const key = nonEmpty(props.viewStateKey);
  if (key) return <PersistedDataTable key={key} {...props} viewStateKey={key} />;
  return <RichDataTable {...props} />;
}

export const pluginKitDataTables = {
  DataTable: KitDataTable,
  ...pluginKitTreeView,
  ...pluginKitObjectInspector,
};
