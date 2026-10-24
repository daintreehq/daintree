import type { ReactNode } from "react";
import { Columns3, Pencil } from "lucide-react";
import type { PluginDataTableProps, PluginDataTableSort } from "@shared/types/plugin-sdk-react";
import { Button } from "@/components/ui/button";
import { Checkbox, CheckboxGlyph } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu-base";
import { LIST_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { fn, hasContent, node } from "./kitProps";
import {
  bodyCellClass,
  cellValue,
  fromCellControl,
  headerCellClass,
  rowRuleClass,
  SortGlyph,
  totalContent,
  TOTALS_CELL_CLASS,
  totalsLabelFor,
  type TableDensity,
} from "./PluginKitLists";
import {
  declaredPx,
  type DrawnGroup,
  type DrawnItem,
  type DrawnRow,
  type TotalSpec,
} from "./kitDataTableModel";
import { forgetLazyChildren, type LazyScope } from "./kitLazyChildren";
import { GatedLoading, GatedSpinner, TREE_INDENT_PX, TreeChevron, TreeGutter } from "./kitTreeRow";
import { severityGlyph } from "./PluginKitPatterns";
import { attempt } from "./kitDataTableShared";
import {
  CHECK_COLUMN_PX,
  MENU_COLUMN_PX,
  type DataTableColumns,
  type DataTableLayout,
  type RichColumn,
} from "./kitDataTableColumns";
import { ColumnResizeHandle } from "./kitDataTableResize";
import { CellEditor, cellId, type DataTableEditing } from "./kitDataTableEditing";
import type { DataTableSelection } from "./kitDataTableSelection";

/** A group header or loading row, as tall as a data row at the same density. */
const DENSITY_BAND_CLASS: Record<TableDensity, string> = {
  compact: "h-6",
  default: "h-7",
  comfortable: "h-8",
};

/** An editing cell's padding: the 24px field fills the row at every density. */
const DENSITY_EDIT_CELL_CLASS: Record<TableDensity, string> = {
  compact: "py-0 ps-1.5",
  default: "py-0.5 ps-1.5",
  comfortable: "py-1 ps-1.5",
};

/**
 * The edit cue's pencil sits inside the cell's own 12px end padding, so an
 * editable column keeps exactly the geometry it had before the cue existed and
 * figures never move when it shows.
 */
const EDIT_CUE_GLYPH_CLASS =
  "kit-dt-edit-glyph pointer-events-none absolute end-0.5 top-1/2 h-2.5 w-2.5 -translate-y-1/2 text-text-secondary opacity-0 transition-opacity duration-150 ease-out motion-reduce:transition-none";

const totalCell = (spec: TotalSpec, over: readonly unknown[], column: RichColumn): ReactNode =>
  attempt(() => totalContent(spec, over, column), null);

export interface DataTableRenderInput {
  items: readonly DrawnItem[];
  /** The rows as given: the totals row sums over exactly these. */
  data: readonly unknown[];
  allColumns: readonly RichColumn[];
  columns: DataTableColumns;
  geometry: DataTableLayout;
  rowSelection: DataTableSelection;
  editing: DataTableEditing;
  baseId: string;
  moveCursor: (index: number, reveal?: boolean) => void;
  toggleGroup: (groupKey: string, open: boolean) => void;
  toggleRow: (row: DrawnRow, open: boolean) => void;
  lazyScope: LazyScope;
  tree: boolean;
  size: TableDensity;
  dividers: boolean;
  stripes: boolean;
  editCue: boolean;
  overlayZ: string | undefined;
  owner: Record<string, string>;
  sort: PluginDataTableSort | null;
  onSort: ((sort: PluginDataTableSort) => void) | undefined;
  columnsMenu: boolean | undefined;
  groupLabel: PluginDataTableProps["groupLabel"];
  groupCount: boolean | undefined;
  subtotals: Map<string, TotalSpec> | null;
  footTotals: Map<string, TotalSpec> | null;
  totalsLabel: ReactNode;
  /** The header, every drawn item, and the totals row. */
  rowCount: number;
}

export interface DataTableRenderers {
  header: () => ReactNode;
  renderItem: (index: number) => ReactNode;
  footer: (() => ReactNode) | undefined;
}

/** The header, each drawn item's cells, and the totals row, for either table to draw. */
export function richTableRenderers(input: DataTableRenderInput): DataTableRenderers {
  const {
    items,
    data,
    allColumns,
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
  } = input;
  const { visible, widthOf, resizeColumn, resetColumnWidth, showColumn } = input.columns;
  const {
    leading,
    trailing,
    railIndex,
    layout,
    sticky,
    fullSpan,
    colIndex,
    stickyStyle,
    stickyClass,
    stickyEdge,
  } = input.geometry;
  const {
    canSelect,
    selection,
    selectableRow,
    groupKeys,
    groupState,
    toggleGroupSelection,
    selectionIds,
    headerChecked,
  } = input.rowSelection;
  const { edit, pending, failures, beginEdit, changeDraft, commitEdit, cancelEdit } = input.editing;

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
              disabled={selectionIds.length === 0}
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
            className={cn("relative", headerCellClass(column, size), stickyClass(column))}
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
                onResize={(px, final) => resizeColumn(column.id, px, final)}
                onReset={() => resetColumnWidth(column.id)}
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
                      onCheckedChange={(checked) => showColumn(column.id, checked === true)}
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

  const labelFor = (groupKey: string, groupRows: readonly unknown[]): ReactNode => {
    const custom = fn(groupLabel);
    if (custom) {
      const given: unknown = attempt(() => custom(groupKey, groupRows), null);
      if (hasContent(given)) return node(given);
    }
    return groupKey === "" ? "None" : groupKey;
  };

  // A group's subtotals start at the first column after the first that has
  // one; the label runs across every column before it.
  const subtotalFrom = subtotals
    ? visible.findIndex((column, index) => index > 0 && subtotals.has(column.id))
    : -1;

  const renderGroup = (item: DrawnGroup, index: number) => {
    const keys = groupKeys(item);
    const state = groupState(item);
    const label = labelFor(item.groupKey, item.rows);
    const rules = rowRuleClass(index, dividers, false);
    const band = cn(DENSITY_BAND_CLASS[size], "border-b border-divider bg-surface", rules);
    const head = (
      <td
        key={"\u0000group"}
        colSpan={subtotalFrom > 0 ? subtotalFrom + (canSelect ? 1 : 0) : fullSpan}
        className={cn(band, "p-0")}
      >
        {/* The group's box sits in the checkbox column, over its rows' boxes,
            and its chevron where the rows' own chevrons start. */}
        <div
          className={cn(
            "sticky left-0 flex w-max max-w-full items-center",
            DENSITY_BAND_CLASS[size]
          )}
        >
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
            {groupCount === false ? null : (
              <span className="text-3xs font-medium tabular-nums text-text-secondary">
                {item.rows.length}
              </span>
            )}
          </span>
        </div>
      </td>
    );
    if (subtotalFrom <= 0 || !subtotals) return head;
    return [
      head,
      ...visible.slice(subtotalFrom).map((column) => {
        const spec = subtotals.get(column.id);
        return (
          <td
            key={column.id}
            aria-colindex={colIndex(column)}
            className={cn(band, bodyCellClass(column, size), "font-medium")}
          >
            {spec ? totalCell(spec, item.rows, column) : null}
          </td>
        );
      }),
      ...(layout.filler
        ? [<td key={"\u0000filler"} aria-hidden="true" className={cn(band, "p-0")} />]
        : []),
      ...(trailing
        ? [
            <td
              key={"\u0000menu"}
              aria-colindex={railIndex}
              style={{ right: 0 }}
              className={cn("kit-dt-sticky", band, "p-0")}
            />,
          ]
        : []),
    ];
  };

  const renderStatus = (item: Extract<DrawnItem, { kind: "status" }>, index: number) => (
    <td
      colSpan={fullSpan}
      className={cn(DENSITY_BAND_CLASS[size], "p-0", rowRuleClass(index, dividers, stripes))}
    >
      <div
        className={cn(
          "sticky left-0 flex w-max max-w-full items-center gap-1.5 px-3 text-text-secondary",
          DENSITY_BAND_CLASS[size]
        )}
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

  const renderCell = (item: DrawnRow, column: RichColumn, columnIndex: number, rules: string) => {
    const editing = edit !== null && edit.key === item.key && edit.columnId === column.id;
    const pendingDraft = pending[cellId(item.key, column.id)]?.draft;
    const failure = failures[cellId(item.key, column.id)];
    const canEditCell = column.editable !== null && column.editable(item.row);
    const cue =
      editCue && canEditCell && !editing && pendingDraft === undefined && failure === undefined;
    let content: ReactNode;
    if (editing) {
      content = (
        <CellEditor
          column={column}
          edit={edit}
          label={`Edit ${column.menuLabel}`}
          density={size}
          onDraft={changeDraft}
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
            <TooltipContent side="bottom" align="start" className={overlayZ}>
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
                if (fromCellControl(event)) return;
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
          bodyCellClass(column, size),
          editing ? [DENSITY_EDIT_CELL_CLASS[size], "pe-1.5"] : null,
          cue && "kit-dt-edit relative",
          rules,
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
        {cue ? <Pencil aria-hidden="true" className={EDIT_CUE_GLYPH_CLASS} /> : null}
      </td>
    );
  };

  const renderItem = (index: number) => {
    const item = items[index];
    if (!item) return null;
    if (item.kind === "group") return renderGroup(item, index);
    if (item.kind === "status") return renderStatus(item, index);
    const selected = canSelect && selection.isSelected(item.key);
    const rules = rowRuleClass(index, dividers, stripes);
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
              className={cn("p-0", rules, sticky && "kit-dt-sticky")}
            >
              {selectableRow(item.row) ? (
                <span className="flex h-full items-center justify-center">
                  <CheckboxGlyph size="sm" checked={selected} />
                </span>
              ) : null}
            </td>,
          ]
        : []),
      ...visible.map((column, columnIndex) => renderCell(item, column, columnIndex, rules)),
      ...(layout.filler
        ? [<td key={"\u0000filler"} aria-hidden="true" className={cn("p-0", rules)} />]
        : []),
      // Under the Columns button the body keeps the same opaque edge, so a
      // column scrolling beneath it is cut on the same line in every row.
      ...(trailing
        ? [
            <td
              key={"\u0000menu"}
              aria-colindex={railIndex}
              style={{ right: 0 }}
              className={cn("kit-dt-sticky p-0", rules)}
            />,
          ]
        : []),
    ];
  };

  const totalsLabelAt = footTotals ? totalsLabelFor(visible, footTotals, totalsLabel) : null;
  const footer = footTotals
    ? () => (
        <tr aria-rowindex={rowCount} data-totals-row="">
          {canSelect ? (
            <td
              aria-colindex={1}
              style={sticky ? { left: 0 } : undefined}
              className={cn(TOTALS_CELL_CLASS, "p-0", sticky && "kit-dt-sticky")}
            />
          ) : null}
          {visible.map((column) => {
            const spec = footTotals.get(column.id);
            return (
              <td
                key={column.id}
                {...stickyEdge(column)}
                aria-colindex={colIndex(column)}
                style={stickyStyle(column)}
                className={cn(bodyCellClass(column, size), TOTALS_CELL_CLASS, stickyClass(column))}
              >
                {spec
                  ? totalCell(spec, data, column)
                  : column.id === totalsLabelAt?.columnId
                    ? totalsLabelAt.label
                    : null}
              </td>
            );
          })}
          {layout.filler ? (
            <td aria-hidden="true" className={cn(TOTALS_CELL_CLASS, "p-0")} />
          ) : null}
          {trailing ? (
            <td
              aria-colindex={railIndex}
              style={{ right: 0 }}
              className={cn(TOTALS_CELL_CLASS, "kit-dt-sticky p-0")}
            />
          ) : null}
        </tr>
      )
    : undefined;

  return { header, renderItem, footer };
}
