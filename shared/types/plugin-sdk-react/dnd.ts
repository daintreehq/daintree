// Drag and drop: the primitives, a reorderable list and a board. Drags start
// and end inside the view: they move with the pointer or the keyboard, never
// through the system drag-and-drop, so no host drop target sees them.

import type { DOMAttributes, HTMLAttributes, ReactNode } from "react";
import type { PluginRootAttributes } from "./common.js";

/** Identifies a draggable item or a drop target. Unique among the items a component holds. */
export type PluginDragId = string | number;

/** What a `DragDropProvider` reports as a drag moves and ends. */
export interface PluginDragEvent {
  /** The item being dragged. */
  activeId: PluginDragId;
  /** The drop target under it, or `null` when it is over none. */
  overId: PluginDragId | null;
}

/**
 * Props of `DragDropProvider`: the scope for `useDraggable` and
 * `useDroppable`. Only draggables and drop targets inside the same provider
 * see each other. Picking up takes 8px of travel with the mouse, a long press
 * on touch, or Space on a focused handle; while held, the arrow keys jump
 * between drop targets, Space drops and Escape cancels. Every step is
 * announced to screen readers.
 */
export interface PluginDragDropProviderProps {
  children?: ReactNode;
  onDragStart?(event: PluginDragEvent): void;
  /** Called when the target under the item changes. */
  onDragOver?(event: PluginDragEvent): void;
  /** Called on drop. `overId` is `null` for a drop over no target: treat that as a cancel. */
  onDragEnd?(event: PluginDragEvent): void;
  onDragCancel?(event: PluginDragEvent): void;
  /**
   * The lifted copy that follows the pointer, drawn on the app's raised
   * surface. With it, the dragged item stays in place, faded, as a
   * placeholder. Without it, the item itself moves: apply `style` from
   * `useDraggable`.
   */
  renderOverlay?(activeId: PluginDragId): ReactNode;
  /** Names an item or target in announcements ("Picked up Fix login"). Defaults to its id. */
  getLabel?(id: PluginDragId): string;
  /** Classes for the provider's wrapper. Without them the wrapper takes no box (`display: contents`). */
  className?: string;
}

export interface PluginUseDraggableOptions {
  id: PluginDragId;
  disabled?: boolean;
}

/**
 * Spread onto the element the user grabs: the item itself or a grip inside
 * it. It is one focusable button that picks the item up with the pointer or
 * Space.
 */
export interface PluginDragHandleProps {
  ref: (element: HTMLElement | null) => void;
  role: "button";
  tabIndex: number;
  "aria-roledescription": string;
  "aria-describedby": string;
  "aria-pressed": boolean;
  "aria-disabled": boolean;
  onMouseDown?: DOMAttributes<HTMLElement>["onMouseDown"];
  onTouchStart?: DOMAttributes<HTMLElement>["onTouchStart"];
  onKeyDown?: DOMAttributes<HTMLElement>["onKeyDown"];
}

/** What `useDraggable` returns. */
export interface PluginDraggableState {
  /** Put on the item's outer element, which is what gets measured. */
  ref: (element: HTMLElement | null) => void;
  handleProps: PluginDragHandleProps;
  isDragging: boolean;
  /**
   * Put on the item's outer element: while it is dragged, the faded
   * placeholder look under a provider with `renderOverlay`, the pointer's
   * offset without one. `undefined` at rest.
   */
  style: HTMLAttributes<HTMLElement>["style"];
}

export interface PluginUseDroppableOptions {
  id: PluginDragId;
  disabled?: boolean;
}

/** What `useDroppable` returns. */
export interface PluginDroppableState {
  ref: (element: HTMLElement | null) => void;
  /** An item is held over this target. Draw your own "drop here" cue from it. */
  isOver: boolean;
  /** The item being dragged anywhere in the provider, or `null`. */
  activeId: PluginDragId | null;
}

/** Handed to `SortableList`'s `renderItem`. */
export interface PluginSortableItemState {
  /** Its position as drawn: while an item is held by keyboard, the position it would land at. */
  index: number;
  /** This item is picked up: it is the faded placeholder, or lifted in place while moved by keyboard. */
  isDragging: boolean;
  /** This render is the lifted copy under the pointer. */
  isOverlay: boolean;
  disabled: boolean;
}

