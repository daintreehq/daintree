// Collections: virtual lists and grids, the data table, log views, list rows
// and keyboard navigation, grouped lists, file trees, the generic TreeView and
// the ObjectInspector for API responses and tool results.

import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import type {
  PluginAriaRootAttributes,
  PluginDomProps,
  PluginIconSource,
  PluginRootAttributes,
  PluginSeverity,
} from "./common.js";
import type { PluginSelectionGesture, PluginSelectionKey } from "./hooks.js";
import type { PluginSelectOption } from "./inputs.js";
import type { PluginLayoutGap } from "./layout.js";
import type { PluginDropdownMenuEntry } from "./overlays.js";

/**
 * Props of `VirtualList`: a windowed list that mounts only the rows in view,
 * so ten thousand items cost what forty do. It fills its container's height;
 * give the container one (`h-full` in a sized pane, or a fixed height).
 *
 * The DOM props land on the element that directly holds the rows. Spread
 * `useListNavigation().containerProps` here to make it a keyboard listbox; the
 * rows are then options (`getRowProps(index)` on each `ListRow`), and the DOM
 * props land on the scroller instead, which takes the keyboard. Either way that
 * element carries your `id` and `data-*` (a `data-testid` included). Without a
 * `role` it is a plain `list` and each row is a `listitem`.
 */
export interface PluginVirtualListBaseProps extends PluginDomProps<HTMLDivElement> {
  /** Expected row height in px, before rows are measured. Defaults to 28. */
  estimatedItemSize?: number;
  /** Rows rendered beyond each edge of the viewport. Defaults to 8. */
  overscan?: number;
  /** Called once the last row scrolls into view: load the next page here. */
  onEndReached?: (lastIndex: number) => void;
  /** Keeps this row in view as it changes: the keyboard cursor from `useListNavigation`. */
  activeIndex?: number;
  /**
   * Edge fades that show there is more above or below, as `ScrollShadow`
   * draws. The list then sits in a positioned wrapper that fills its
   * container.
   */
  shadows?: boolean;
  /** Required: names the list for assistive tech. */
  "aria-label": string;
  /** Classes for the scrolling element. */
  className?: string;
}

/**
 * A `VirtualList` over an array: each row is handed its item, typed `T`. JSX
 * and `createElement(VirtualList<T>, …)` pick this form when `items` is given.
 */
export interface PluginVirtualListItemsProps<T = unknown> extends PluginVirtualListBaseProps {
  /** The rows. */
  items: readonly T[];
  /** Ignored when `items` is given. */
  count?: number;
  /** Renders one row. */
  renderItem(index: number, item: T): ReactNode;
  /** A stable key per row. Defaults to the index, which re-mounts rows when the list reorders. */
  itemKey?(index: number, item: T): string | number;
}

/** A `VirtualList` of `count` rows fetched by index: rows are handed no item. */
export interface PluginVirtualListCountProps extends PluginVirtualListBaseProps {
  items?: undefined;
  /** The row count. */
  count: number;
  /** Renders one row; `item` is always `undefined`, so read your data by `index`. */
  renderItem(index: number, item: undefined): ReactNode;
  /** A stable key per row. Defaults to the index, which re-mounts rows when the list reorders. */
  itemKey?(index: number, item: undefined): string | number;
}

/**
 * Props of `VirtualList` in their general form, either `items` or `count`, for
 * a wrapper that forwards them. Written out directly, `VirtualList` narrows to
 * `PluginVirtualListItemsProps` or `PluginVirtualListCountProps`.
 */
export interface PluginVirtualListProps<T = unknown> extends PluginVirtualListBaseProps {
  /** The rows. Omit and pass `count` when rows are fetched by index. */
  items?: readonly T[];
  /** The row count when there is no `items` array. Ignored when `items` is given. */
  count?: number;
  /** Renders one row. `item` is `undefined` for a `count`-only list. */
  renderItem(index: number, item: T | undefined): ReactNode;
  /** A stable key per row. Defaults to the index, which re-mounts rows when the list reorders. */
  itemKey?(index: number, item: T | undefined): string | number;
}

/**
 * `VirtualList`'s call signatures. With `items`, rows get `T`; with `count`,
 * `undefined`; the last, general form keeps a bare `createElement(VirtualList,
 * …)` and forwarded `PluginVirtualListProps` compiling as they always have.
 */
export interface PluginVirtualListComponent {
  <T>(props: PluginVirtualListItemsProps<T>): ReactNode;
  (props: PluginVirtualListCountProps): ReactNode;
  (props: PluginVirtualListProps): ReactNode;
}

/** What `VirtualGrid` hands `renderItem` besides the item. */
export interface PluginVirtualGridItemState {
  /** The keyboard cursor is on this item. */
  active: boolean;
  /** `selection` holds this item. */
  selected: boolean;
}

