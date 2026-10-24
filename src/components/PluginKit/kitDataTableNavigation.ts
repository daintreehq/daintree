import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { ListRange, TableVirtuosoHandle } from "react-virtuoso";
import type { PluginDataTableProps } from "@shared/types/plugin-sdk-react";
import { stopContextMenuPropagation } from "@/components/ui/context-menu-base";
import { isMac } from "@/lib/platform";
import { isMenuKey } from "./kitMenu";
import { activeMounted, fromCellControl, IN_CELL_CONTROL_SELECTOR } from "./PluginKitLists";
import type { DrawnItem, DrawnRow, RowKey } from "./kitDataTableModel";
import { forgetLazyChildren, type LazyScope } from "./kitLazyChildren";
import { attempt } from "./kitDataTableShared";
import type { DataTableSelection } from "./kitDataTableSelection";
import type { DataTableEditing } from "./kitDataTableEditing";

/** How far Left or Right scrolls a wide table when the row has no tree or group step to take. */
const HORIZONTAL_KEY_STEP_PX = 40;

function focusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return false;
  }
}

function scrollRowIntoView(id: string): void {
  const row = document.getElementById(id);
  if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
}

export interface DataTableCursor {
  /** The cursor's drawn index, or -1. */
  activeIndex: number;
  baseId: string;
  rowId: (index: number) => string;
  handle: RefObject<TableVirtuosoHandle | null>;
  /** The rows the virtualiser has mounted; null when every row is. */
  range: ListRange | null;
  setRange: (range: ListRange) => void;
  revealRow: (index: number) => void;
  moveCursor: (index: number, reveal?: boolean) => void;
  /** Moves the cursor to an item by id, without scrolling to it. */
  setCursorId: (id: string) => void;
}

/** The keyboard cursor: an item by id, so it follows the item as rows come and go. */
export function useDataTableCursor(items: readonly DrawnItem[], plain: boolean): DataTableCursor {
  const [cursorId, setCursorId] = useState<string | null>(null);
  const found = cursorId === null ? -1 : items.findIndex((item) => item.id === cursorId);
  const activeIndex = items.length === 0 ? -1 : found;
  const baseId = useId();
  const rowId = (index: number) => `${baseId}row-${index}`;
  const handle = useRef<TableVirtuosoHandle>(null);
  const [virtualRange, setRange] = useState<ListRange | null>(null);
  // Every row is mounted without the virtualiser, whatever range it last reported.
  const range = plain ? null : virtualRange;
  const [revealIndex, setRevealIndex] = useState(-1);
  // Without the virtualiser every row is in the DOM, so the row itself is
  // scrolled into whatever scrolls the table.
  const revealRow = (index: number) => {
    if (plain) scrollRowIntoView(`${baseId}row-${index}`);
    else handle.current?.scrollIntoView({ index });
  };
  useEffect(() => {
    if (revealIndex < 0) return;
    if (plain) scrollRowIntoView(`${baseId}row-${revealIndex}`);
    else handle.current?.scrollIntoView({ index: revealIndex });
  }, [revealIndex, plain, baseId]);
  const moveCursor = (index: number, reveal = true) => {
    const item = items[index];
    if (!item) return;
    setCursorId(item.id);
    if (reveal) setRevealIndex(index);
  };
  return {
    activeIndex,
    baseId,
    rowId,
    handle,
    range,
    setRange,
    revealRow,
    moveCursor,
    setCursorId,
  };
}

export interface DataTableInteractions {
  toggleGroup: (groupKey: string, open: boolean) => void;
  toggleRow: (row: DrawnRow, open: boolean) => void;
  onRowClickAt: (index: number, event: MouseEvent<HTMLTableRowElement>) => void;
  /** The row menu: its entries outlive the close so it does not empty while it animates out. */
  menu: { index: number; items: readonly unknown[]; open: boolean };
  closeMenu: () => void;
  openRowMenu: (event: MouseEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTableElement>) => void;
  onFocus: (event: FocusEvent<HTMLTableElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

/** What the grid does with keys, clicks and its row menu, through the owners above. */
export function useDataTableInteractions({
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
}: {
  items: readonly DrawnItem[];
  cursor: DataTableCursor;
  rowSelection: DataTableSelection;
  editing: Pick<DataTableEditing, "edit" | "editRow">;
  scroller: HTMLElement | null;
  focusGrid: () => void;
  plain: boolean;
  interactive: boolean;
  collapsed: string[];
  setCollapsed: (next: string[]) => void;
  expanded: RowKey[];
  setExpanded: (next: RowKey[]) => void;
  lazyScope: LazyScope;
  rowClick: PluginDataTableProps["onRowClick"];
  menuFor: PluginDataTableProps["rowMenu"];
}): DataTableInteractions {
  const { activeIndex, rowId, range, revealRow, moveCursor, setCursorId } = cursor;
  const { canSelect, selection, selectableRow, groupKeys, toggleGroupSelection } = rowSelection;
  const { edit, editRow } = editing;
  // Left and Right belong to the tree and groups, so where neither has a use
  // for them they scroll a table wider than its pane, which a grid's single
  // tab stop would otherwise leave out of keyboard reach.
  const scrollAcross = (towardEnd: 1 | -1) => {
    if (!scroller || scroller.scrollWidth <= scroller.clientWidth) return;
    const rtl = getComputedStyle(scroller).direction === "rtl";
    scroller.scrollBy({ left: towardEnd * (rtl ? -1 : 1) * HORIZONTAL_KEY_STEP_PX });
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
    if (!item || !interactive || fromCellControl(event)) return;
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
  const closeMenu = () => setMenu((state) => ({ ...state, open: false }));

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
      else scrollAcross(1);
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
      else scrollAcross(-1);
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

  const onFocus = (event: FocusEvent<HTMLTableElement>) => {
    if (event.target !== event.currentTarget || items.length === 0) return;
    const at = activeIndex < 0 ? 0 : activeIndex;
    if (activeIndex < 0) moveCursor(0, false);
    // A plain table's rows are all mounted but may be scrolled away; it
    // reveals the cursor for keyboard focus only, so a click is not
    // answered by a jump to the row the cursor was on before it.
    if (plain ? focusVisible(event.currentTarget) : !activeMounted(at, range)) revealRow(at);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Rows never take focus (they unmount as they scroll), so a click in
    // the body pulls it to the grid and the keys keep working.
    const target = event.target instanceof Element ? event.target : null;
    if (!interactive || !target?.closest("tbody")) return;
    if (target.closest(IN_CELL_CONTROL_SELECTOR)) return;
    if (edit) return;
    requestAnimationFrame(() => {
      // A double-click opens an editor between this press and the frame;
      // pulling focus to the grid then would blur and commit it.
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest("td")) return;
      focusGrid();
    });
  };

  return {
    toggleGroup,
    toggleRow,
    onRowClickAt,
    menu,
    closeMenu,
    openRowMenu,
    onKeyDown,
    onFocus,
    onPointerDown,
  };
}
