// Overlays: dropdown and context menus, dialogs, popovers, sheets, command
// palettes, inline confirms and hover cards.

import type { ReactElement, ReactNode } from "react";
import type { PluginActionMenuItem } from "./agents.js";
import type { PluginAlign, PluginDomProps, PluginIconSource, PluginSide } from "./common.js";

/** One row of a `DropdownMenu`. */
export type PluginDropdownMenuEntry =
  | {
      type?: "item";
      label: string;
      onSelect: () => void;
      icon?: PluginIconSource;
      /** A canonical combo shown in the key column, e.g. `"Cmd+Enter"`. */
      shortcut?: string;
      disabled?: boolean;
      destructive?: boolean;
      /** A quiet second line under the label saying what the item does. */
      description?: string;
    }
  | {
      type: "checkbox";
      label: string;
      checked: boolean;
      onCheckedChange: (checked: boolean) => void;
      disabled?: boolean;
      /** A quiet second line under the label. */
      description?: string;
    }
  | {
      /**
       * A row with a chevron that opens `items` in a nested menu: hovering
       * or Right Arrow opens it, Left Arrow or Escape closes it, and typing
       * jumps between its rows. The nested rows take every entry type,
       * submenus included.
       */
      type: "submenu";
      label: string;
      items: readonly PluginDropdownMenuEntry[];
      icon?: PluginIconSource;
      disabled?: boolean;
      /** A quiet second line under the label. */
      description?: string;
    }
  | {
      /** One choice from several, each a radio row with a check on the chosen one. */
      type: "radio-group";
      value: string;
      onValueChange: (value: string) => void;
      items: readonly PluginDropdownMenuRadioItem[];
      /** A heading over the group. */
      label?: string;
    }
  | { type: "label"; label: string }
  | { type: "separator" }
  /** A row that runs one of Daintree's actions; see {@link PluginActionMenuItem}. */
  | PluginActionMenuItem;

/** One choice of a `radio-group` menu entry. */
export interface PluginDropdownMenuRadioItem {
  /** Non-empty and unique within the group. */
  value: string;
  label: string;
  disabled?: boolean;
}

/** Props of `DropdownMenu`. The menu renders in a host overlay, so it takes no classes. */
export interface PluginDropdownMenuProps {
  /** The element that opens it; it must accept a ref and DOM props (a kit `Button` does). */
  trigger: ReactElement;
  items: readonly PluginDropdownMenuEntry[];
  side?: PluginSide;
  align?: PluginAlign;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  "aria-label"?: string;
  /**
   * Runs as the menu closes, before focus returns to the trigger. Call
   * `event.preventDefault()` to keep focus where your handler moved it.
   */
  onCloseAutoFocus?: (event: Event) => void;
  /**
   * Stops clicks, pointer and key events inside the menu from reaching the
   * view's own handlers. React events travel up through the overlay to the
   * trigger's ancestors, so a menu on a clickable row would otherwise also
   * activate the row.
   */
  stopPropagation?: boolean;
}

/** A footer button of a `Dialog`. */
export interface PluginDialogAction {
  label: string;
  onClick: () => void;
  /** Stays focusable and announced unavailable (`aria-disabled`); clicks do nothing. */
  disabled?: boolean;
  /**
   * `primaryAction` only: why it is unavailable. Shown as the footer's hint
   * while `disabled` (when the dialog has no `hint` of its own) and read with
   * the button.
   */
  disabledReason?: ReactNode;
  loading?: boolean;
  intent?: "default" | "destructive";
  /** A leading glyph. */
  icon?: PluginIconSource;
}

/**
 * Where a dialog stacks. `nested` is for a dialog opened from inside another
 * modal surface (Settings, another dialog), so it paints above it.
 */
export type PluginDialogLayer = "default" | "nested";

/** Props of `Dialog`, a modal with a title bar, a scrolling body and a footer. */
export interface PluginDialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /**
   * The title's glyph: a name, or your own element (a kit `Spinner` while it
   * works, a status-coloured `Icon` when it is done).
   */
  icon?: PluginIconSource;
  description?: ReactNode;
  children?: ReactNode;
  size?: "sm" | "md" | "lg";
  primaryAction?: PluginDialogAction;
  secondaryAction?: PluginDialogAction;
  /** A subdued line beside the actions: why the primary is unavailable, say. */
  hint?: ReactNode;
  /**
   * Your own footer controls in place of `primaryAction`/`secondaryAction`,
   * right-aligned after the `hint`: kit `Button`s, the primary last and
   * `contrast`.
   */
  footer?: ReactNode;
  /** False blocks Escape, the backdrop and the close button. Defaults to true. */
  dismissible?: boolean;
  layer?: PluginDialogLayer;
  /** On the dialog's root, for tests. */
  "data-testid"?: string;
}