/**
 * The part of a `useSelection` result `VirtualGrid` drives: pass the result
 * itself. Its ids are the grid's `itemKey` values (the index without one).
 */
export interface PluginVirtualGridSelection {
  count: number;
  anchor: PluginSelectionKey | null;
  isSelected(id: PluginSelectionKey): boolean;
  handleSelect(id: PluginSelectionKey, gesture?: PluginSelectionGesture): void;
  handleNavigate(id: PluginSelectionKey, gesture?: PluginSelectionGesture): void;
  selectAll(): void;
  clear(): void;
}

/**
 * Props of `VirtualGrid`: cards in as many equal columns as fit, windowed by
 * row so only the rows in view are mounted. It fills its container's height;
 * give the container one.
 *
 * With `selection` or `onItemActivate` it is a keyboard grid: one tab stop,
 * the arrow keys move a cursor in two dimensions, and clicks and keys select
 * the way a `DataTable` row does. Without either it is a plain list of cards
 * whose own controls keep their Tab stops.
 */
export interface PluginVirtualGridBaseProps extends PluginAriaRootAttributes {
  /**
   * The narrowest a column may get, in px (16 to 4096). Defaults to 180. A
   * grid narrower than this draws one column at its own width.
   */
  minColumnWidth?: number;
  /** Never more columns than this, however wide the grid gets. */
  maxColumns?: number;
  /** Space between cards, across and down. Defaults to `md`. */
  gap?: PluginLayoutGap;
  /** Expected card height in px, before rows are measured. Defaults to 180. */
  estimatedItemSize?: number;
  /** Rows rendered beyond each edge of the viewport. Defaults to 2. */
  overscan?: number;
  /** Called once the last item scrolls into view: load the next page here. */
  onEndReached?: (lastIndex: number) => void;
  /**
   * The keyboard cursor, controlled; the grid keeps its own without it. A
   * plain grid keeps this item in view as it changes.
   */
  activeIndex?: number;
  /** The cursor moved, by keyboard or click. */
  onActiveIndexChange?: (index: number) => void;
  /**
   * A `useSelection` result over the items' keys. Pass `aria-multiselectable`
   * too unless it is `mode: "single"`.
   */
  selection?: PluginVirtualGridSelection;
  /** Edge fades that show there is more above or below, as `ScrollShadow` draws. */
  shadows?: boolean;
  /** Required: names the grid for assistive tech. */
  "aria-label": string;
  /** Classes for the scrolling element. */
  className?: string;
}

/** A `VirtualGrid` over an array: each card is handed its item, typed `T`. */
export interface PluginVirtualGridItemsProps<T = unknown> extends PluginVirtualGridBaseProps {
  /** The cards. */
  items: readonly T[];
  /** Ignored when `items` is given. */
  count?: number;
  /** Renders one card. */
  renderItem(index: number, item: T, state: PluginVirtualGridItemState): ReactNode;
  /** A stable key per card, and its id in `selection`. Defaults to the index. */
  itemKey?(index: number, item: T): string | number;
  /** Enter on the cursor, or a plain click: open the item. */
  onItemActivate?(index: number, item: T): void;
}

/** A `VirtualGrid` of `count` cards fetched by index: cards are handed no item. */
export interface PluginVirtualGridCountProps extends PluginVirtualGridBaseProps {
  items?: undefined;
  /** The card count. */
  count: number;
  /** Renders one card; `item` is always `undefined`, so read your data by `index`. */
  renderItem(index: number, item: undefined, state: PluginVirtualGridItemState): ReactNode;
  /** A stable key per card, and its id in `selection`. Defaults to the index. */
  itemKey?(index: number, item: undefined): string | number;
  /** Enter on the cursor, or a plain click: open the item. */
  onItemActivate?(index: number, item: undefined): void;
}

/** Props of `VirtualGrid` in their general form, either `items` or `count`, for a wrapper that forwards them. */
export interface PluginVirtualGridProps<T = unknown> extends PluginVirtualGridBaseProps {
  /** The cards. Omit and pass `count` when cards are fetched by index. */
  items?: readonly T[];
  /** The card count when there is no `items` array. Ignored when `items` is given. */
  count?: number;
  /** Renders one card. `item` is `undefined` for a `count`-only grid. */
  renderItem(index: number, item: T | undefined, state: PluginVirtualGridItemState): ReactNode;
  /** A stable key per card, and its id in `selection`. Defaults to the index. */
  itemKey?(index: number, item: T | undefined): string | number;
  /** Enter on the cursor, or a plain click: open the item. */
  onItemActivate?(index: number, item: T | undefined): void;
}