/**
 * Props of `SortableList`: a list the user reorders by dragging, or by
 * keyboard (Space picks the focused item up, the arrow keys move it, Space
 * drops, Escape puts it back). The list is one tab stop; the arrow keys move
 * between items. While a pointer drag is held the item's slot stays behind as
 * a faded placeholder and a line marks where it will land; a scrolling
 * ancestor scrolls when the pointer nears its edge. Each item's context menu
 * (right-click, or Shift+F10) offers the same moves without a drag. The list
 * does not reorder itself: apply `onReorder` or `onChange` to `items`.
 */
export interface PluginSortableListProps<T = unknown> extends PluginRootAttributes {
  items: readonly T[];
  /** A stable id per item. Defaults to the item's own `id` field, then its index. */
  getId?(item: T, index: number): PluginDragId;
  /** Renders an item's content; the list draws the row, its hover and its lift. */
  renderItem(item: T, state: PluginSortableItemState): ReactNode;
  /** Called on drop with the item's old and new index. */
  onReorder?(from: number, to: number): void;
  /** Called on drop with the items in their new order. */
  onChange?(items: T[]): void;
  /** Required: names the list for assistive tech ("Priorities"). */
  "aria-label": string;
  /** `vertical` (the default) stacks the items; `horizontal` lays them in a row. */
  orientation?: "vertical" | "horizontal";
  /**
   * Draws a grip at the start of each row and makes only that the drag
   * handle, so buttons and links inside the row keep working. Without it the
   * whole row is the handle.
   */
  handle?: boolean;
  /** Items that cannot be picked up. Others can still be dropped around them. */
  isItemDisabled?(item: T, index: number): boolean;
  /** Names an item in announcements. Defaults to its `title`, `label` or `name`. */
  getItemLabel?(item: T, index: number): string;
  className?: string;
}

/** One column of a `Kanban`. */
export interface PluginKanbanColumn {
  /** Unique; keys the column's cards in `cards`. */
  id: string;
  title: string;
  /** A work-in-progress limit: the header shows the count against it and warns past it. It never refuses a drop. */
  limit?: number;
  /** Shown in an empty column. Defaults to "No cards". */
  empty?: ReactNode;
}

/** A card's move, reported once on drop. */
export interface PluginKanbanMove {
  cardId: PluginDragId;
  fromColumn: string;
  toColumn: string;
  /** The card's index in `fromColumn` before the move. */
  fromIndex: number;
  /** The card's index in `toColumn` after the move. */
  index: number;
}

/** Handed to `Kanban`'s `renderCard`. */
export interface PluginKanbanCardState extends PluginSortableItemState {
  /** The column it is drawn in: while held by keyboard, the column it would land in. */
  columnId: string;
}

/**
 * Props of `Kanban`: columns of cards the user moves between columns and
 * reorders within one, by pointer or keyboard (Space picks the focused card
 * up, Up/Down move it in its column, Left/Right move it to the next column,
 * Space drops, Escape puts it back), or from a card's context menu
 * (right-click, or Shift+F10), which also moves it to another column. The
 * board scrolls sideways when its
 * columns overflow and each column scrolls on its own, so give the board a
 * height (`h-full` in a sized pane). It does not move cards itself: apply
 * `onMove` to `cards`.
 */
export interface PluginKanbanProps<T = unknown> extends PluginRootAttributes {
  columns: readonly PluginKanbanColumn[];
  /** Each column's cards in order, keyed by column id. A column without an entry is empty. */
  cards: Readonly<Record<string, readonly T[]>>;
  /** A stable id per card, unique across the board. Defaults to the card's own `id` field. */
  getCardId?(card: T): PluginDragId;
  /** Renders a card's content; the board draws the card surface, its hover and its lift. */
  renderCard(card: T, state: PluginKanbanCardState): ReactNode;
  onMove?(move: PluginKanbanMove): void;
  /** Required: names the board for assistive tech ("Sprint board"). */
  "aria-label": string;
  /** Draws a grip on each card and makes only that the drag handle, as `SortableList`'s does. */
  handle?: boolean;
  isCardDisabled?(card: T): boolean;
  /** Names a card in announcements. Defaults to its `title`, `label` or `name`. */
  getCardLabel?(card: T): string;
  /** Controls at the end of a column's header, such as an "Add card" button. */
  columnActions?(column: PluginKanbanColumn): ReactNode;
  /** Gives each column header a button that folds it to a narrow strip. A folded column still takes drops. */
  collapsible?: boolean;
  collapsedColumns?: readonly string[];
  defaultCollapsedColumns?: readonly string[];
  onCollapsedColumnsChange?(columnIds: string[]): void;
  /** Column width in px, 200 to 480. Defaults to 272. */
  columnWidth?: number;
  className?: string;
}