/** Props of `ConfirmDialog`, the one confirm-or-cancel shape. */
export interface PluginConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** A verb-noun ("Delete branch"), never "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  variant?: "default" | "destructive" | "info";
  /** A name, or your own element. */
  icon?: PluginIconSource;
  /** The confirm is running: spinner on the button, dialog locked. */
  loading?: boolean;
  confirmDisabled?: boolean;
  /** `destructive` only: the user must type this exact text to enable the confirm. */
  typedNameTarget?: string;
  /** A subdued line beside the buttons: why the confirm is unavailable, say. */
  hint?: ReactNode;
  layer?: PluginDialogLayer;
}

/**
 * Props of `Popover`: a floating panel opened from `trigger`, for a filter, a
 * picker or a detail card. Focus moves in when it opens and back to the
 * trigger when it closes; Escape and a click outside close it. The panel
 * renders in a host overlay, so it takes no classes: style your own content.
 */
export interface PluginPopoverProps {
  /** The element that opens it; it must accept a ref and DOM props (a kit `Button` does). */
  trigger: ReactElement;
  /** The panel's content. */
  children?: ReactNode;
  side?: PluginSide;
  align?: PluginAlign;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** `sm` 14rem, `md` 18rem (the default), `lg` 24rem, `trigger` as wide as the trigger, `auto` the content's own width. */
  width?: "sm" | "md" | "lg" | "trigger" | "auto";
  /** `default` pads the panel; `none` for a list or a `PopoverSearchField` that runs edge to edge. */
  padding?: "default" | "none";
  "aria-label"?: string;
  /** As on `DropdownMenu`. */
  onCloseAutoFocus?: (event: Event) => void;
}

/**
 * Props of `PopoverSearchField`: the full-width search strip at the top of a
 * filtering `Popover` (with `padding="none"`). Controlled only. Anywhere else,
 * use `SearchField`.
 */
export interface PluginPopoverSearchFieldProps extends PluginDomProps<HTMLInputElement> {
  value: string;
  onValueChange?: (value: string) => void;
  /** Shows the clear button while there is text. */
  onClear?: () => void;
  placeholder?: string;
  "aria-label"?: string;
  clearLabel?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}

/**
 * Props of `ContextMenu`: the menu a right-click on `children` opens, built
 * from the same rows as `DropdownMenu`. From the keyboard, Shift+F10 or the
 * Menu key opens it while focus is anywhere inside `children`. The menu
 * renders in a host overlay, so it takes no classes.
 */
export interface PluginContextMenuProps {
  /** The surface it belongs to: one element that accepts a ref and DOM props (a row, a card). */
  children: ReactElement;
  items: readonly PluginDropdownMenuEntry[];
  /** Called as the menu opens and closes. A context menu opens only from a gesture, so there is no `open`. */
  onOpenChange?: (open: boolean) => void;
  "aria-label"?: string;
  /** Renders `children` alone, with no menu: while a row is being renamed, say. */
  disabled?: boolean;
  /** As on `DropdownMenu`. */
  onCloseAutoFocus?: (event: Event) => void;
  /** As on `DropdownMenu`: keeps events inside the menu off the view's own handlers. */
  stopPropagation?: boolean;
}

/**
 * Props of `Sheet`: a full-height panel that slides in from the window's
 * edge over a scrim, for a record's detail or edit form beside the list it
 * came from. It has a `Dialog`'s parts (title bar, scrolling body, footer
 * actions) and behaves as one: focus moves in and stays in while it is open,
 * and goes back to where it was when it closes.
 */
export interface PluginSheetProps {
  open: boolean;
  /** Called with `false` for Escape, the scrim and the close button. */
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** The title's glyph: a name, or your own element. */
  icon?: PluginIconSource;
  description?: ReactNode;
  children?: ReactNode;
  /** The edge it opens against. Defaults to `right`. */
  side?: "right" | "left";
  /** `sm` 28rem, `md` 36rem (the default), `lg` 42rem, `xl` 56rem; never wider than the window. */
  size?: "sm" | "md" | "lg" | "xl";
  primaryAction?: PluginDialogAction;
  secondaryAction?: PluginDialogAction;
  /** A subdued line beside the actions: why the primary is unavailable, say. */
  hint?: ReactNode;
  /** Your own footer controls in place of `primaryAction`/`secondaryAction`, as on `Dialog`. */
  footer?: ReactNode;
  /** False blocks Escape, the scrim and the close button. Defaults to true. */
  dismissible?: boolean;
  layer?: PluginDialogLayer;
  /** On the sheet's root, for tests. */
  "data-testid"?: string;
}