/** `VirtualGrid`'s call signatures, narrowing as `VirtualList`'s do. */
export interface PluginVirtualGridComponent {
  <T>(props: PluginVirtualGridItemsProps<T>): ReactNode;
  (props: PluginVirtualGridCountProps): ReactNode;
  (props: PluginVirtualGridProps): ReactNode;
}

/** One column of a `DataTable`. */
export interface PluginDataTableColumn<T = unknown> {
  /** Unique within the table; also the row field read when there is no `render`. */
  id: string;
  header: ReactNode;
  /**
   * Fixed width: px as a number, or any CSS length. Columns without one share
   * the rest, up to 480px each; space beyond that is left at the table's
   * trailing edge rather than stretching one column across it.
   */
  width?: number | string;
  /**
   * Takes all the width the other columns leave, with no cap: for the one
   * column that should run to the edge (a message, a path). Give the other
   * columns widths, or they share the space with it.
   */
  grow?: boolean;
  align?: "start" | "center" | "end";
  /**
   * A figure column: end-aligned (unless `align` says otherwise), drawn with
   * tabular digits so a column of figures lines up, and its number editor stays
   * end-aligned. `true` draws the cell as `render` or `row[id]` gives it; an
   * object also formats a number cell that has no `render`.
   */
  numeric?: boolean | PluginDataTableNumericFormat;
  /** Draws the header as a sort button that reports through `onSortChange`. */
  sortable?: boolean;
  /** The cell. Defaults to `row[id]` when that is a string or a number. */
  render?(row: T, index: number): ReactNode;
  /**
   * Draws a drag edge on the header's trailing side; the edge is also a
   * keyboard separator (Left/Right step 8px, Shift 32px, Home/End the
   * limits). Enter, Space or a double-click go back to `width`. Widths report through
   * `onColumnWidthsChange`.
   */
  resizable?: boolean;
  /** The narrowest a resize may make it, in px. Defaults to 48. */
  minWidth?: number;
  /** The widest a resize may make it, in px. Defaults to 1200. */
  maxWidth?: number;
  /** `false` keeps the column always shown: its row in the columns menu stays checked and disabled. Defaults to `true`. */
  hideable?: boolean;
  /** The column's name in the columns menu, when `header` is not plain text. */
  menuLabel?: string;
  /**
   * Edits the cell in place: double-click it, or Enter/F2 on its row. A
   * function decides per row. The edit reports through the table's `onCellEdit`.
   */
  editable?: boolean | PluginDataTableRowPredicate<T>;
  /** The editor: `text` (the default), `number`, or `select` over `editOptions`. */
  editor?: "text" | "number" | "select";
  /** The choices of a `select` editor. */
  editOptions?: readonly PluginSelectOption[];
  /** The text the editor starts from. Defaults to `row[id]` when that is a string or a number. */
  editValue?(row: T): string;
  /** Checks a draft before it is committed: return a message to refuse it and keep the editor open. */
  validate?(value: string, row: T): string | null | undefined;
}

/** How a `numeric` column formats a number cell that has no `render`. */
export interface PluginDataTableNumericFormat {
  /** An ISO 4217 code ("EUR"): formats as money in the user's locale. */
  currency?: string;
  /** Fixed decimal places. Defaults to the currency's own, else up to 2. */
  decimals?: number;
  /** `minus` (the default) draws a true minus sign (U+2212); `parens` wraps a negative figure in brackets. */
  negative?: "minus" | "parens";
}

/** A `DataTable` totals cell: `"sum"` adds the column's finite numbers (formatted like a `numeric` cell), or a function draws it from the rows. */
export type PluginDataTableTotal<T> =
  | "sum"
  | {
      bivarianceHack(rows: readonly T[]): ReactNode;
    }["bivarianceHack"];

/** Decides something per row (selectable, editable). A method, for the same reason as {@link PluginDataTableRowKey}. */
export type PluginDataTableRowPredicate<T> = {
  bivarianceHack(row: T): boolean;
}["bivarianceHack"];

/**
 * A `DataTable` row's stable key. Declared as a method so a table typed for
 * one row shape still fits where any rows are accepted.
 */
export type PluginDataTableRowKey<T> = {
  bivarianceHack(row: T, index: number): string | number;
}["bivarianceHack"];

/** A `DataTable`'s sort. The table only reports it; sort `rows` yourself. */
export interface PluginDataTableSort {
  columnId: string;
  direction: "asc" | "desc";
}

/**
 * Props of `DataTable`: a table with a header that stays put. By default the
 * body is virtualised and the table fills its container's height, like
 * `VirtualList`; `virtualize={false}` draws a plain table that sizes to its
 * rows, for a ledger, statement or schedule inside a card. With `onRowClick`
 * the table is a keyboard grid: one tab stop, Up/Down/Home/End move the cursor
 * and Enter activates the row. Buttons, links and inputs inside a cell keep
 * their own clicks and keys; they do not activate the row.
 */
export interface PluginDataTableProps<T = unknown> extends PluginRootAttributes {
  columns: readonly PluginDataTableColumn<T>[];
  rows: readonly T[];
  /** A stable key per row: a function, or the name of a string or number field. */
  rowKey: PluginDataTableRowKey<T> | string;
  /** The current sort, controlled. `null` or omitted is unsorted. */
  sort?: PluginDataTableSort | null;
  /** A sortable header was activated: ascending first, then it flips. */
  onSortChange?: (sort: PluginDataTableSort) => void;
  onRowClick?(row: T, index: number): void;
  /**
   * The row's context menu, in `DropdownMenu` entries: opened by a right-click
   * on the row, or by Shift+F10 / the Menu key on the keyboard cursor's row.
   * The row is outlined while its menu is open and focus returns to the table
   * when it closes. Return `null` or `[]` for a row with no menu. Setting it
   * makes the table a keyboard grid, as `onRowClick` does.
   */
  rowMenu?(row: T, index: number): readonly PluginDropdownMenuEntry[] | null;
  /** The key of the one selected row, drawn with the list highlight. */
  selectedRowKey?: string | number | null;
  /** Shown in place of the body while `rows` is empty: usually an `EmptyState`. */
  empty?: ReactNode;
  /** Expected row height in px. Defaults to the `density`'s row height (24, 28 or 32); ignored with `virtualize={false}`. */
  estimatedRowSize?: number;
  onEndReached?: (lastIndex: number) => void;
  /** Required: names the table for assistive tech. */
  "aria-label": string;
  /** Classes for the scrolling element. */
  className?: string;

  // Layout.
  /**
   * `true` (the default) virtualises the body and fills the container's
   * height, as the table always has. `false` draws every row in a plain table
   * that is exactly as tall as its rows, so a short table needs no height of
   * its own; use it for up to a few hundred rows. `onEndReached` and
   * `estimatedRowSize` do nothing without the virtualiser.
   */
  virtualize?: boolean;
  /**
   * Row height and type size: `compact` (24px, 12px type) for a dense
   * projection, `default` (28px, 12px; the default), or `comfortable` (32px,
   * 14px) for a ledger read line by line. Sets the virtualiser's row estimate
   * unless `estimatedRowSize` is given.
   */
  density?: "compact" | "default" | "comfortable";
  /** A hairline rule between rows, so the eye can follow a row across many columns. Defaults to `false`. */
  rowDividers?: boolean;
  /** A quiet fill on every other drawn row. Defaults to `false`. */
  striped?: boolean;
  /**
   * A totals row at the foot of the table, by column id: `"sum"` adds the
   * column's finite numbers, a function draws the cell. Both read exactly
   * `rows` (never sub-rows, whatever is expanded). Drawn in a `<tfoot>` under
   * a strong rule, in semibold, and kept in view while the body scrolls.
   */
  totals?: Readonly<Record<string, PluginDataTableTotal<T>>>;
  /** The totals row's label, in its first column that has no total. Defaults to "Total". */
  totalsLabel?: ReactNode;
  /**
   * How an `editable` cell shows it can be edited before it is: `hover` (the
   * default) lifts the cell and draws a pencil at its end while the pointer or
   * the keyboard cursor is on it; `none` draws nothing.
   */
  editAffordance?: "hover" | "none";

  // Selection. Rows are keyed by `rowKey`.
  /**
   * Draws a checkbox column and makes the table multi-select: click a box to
   * toggle its row, Shift-click for a range, the header box for all. On the
   * keyboard Space toggles the cursor row, Shift+Up/Down extend, Cmd+A (Ctrl+A)
   * selects all and Escape clears. A function leaves some rows out. Pair it
   * with `BulkActionBar`: `count={keys.length}` and `onClear={() => setKeys([])}`.
   */
  selectable?: boolean | PluginDataTableRowPredicate<T>;
  /** The selected rows' keys, controlled. */
  selectedRowKeys?: readonly (string | number)[];
  defaultSelectedRowKeys?: readonly (string | number)[];
  /** The selection changed: the keys in the order the rows are drawn. */
  onSelectedRowKeysChange?: (keys: (string | number)[]) => void;