/** One row of a `CommandPalette`. */
export interface PluginCommandPaletteItem {
  /** Unique within the palette. */
  id: string;
  label: string;
  /** A second, quieter line: where the item lives, what it does. */
  description?: string;
  icon?: PluginIconSource;
  /** More words the search matches that are not on screen: synonyms, an issue number. */
  keywords?: readonly string[];
  /** A canonical combo shown at the row's end, e.g. `"Cmd+Shift+P"`. */
  shortcut?: string;
  /** Rows sharing a group sit together under its heading, in the order groups first appear. */
  group?: string;
  /** Shown but skipped by the cursor and never selected. */
  disabled?: boolean;
}

/**
 * Props of `CommandPalette`: Daintree's search palette as a quick switcher or
 * "jump to…": a search field over a virtualised list, fuzzy-matched on the
 * label, description and keywords with the matches marked. Up/Down move,
 * Enter selects, Escape clears the search and then closes. Selecting an item
 * closes the palette. It renders in a host overlay, so it takes no classes.
 */
export interface PluginCommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: readonly PluginCommandPaletteItem[];
  onSelect: (item: PluginCommandPaletteItem) => void;
  /** Required: the small heading over the search field, and the palette's accessible name ("Go to issue"). */
  title: string;
  placeholder?: string;
  /** A canonical combo beside the title: the shortcut that opens this palette. */
  shortcut?: string;
  /** Called as the search text changes, to fetch items for it. The text clears when the palette closes. */
  onQueryChange?: (query: string) => void;
  /**
   * `true` (the default) fuzzy-filters `items` by the search text. `false`
   * shows `items` as given, for a palette whose items come from a search you
   * run yourself in `onQueryChange`.
   */
  filter?: boolean;
  /** Items are still arriving: the header shows a loading bar and an empty list says nothing yet. */
  loading?: boolean;
  /** Shown when there are no items and no search text. */
  emptyText?: string;
  /** What Enter does to the highlighted item, shown in the footer ("Open issue"). */
  actionLabel?: string;
}

/**
 * Props of `ConfirmPopover`: a small "are you sure" anchored to its trigger,
 * for an action that is cheap to undo or easy to redo. For anything that
 * cannot be taken back, use `ConfirmDialog`.
 */
export interface PluginConfirmPopoverProps {
  /** The element that opens it; it must accept a ref and DOM props (a kit `Button` does). */
  trigger: ReactElement;
  /** The question, naming what it acts on: `"Clear all 12 snippets?"`. */
  message: string;
  /** The consequence, in a quieter line under the question. */
  description?: string;
  onConfirm: () => void;
  onCancel?: () => void;
  /** A verb-noun ("Clear snippets"). Defaults to "Confirm". */
  confirmLabel?: string;
  /** Defaults to "Cancel". */
  cancelLabel?: string;
  /**
   * `danger` draws the confirm as destructive and puts focus on Cancel when
   * it opens; `default` focuses the confirm.
   */
  tone?: "default" | "danger";
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: PluginSide;
  align?: PluginAlign;
}

/**
 * Props of `HoverCard`: a rich preview of a user, an issue or a commit that
 * opens over its trigger on hover or keyboard focus, on the host's hover-card
 * surface.
 */
export interface PluginHoverCardProps {
  /** One focusable element that accepts a ref and DOM props: a kit `Link`, a button. */
  children: ReactElement;
  /** The card's body. Empty, `null` or `false` renders the trigger alone. */
  content: ReactNode;
  /** Hover delay in ms before it opens. Defaults to 300, the host's own hover cards' delay. */
  openDelay?: number;
  /** How long in ms it stays after the pointer leaves the trigger and the card. Defaults to 150. */
  closeDelay?: number;
  /** Defaults to `bottom`. */
  side?: PluginSide;
  /** Defaults to `start`. */
  align?: PluginAlign;
  /** `md` (the default) is the host's 280px card; `sm` is 224px, `lg` 320px. */
  width?: "sm" | "md" | "lg";
  /** Controls whether it is open. Pair with `onOpenChange`. */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * What a screen reader reads for the card when it opens ("Ada Lovelace,
   * 214 commits"). Defaults to the card's text.
   */
  "aria-label"?: string;
  disabled?: boolean;
}