  // Groups.
  /**
   * Groups the rows under a header row with a disclosure and a count: by a
   * column id or field name, or a function returning the group's key. Groups
   * keep the order their first row has in `rows`.
   */
  groupBy?: string | PluginDataTableGroupAccessor<T>;
  /** The header's label for a group. Defaults to the key ("None" for an empty one). */
  groupLabel?(key: string, rows: readonly T[]): ReactNode;
  /**
   * Subtotals on a group's header row, by column id: the same `"sum"` or
   * function as `totals`, over exactly the rows `groupLabel` receives
   * (folded or not). The disclosure and label keep the first visible column
   * and run across the columns after it up to the first one with a subtotal;
   * a subtotal for the first visible column is not drawn. Columns not listed
   * stay empty.
   */
  groupTotals?: Readonly<Record<string, PluginDataTableTotal<T>>>;
  /** `false` drops the row count after a group's label. Defaults to `true`. */
  groupCount?: boolean;
  /** Folded groups' keys, controlled. */
  collapsedGroups?: readonly string[];
  defaultCollapsedGroups?: readonly string[];
  onCollapsedGroupsChange?: (keys: string[]) => void;

  // Expandable rows (a tree table). Row keys must be unique across every level.
  /** A row's children, drawn under it indented when it is expanded. */
  getSubRows?(row: T): readonly T[] | null | undefined;
  /**
   * Whether a row has children to load. With `loadSubRows`, a row this
   * returns `true` for draws a disclosure; expanding it loads the children,
   * with a loading row under it meanwhile and Retry if the load fails.
   */
  hasSubRows?(row: T): boolean;
  /** Loads a row's children when it is first expanded. Kept while the row is the same object; Retry or a new row object loads them again. */
  loadSubRows?(row: T): Promise<readonly T[]>;
  /** Expanded rows' keys, controlled. */
  expandedRowKeys?: readonly (string | number)[];
  defaultExpandedRowKeys?: readonly (string | number)[];
  onExpandedRowKeysChange?: (keys: (string | number)[]) => void;

  // Columns.
  /** Column widths in px by column id, controlled. A column not listed keeps its `width`. */
  columnWidths?: Readonly<Record<string, number>>;
  defaultColumnWidths?: Readonly<Record<string, number>>;
  /** A column was resized: every width set so far. */
  onColumnWidthsChange?: (widths: Record<string, number>) => void;
  /** Hidden columns' ids, controlled. */
  hiddenColumns?: readonly string[];
  defaultHiddenColumns?: readonly string[];
  onHiddenColumnsChange?: (ids: string[]) => void;
  /** Draws a Columns button at the header's end, a menu that shows and hides columns. */
  columnsMenu?: boolean;
  /**
   * Remembers column widths, hidden columns, folded groups and expanded rows
   * with `usePersistentViewState` under this key, so they survive the view
   * unmounting, a reload and a restart. Controlled props still win.
   */
  viewStateKey?: string;
  /**
   * Pins the first column (after the checkboxes) to the start while the table
   * scrolls sideways. The table scrolls sideways once its columns are wider
   * than the pane.
   */
  stickyFirstColumn?: boolean;

  // Editing.
  /**
   * An `editable` cell was committed (Enter, Tab or leaving it). Return a
   * promise to show the cell pending until it settles; a rejection reopens
   * the editor with the draft and the error's message (while another cell is
   * being edited the failure is announced instead). Escape cancels an edit.
   * Tab and Shift+Tab commit and move to the next or previous editable cell.
   */
  onCellEdit?(row: T, columnId: string, value: string): void | Promise<void>;
}

/** Reads a row's group key for `DataTable`'s `groupBy`. */
export type PluginDataTableGroupAccessor<T> = {
  bivarianceHack(row: T): string;
}["bivarianceHack"];

/** One line of a `LogView` with a severity: its glyph leads the line. */
export interface PluginLogEntry {
  text: string;
  severity?: PluginSeverity;
}

/**
 * Props of `LogView`: a bounded, virtualised log. Only the newest `maxLines`
 * are kept on screen and only the lines in view are in the DOM, so a job that
 * prints twenty thousand lines stays cheap to render. Append to `lines` in
 * batches (per animation frame, not per line) and drop old lines yourself if
 * you keep them in state; the view bounds the DOM, not your array.
 */
export interface PluginLogViewProps extends PluginAriaRootAttributes {
  lines: readonly (string | PluginLogEntry)[];
  /** The newest lines shown. Defaults to 5000; older lines are dropped from the view. */
  maxLines?: number;
  /** Stay pinned to the newest line while the reader is at the bottom. Defaults to true. */
  follow?: boolean;
  /** Defaults to true. */
  monospace?: boolean;
  /** Wrap long lines. Defaults to true. */
  wrap?: boolean;
  /** Required: names the log for assistive tech. */
  "aria-label": string;
  /** Classes for the scrolling element. */
  className?: string;
}

/**
 * Props of `ListRow`: a row with the list highlight. Spread
 * `useListNavigation().getRowProps(index)` into it for a keyboard listbox.
 * Otherwise, with `onSelect`, it is a button; without, a plain row.
 */
export interface PluginListRowProps extends Omit<PluginDomProps<HTMLElement>, "title"> {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: PluginIconSource;
  /** Trailing detail: a count, a time, a badge. */
  meta?: ReactNode;
  /** The selected record in a list-detail list (outside a listbox). */
  selected?: boolean;
  /**
   * The keyboard cursor in a multi-select listbox, where `aria-selected` marks
   * the selection rather than the cursor: an outline while the list has
   * keyboard focus. Pass `index === activeIndex`.
   */
  active?: boolean;
  /**
   * The row is in a multi-select list and this says whether it is chosen:
   * the host's checkbox glyph takes the icon's place on a checked row, on the
   * row under the pointer and on the keyboard cursor, as in the app's own
   * multi-select lists. Pass `selection.isSelected(id)`.
   */
  checked?: boolean;
  /** Anything in the list is selected: every row shows its checkbox. Pass `selection.count > 0`. */
  selecting?: boolean;
  /** A click on the checkbox itself: toggle just this row (`selection.toggle(id)`). */
  onToggle?: () => void;
  onSelect?: () => void;
  /**
   * Dimmed and not clickable. In a `useListNavigation` listbox, report the same
   * rows through its `isDisabled` so the cursor skips them and Enter and Space
   * cannot select them; `getRowProps` then marks them disabled for you.
   */
  disabled?: boolean;
  className?: string;
}

export interface UseListNavigationOptions {
  /** Rows in the list. */
  count: number;
  /**
   * Enter, Space or a click on a row. `event` is the key or click that did it
   * (absent when `getRowProps(i).onClick()` is called without one), so a
   * multi-select list can read its modifiers (see `useSelection`).
   */
  onSelect?: (index: number, event?: KeyboardEvent<HTMLElement> | MouseEvent<HTMLElement>) => void;
  /**
   * Rows carry a kit `ContextMenu`. Shift+F10 and the Menu key then open the
   * cursor row's menu, since focus stays on the list rather than on the row.
   */
  hasRowMenus?: boolean;
  /**
   * The cursor moved by keyboard (arrows, Home/End, typeahead), with the key
   * that moved it. With `useSelection`, pass `handleNavigate` here so
   * Shift+Arrow extends the selection.
   */
  onActiveIndexChange?: (index: number, event: KeyboardEvent<HTMLElement>) => void;
  /** Past either end, go round to the other. Defaults to false. */
  loop?: boolean;
  /** Where the cursor starts. Defaults to 0. */
  initialIndex?: number;
  /** A row's text, for typeahead: typing jumps to the next row that starts with it. */
  getLabel?: (index: number) => string;
  /**
   * Rows that cannot be chosen. The cursor and typeahead skip them, and
   * Enter, Space and clicks on them do nothing. `getRowProps` marks them
   * `aria-disabled`.
   */
  isDisabled?: (index: number) => boolean;
}

/** Props `useListNavigation` hands the list element. */
export interface PluginListNavigationContainerProps {
  role: "listbox";
  tabIndex: 0;
  "aria-activedescendant": string | undefined;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  /** Set with `hasRowMenus`: the app's Shift+F10 handler leaves the key to the rows. */
  "data-row-menu"?: "";
}

/** Props `useListNavigation` hands each row. */
export interface PluginListNavigationRowProps {
  id: string;
  role: "option";
  "aria-selected": boolean;
  /** Set on rows `isDisabled` reports. */
  "aria-disabled"?: true;
  /** Takes the click, when there is one, so `onSelect` can read its modifiers. */
  onClick: (event?: MouseEvent<HTMLElement>) => void;
  onPointerMove: () => void;
}

export interface UseListNavigationResult {
  /** The row the cursor is on, or -1 for an empty list. */
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  containerProps: PluginListNavigationContainerProps;
  getRowProps: (index: number) => PluginListNavigationRowProps;
}

/** One entry of a flat `FileTree` listing: the shape `host.fs.walk` returns. */
export interface PluginFileTreeEntry {
  /** Relative, `/`-separated. Missing parent folders are filled in. */
  path: string;
  /** `dir` as `host.fs.walk` spells it, or `directory`. */
  type: "file" | "dir" | "directory";
}

/** One node of a nested `FileTree`. A node with `children` is a folder. */
export interface PluginFileTreeNode {
  name: string;
  /** Defaults to `directory` when `children` is given, else `file`. */
  type?: "file" | "dir" | "directory";
  children?: readonly PluginFileTreeNode[];
}

/** A row of a `FileTree`, as its callbacks report it. */
export interface PluginFileTreeItem {
  /** Relative, `/`-separated: the path you gave, or the node names joined. */
  path: string;
  name: string;
  type: "file" | "directory";
  /** 0 for entries at the root. */
  depth: number;
}

/**
 * Props of `FileTree`: Daintree's file tree, virtualised, with the chevron
 * gutter, file-type icons and keyboard model of the host's own file browser.
 * Give it `entries` (a flat list) or `nodes` (nested). One tab stop:
 * Up/Down/Home/End move the selection, Right opens a folder or steps into it,
 * Left closes it or steps out to the parent, Enter activates, and typing
 * jumps to a matching name.
 */
export interface PluginFileTreeProps extends PluginAriaRootAttributes {
  entries?: readonly PluginFileTreeEntry[];
  nodes?: readonly PluginFileTreeNode[];
  /** Required: names the tree for assistive tech. */
  "aria-label": string;
  /** The selected path, controlled. Passing it at all makes selection controlled. */
  selectedPath?: string | null;
  defaultSelectedPath?: string | null;
  /** A row was selected by click, arrow key or typeahead. */
  onSelect?: (path: string, item: PluginFileTreeItem) => void;
  /** The open folders, controlled. Passing it at all makes expansion controlled. */
  expandedPaths?: readonly string[];
  defaultExpandedPaths?: readonly string[];
  onExpandedPathsChange?: (paths: string[]) => void;
  /** Enter or a double-click on a row: open the file, show the folder. */
  onActivate?: (path: string, item: PluginFileTreeItem) => void;
  /**
   * `natural` (the default): folders first, then names in numeric-aware,
   * case-insensitive order, so `churn-2` precedes `churn-10`. `none` keeps
   * the order you gave.
   */
  sort?: "natural" | "none";
  /** Shown when there are no entries: usually an `EmptyState`. */
  empty?: ReactNode;
  className?: string;
}

/** One group of a `GroupedVirtualList`. */
export interface PluginListGroup<T = unknown> {
  /** Non-empty and unique within the list. */
  id: string;
  /** The sticky header's text, sentence case. */
  label: string;
  items: readonly T[];
  /** The number after the label. Defaults to `items.length`; `false` for none. */
  count?: number | false;
}

/**
 * Props of `GroupedVirtualList`: a `VirtualList` in groups, each under a
 * header that sticks to the top while its rows scroll past. Rows are indexed
 * across the list as drawn, headers not counted and folded groups left out,
 * so `activeIndex` and `useListNavigation`'s `count` use the same numbers.
 */
export interface PluginGroupedVirtualListProps<T = unknown> extends PluginVirtualListBaseProps {
  groups: readonly PluginListGroup<T>[];
  /** Renders one row. `index` is the row's index across the drawn list. */
  renderItem(item: T, index: number, group: PluginListGroup<T>): ReactNode;
  /** A stable key per row. Defaults to the group id and the row's index in it. */
  itemKey?(item: T, group: PluginListGroup<T>): string | number;
  /** Headers fold their group on click, Enter or Space. */
  collapsible?: boolean;
  /** The folded groups' ids, controlled. */
  collapsedGroups?: readonly string[];
  defaultCollapsedGroups?: readonly string[];
  onCollapsedGroupsChange?: (collapsed: string[]) => void;
  /** After the last row, inside the scroller: usually a `LoadMoreFooter`. */
  footer?: ReactNode;
  /** Shown instead of the list when every group is empty. */
  empty?: ReactNode;
}

/** Identifies a `TreeView` node. Unique across the whole tree. */
export type PluginTreeNodeId = string | number;

/** Handed to `TreeView`'s `renderNode` and `getIcon`. */
export interface PluginTreeNodeState {
  depth: number;
  expanded: boolean;
  /** Has children, or may have (an unloaded async node). */
  expandable: boolean;
  selected: boolean;
  /** With `checkable`: on, off, or some of its children on. */
  checked: boolean | "mixed";
  /** Its children are loading. */
  loading: boolean;
}

/** A node moved by drag or by Alt+arrow keys, reported once on drop. */
export interface PluginTreeMove {
  id: PluginTreeNodeId;
  /** Its new parent; `null` for the top level. */
  parentId: PluginTreeNodeId | null;
  /** Its index among the new parent's children, counted with it removed from where it was. */
  index: number;
  /** Where it was. */
  fromParentId: PluginTreeNodeId | null;
  fromIndex: number;
}

/**
 * Props of `TreeView`: a tree of any nodes, drawn like the host's file tree
 * (the same rows, chevrons and indentation) and virtualised, so a tree of
 * thousands of nodes stays light. It is one tab stop with the ARIA tree
 * keyboard: Up/Down move, Right expands or steps in, Left collapses or steps
 * out, Home/End, Enter activates, typing jumps to a matching label. It fills
 * its container's height.
 */
export interface PluginTreeViewProps<T = unknown> extends PluginRootAttributes {
  /** The top-level nodes. */
  nodes: readonly T[];
  /** A node's id. Defaults to its `id` field. */
  getId?(node: T): PluginTreeNodeId;
  /** A node's text, read for its row, typeahead and announcements. Defaults to its `label`, `name` or `title`. */
  getLabel?(node: T): string;
  /**
   * A node's children: an array, or a promise for a lazy node, loaded the
   * first time it is expanded with a loading row under it meanwhile (Retry
   * if it fails). Defaults to the node's `children` field. Pass `hasChildren`
   * with lazy nodes, or each one is loaded as it is drawn to learn whether it
   * has any.
   */
  getChildren?(node: T): readonly T[] | Promise<readonly T[]> | null | undefined;
  /** Whether a node has children, without loading them. */
  hasChildren?(node: T): boolean;
  /** The row's content after the chevron and checkbox. Defaults to the icon and the label. */
  renderNode?(node: T, state: PluginTreeNodeState): ReactNode;
  /** A glyph before the label, when `renderNode` is not given. */
  getIcon?(node: T, state: PluginTreeNodeState): PluginIconSource | null | undefined;
  /** `single` (the default): moving the cursor moves the selection. `multiple`: Cmd-click (Ctrl-click) toggles, Shift-click and Shift+arrows extend, Cmd/Ctrl+arrows move without selecting and Cmd/Ctrl+Space toggles. */
  selectionMode?: "single" | "multiple";
  /** Selected nodes' ids, controlled. */
  selected?: readonly PluginTreeNodeId[];
  defaultSelected?: readonly PluginTreeNodeId[];
  onSelectedChange?: (ids: PluginTreeNodeId[]) => void;
  /** Expanded nodes' ids, controlled. */
  expanded?: readonly PluginTreeNodeId[];
  defaultExpanded?: readonly PluginTreeNodeId[];
  onExpandedChange?: (ids: PluginTreeNodeId[]) => void;
  /**
   * Draws a checkbox on every row; Space toggles the cursor row's. A parent
   * is on when all its loaded children are, mixed when some are, and checking
   * it checks them all.
   */
  checkable?: boolean;
  /** Checked nodes' ids, controlled: parents included when all their children are on. */
  checked?: readonly PluginTreeNodeId[];
  defaultChecked?: readonly PluginTreeNodeId[];
  onCheckedChange?: (ids: PluginTreeNodeId[]) => void;
  /** Enter or a double-click on a node. */
  onActivate?(node: T): void;
  /**
   * Lets nodes be dragged to reorder or re-parent them: dropped on a row's
   * upper or lower edge it goes before or after it, on its middle into it.
   * Alt+Up/Down move the cursor node among its siblings, Alt+Left out to its
   * parent's level, Alt+Right into the sibling above it. The tree does not
   * move nodes itself: apply the move to `nodes`.
   */
  onMove?(move: PluginTreeMove): void;
  /** Whether a node may be dropped there. Dropping a node into itself or its own descendants is always refused. */
  canDrop?(move: PluginTreeMove): boolean;
  /** Whether a node can be picked up. Defaults to all of them. */
  canDrag?(node: T): boolean;
  /** Shown instead of the tree when `nodes` is empty: usually an `EmptyState`. */
  empty?: ReactNode;
  /** Required: names the tree for assistive tech. */
  "aria-label": string;
  className?: string;
}

/**
 * Props of `ObjectInspector`: a read-only, collapsible view of a JSON-like
 * value (an API response, a tool result) with type-coloured values in the
 * same syntax colours as `CodeBlock`. Each row copies its value or its path
 * from its context menu or the buttons that show on hover; Cmd+C (Ctrl+C)
 * copies the cursor row's value. Long strings are cut with a "more" toggle,
 * large arrays are split into ranges, and a value that contains itself is
 * shown as `[Circular]` rather than followed. It is one tab stop with the
 * ARIA tree keyboard, virtualised, and fills its container's height.
 */
export interface PluginObjectInspectorProps extends PluginRootAttributes {
  value: unknown;
  /** The root's name, shown as its key and starting every copied path. Defaults to none: paths start at the first key. */
  name?: string;
  /** How many levels start open. Defaults to 1; `Infinity` opens everything. */
  expandDepth?: number;
  /** Draws a bar with a filter field and Expand all / Collapse all. Defaults to `true`. */
  toolbar?: boolean;
  /** Filter text, controlled: rows whose key or value contains it, with their ancestors. */
  filter?: string;
  defaultFilter?: string;
  onFilterChange?: (filter: string) => void;
  /** Characters of a string shown before it is cut. Defaults to 200. */
  maxStringLength?: number;
  /** Items per range in a large array. Defaults to 100. */
  arrayChunkSize?: number;
  /** Keys in object order (the default), or sorted. */
  sortKeys?: boolean;
  /** Required: names the inspector for assistive tech ("Response body"). */
  "aria-label": string;
  className?: string;
}
