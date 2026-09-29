/**
 * Public renderer-SDK type surface for `@daintreehq/plugin-sdk/react`.
 *
 * The runtime hooks (`useHostChannel`, `usePluginEvent`) live in `src/hooks/`
 * — the renderer's canonical home, where the `window.electron` ambient global
 * is in scope — and are re-exported verbatim by `packages/plugin-sdk/src/react`
 * so plugin authors and the host bundle share one implementation. These types
 * carry the public signatures; the package's declaration build inlines them.
 */

import type {
  AriaAttributes,
  DOMAttributes,
  HTMLAttributes,
  KeyboardEvent,
  ReactElement,
  ReactNode,
  Ref,
} from "react";

/**
 * Return shape of the `useHostChannel(pluginId, channel)` hook. `invoke`
 * resolves with the validated channel result on success, or `undefined` if
 * the host rejected the call (the rejection is surfaced via `error`). Only
 * the latest `invoke()` updates `loading` / `error` — stale earlier calls are
 * dropped to keep concurrent invocations coherent.
 */
export interface UseHostChannelResult<TArgs, TResult> {
  invoke: (args: TArgs) => Promise<TResult | undefined>;
  loading: boolean;
  error: Error | null;
}

/**
 * Handler signature for `usePluginEvent(pluginId, channel, handler)`. Receives
 * each payload pushed by the plugin's main-side `host.postToPanel(channel,
 * payload)`. Payloads arrive untyped over IPC; `TPayload` narrows the call site
 * — the hook performs no runtime validation (the plugin owns the shape it
 * pushes, mirroring `useHostChannel`'s host-owns-validation contract).
 */
export type PluginEventHandler<TPayload> = (payload: TPayload) => void;

/**
 * A reading size for {@link PluginMarkdownProps}, as a rung of Daintree's type
 * scale (11 · 12 · 14 · 16 · 18 · 20 · 24 · 30 px) — the rungs the user's own
 * Markdown text-size control steps through.
 */
export type PluginMarkdownFontSize = "2xs" | "xs" | "sm" | "base" | "lg" | "xl" | "2xl" | "3xl";

/**
 * Props of `Markdown` from `@daintreehq/plugin-ui`, the host's own Markdown
 * renderer served to plugin views through the import map. GFM (tables, task
 * lists, strikethrough, autolinks) is on and fenced code is highlighted. Raw
 * HTML in the source is dropped, never rendered, so untrusted text is safe to
 * pass.
 *
 * Links behave as in Daintree's own rendered Markdown: `http(s)` and `mailto`
 * open in the browser, relative links open in the file viewer when they stay
 * inside `rootPath`. Relative images load from disk under the same bound.
 */
export interface PluginMarkdownProps {
  /** The Markdown text. */
  source: string;
  /**
   * Absolute path relative links and images resolve against. A path ending in
   * a Markdown extension (`.md`, `.markdown`, `.mdx`, `.mkd`) is read as the
   * document itself and its directory is used; anything else, or a path ending
   * in `/`, is the directory. Omitted, relative references resolve against
   * `rootPath`, or not at all when that is omitted too.
   */
  basePath?: string;
  /**
   * Absolute directory that local images and relative links must stay inside.
   * Defaults to the directory `basePath` resolves to.
   */
  rootPath?: string;
  /** Classes for the document's root element. */
  className?: string;
  /** Reading size. Omitted, the document renders at Daintree's default Markdown size. */
  fontSize?: PluginMarkdownFontSize;
}

// The `@daintreehq/plugin-ui` kit. Every interface below is public contract:
// within a major version props are only ever added, never removed or narrowed.
// Props arrive from untyped JavaScript as often as from TypeScript, so the host
// validates each one at runtime and ignores values outside these types.

/**
 * DOM props every non-portalled kit control forwards to its root element:
 * `id`, `title`, `tabIndex`, `role`, `style`, any `aria-*` or `data-*`
 * attribute, and DOM event handlers. This is also what lets a kit control be
 * the `trigger` of a `DropdownMenu` or the child of a `Tooltip`.
 */
export interface PluginDomProps<T extends Element = HTMLElement>
  extends
    AriaAttributes,
    Omit<DOMAttributes<T>, "children" | "dangerouslySetInnerHTML">,
    Pick<HTMLAttributes<T>, "id" | "title" | "tabIndex" | "role" | "style"> {
  [dataAttribute: `data-${string}`]: string | number | boolean | undefined;
  ref?: Ref<T>;
}

/**
 * The icon names `Icon` (and every kit prop that takes an icon) can draw.
 * Lucide-style kebab-case names, plus Daintree concept icons: `worktree`
 * (a git worktree), `daintree` (the app's mark). The set only grows.
 */
export type PluginIconName =
  | "activity"
  | "alert-octagon"
  | "alert-triangle"
  | "arrow-down"
  | "arrow-left"
  | "arrow-right"
  | "arrow-up"
  | "arrow-up-right"
  | "at-sign"
  | "bell"
  | "bell-dot"
  | "book-open"
  | "bookmark"
  | "bot"
  | "braces"
  | "bug"
  | "calendar"
  | "chart-column"
  | "chart-line"
  | "chart-pie"
  | "check"
  | "check-square"
  | "chevron-down"
  | "chevron-left"
  | "chevron-right"
  | "chevron-up"
  | "circle-check"
  | "circle-dashed"
  | "circle-dot"
  | "circle-slash"
  | "circle-x"
  | "clipboard"
  | "clock"
  | "cloud"
  | "cloud-off"
  | "code"
  | "copy"
  | "daintree"
  | "database"
  | "download"
  | "external-link"
  | "eye"
  | "eye-off"
  | "file"
  | "file-code"
  | "file-diff"
  | "file-plus"
  | "file-text"
  | "filter"
  | "flame"
  | "flask"
  | "folder"
  | "folder-open"
  | "folder-tree"
  | "gauge"
  | "git-branch"
  | "git-branch-plus"
  | "git-commit"
  | "git-compare"
  | "git-fork"
  | "git-merge"
  | "git-merge-conflict"
  | "git-pull-request"
  | "git-pull-request-closed"
  | "git-pull-request-draft"
  | "globe"
  | "grip-vertical"
  | "hash"
  | "help"
  | "history"
  | "home"
  | "hourglass"
  | "image"
  | "inbox"
  | "info"
  | "key"
  | "layers"
  | "layout-grid"
  | "layout-panel-top"
  | "lightbulb"
  | "link"
  | "list"
  | "list-checks"
  | "list-todo"
  | "loader"
  | "lock"
  | "mail"
  | "maximize"
  | "menu"
  | "message-square"
  | "minimize"
  | "minus"
  | "monitor"
  | "monitor-play"
  | "more-horizontal"
  | "more-vertical"
  | "notebook"
  | "package"
  | "panel-left"
  | "panel-right"
  | "paperclip"
  | "pause"
  | "pencil"
  | "pin"
  | "pin-off"
  | "play"
  | "plug"
  | "plus"
  | "puzzle"
  | "redo"
  | "refresh"
  | "rocket"
  | "rotate-ccw"
  | "save"
  | "search"
  | "send"
  | "server"
  | "settings"
  | "share"
  | "shield"
  | "sliders"
  | "sort"
  | "sparkles"
  | "square"
  | "star"
  | "sticky-note"
  | "table"
  | "tag"
  | "target"
  | "terminal"
  | "trash"
  | "undo"
  | "unlink"
  | "unlock"
  | "upload"
  | "user"
  | "users"
  | "workflow"
  | "worktree"
  | "wrench"
  | "x"
  | "zap";

/** Props of `Icon`. */
export interface PluginIconProps {
  name: PluginIconName;
  /** Square size in px. Defaults to 16. Inside a kit `Button` the button sizes it. */
  size?: number;
  className?: string;
  /** Names the icon for assistive tech. Omitted, the icon is decorative (`aria-hidden`). */
  "aria-label"?: string;
}

/**
 * An icon a kit prop can take: a {@link PluginIconName}, or your own element
 * (an inline `<svg>`). A string is always read as a name, never as text.
 */
export type PluginIconSource = PluginIconName | ReactElement;

export type PluginButtonVariant =
  | "default"
  | "secondary"
  | "outline"
  | "ghost"
  | "subtle"
  | "contrast"
  | "destructive"
  | "ghost-danger"
  | "link";

/** Props of `Button`. */
export interface PluginButtonProps extends PluginDomProps<HTMLButtonElement> {
  children?: ReactNode;
  /** `default` is the accent-filled primary; use it for at most one action per region. */
  variant?: PluginButtonVariant;
  size?: "default" | "sm" | "xs" | "lg";
  /** A leading icon before the label. */
  icon?: PluginIconSource;
  /** Overlays a spinner and blocks activation while keeping focus and width. */
  loading?: boolean;
  /** Makes the button a toggle (`aria-pressed`) drawn with the shared pressed look. */
  pressed?: boolean;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  className?: string;
}

/** Props of `IconButton`: an icon-only button with its accessible name as its tooltip. */
export interface PluginIconButtonProps extends Omit<
  PluginDomProps<HTMLButtonElement>,
  "aria-label" | "title"
> {
  icon: PluginIconSource;
  /** Required: an icon-only control has no other name. */
  "aria-label": string;
  /** Tooltip text. Defaults to `aria-label`; pass `false` for none. */
  tooltip?: ReactNode | false;
  tooltipSide?: PluginSide;
  variant?: "ghost" | "outline" | "subtle" | "ghost-danger";
  /** `default` 32px, `sm` 28px, `xs` 24px. */
  size?: "default" | "sm" | "xs";
  loading?: boolean;
  pressed?: boolean;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  className?: string;
}

export type PluginSide = "top" | "right" | "bottom" | "left";
export type PluginAlign = "start" | "center" | "end";

/** Props of `Tooltip`. The content renders in a host overlay, so it takes no classes. */
export interface PluginTooltipProps {
  /** One element that accepts a ref and DOM props: a kit control or a plain element. */
  children: ReactElement;
  /** Tooltip body. Empty, `null` or `false` renders the child alone. */
  content: ReactNode;
  side?: PluginSide;
  align?: PluginAlign;
  /** Hover delay in ms before it opens. */
  delayDuration?: number;
  disabled?: boolean;
}

/** Props of `TruncatedTooltip`: shows `content` only while the child's text is cut off. */
export interface PluginTruncatedTooltipProps {
  /** One element carrying the `truncate` text; it must accept a ref. */
  children: ReactElement;
  /** Usually the full, untruncated text. */
  content: ReactNode;
  side?: PluginSide;
  align?: PluginAlign;
  /**
   * False inside a row that already owns the keyboard (a button, a menu item),
   * so the text does not become a second tab stop. Defaults to true.
   */
  focusable?: boolean;
}

export type PluginSpinnerSize = "xs" | "sm" | "md" | "lg" | "xl" | "2xl";

/** Props of `Spinner`. Decorative: say what is loading in text beside it. */
export interface PluginSpinnerProps {
  size?: PluginSpinnerSize;
  className?: string;
}

/** Props of `SpinningIcon`: an icon that finishes its current turn before it stops. */
export interface PluginSpinningIconProps {
  icon: PluginIconName;
  /** True while the operation runs. It always plays at least one full turn. */
  active: boolean;
  /** Square size in px. Defaults to 16. */
  size?: number;
  className?: string;
}

/**
 * The kit's status vocabulary is shared by `Badge` and `Callout`: `error`,
 * `danger`, `warning`, `success`, `info`, `neutral`. `error` and `danger` draw
 * the same colour (the `status-error` class aliases the `status-danger` theme
 * token); a `Badge` renders them identically, while a `Callout` gives
 * `danger` (a destructive caution) its own glyph. `outline` is a Badge-only, uncoloured shape.
 */
export type PluginBadgeTone =
  "neutral" | "outline" | "error" | "danger" | "warning" | "success" | "info";

/** Props of `Badge`. Presentation only: wrap it in a `Button` to make it clickable. */
export interface PluginBadgeProps extends PluginDomProps<HTMLSpanElement> {
  children?: ReactNode;
  tone?: PluginBadgeTone;
  size?: "xs" | "sm" | "md";
  shape?: "default" | "pill";
  className?: string;
}

/** Props of `Checkbox`. Pair it with a `<label htmlFor>` or give it an `aria-label`. */
export interface PluginCheckboxProps extends PluginDomProps<HTMLButtonElement> {
  checked?: boolean | "indeterminate";
  defaultChecked?: boolean;
  /** Receives the new state; an indeterminate box always resolves to `true`. */
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  invalid?: boolean;
  required?: boolean;
  name?: string;
  value?: string;
  size?: "sm" | "md";
  className?: string;
}

/** Props of `Input`, a single-line text field. */
export interface PluginInputProps extends PluginDomProps<HTMLInputElement> {
  type?: "text" | "search" | "email" | "url" | "password" | "number" | "tel";
  value?: string | number;
  defaultValue?: string | number;
  /** The new text on every edit, beside the native `onChange` event. */
  onValueChange?: (value: string) => void;
  placeholder?: string;
  name?: string;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  autoComplete?: string;
  spellCheck?: boolean;
  maxLength?: number;
  min?: number | string;
  max?: number | string;
  step?: number | string;
  invalid?: boolean;
  /** `compact` for toolbars and filter strips. */
  density?: "default" | "compact";
  className?: string;
}

/** Props of `Textarea`. */
export interface PluginTextareaProps extends PluginDomProps<HTMLTextAreaElement> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  name?: string;
  rows?: number;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  spellCheck?: boolean;
  maxLength?: number;
  invalid?: boolean;
  density?: "default" | "compact";
  /** `code` for paths, prompts, JSON: anything read character by character. */
  variant?: "default" | "code";
  resize?: "vertical" | "none";
  className?: string;
}

/** One choice in a `Select` or `SegmentedControl`. */
export interface PluginSelectOption {
  /** Non-empty and unique within the control. */
  value: string;
  label: string;
  /** A second line under the label (`Select` only). */
  description?: string;
  disabled?: boolean;
}

/** A labelled run of options in a `Select`. */
export interface PluginSelectOptionGroup {
  label: string;
  options: readonly PluginSelectOption[];
}

/** Props of `Select`. The list opens in a host overlay, so only the trigger takes classes. */
export interface PluginSelectProps {
  options: readonly (PluginSelectOption | PluginSelectOptionGroup)[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Shown while nothing is chosen. */
  placeholder?: string;
  disabled?: boolean;
  /** `compact` (28px) beside a compact `SearchField` in a filter bar. */
  density?: "default" | "compact";
  name?: string;
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  /** Classes for the trigger. */
  className?: string;
}

/** One segment of a `SegmentedControl`. */
export interface PluginSegmentedOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Spoken name when the visible label is an abbreviation. */
  "aria-label"?: string;
  /** Hover detail. */
  tooltip?: ReactNode;
}

/** Props of `SegmentedControl`: pick exactly one of a few options. */
export interface PluginSegmentedControlProps {
  options: readonly PluginSegmentedOption[];
  value: string;
  onValueChange: (value: string) => void;
  "aria-label": string;
  "aria-describedby"?: string;
  disabled?: boolean;
  /** Fill the container, splitting it evenly. */
  fullWidth?: boolean;
  /** `compact` (24px) for a 32px toolbar strip. */
  density?: "default" | "compact";
  className?: string;
}

/** Props of `Kbd`: one literal key cap. */
export interface PluginKbdProps {
  children: ReactNode;
  className?: string;
}

/** Props of `KbdChord`: a shortcut drawn the platform's way. */
export interface PluginKbdChordProps {
  /** The canonical combo, e.g. `"Cmd+Shift+P"` or a two-step `"Cmd+K T"`. */
  shortcut: string;
  /** `compact` for dense rows; `bare` drops the key boxes where every row has a binding. */
  density?: "default" | "compact" | "bare";
  foreground?: "secondary" | "primary" | "inverse";
  /** Spoken form. Defaults to the chord described in words. */
  "aria-label"?: string;
  className?: string;
}

interface PluginCopyButtonBaseProps {
  /** The text to copy, or a function read at click time. A throw counts as a failed copy. */
  text: string | (() => string | Promise<string>);
  tooltip?: ReactNode;
  tooltipSide?: PluginSide;
  onCopied?: () => void;
  /** Report the failure yourself; the button then stays quiet about it. */
  onCopyError?: (error: unknown) => void;
  disabled?: boolean;
  className?: string;
}

/** Props of `CopyButton`: icon-only (with `aria-label`) or labelled (with `label`). */
export type PluginCopyButtonProps =
  | (PluginCopyButtonBaseProps & {
      label?: undefined;
      "aria-label": string;
      size?: "xs" | "sm";
    })
  | (PluginCopyButtonBaseProps & {
      /** The visible verb-noun ("Copy path"); reads "Copied" for a moment after. */
      label: string;
      "aria-label"?: string;
      variant?: "ghost" | "outline" | "subtle";
      size?: "xs" | "sm" | "default";
    });

/** Props of `DismissButton`, the X that closes a card, banner or hint. */
export interface PluginDismissButtonProps {
  /** Names what goes away ("Dismiss tip"), not just "Dismiss". */
  "aria-label": string;
  onClick: () => void;
  /** Defaults to "Dismiss". */
  tooltip?: ReactNode;
  disabled?: boolean;
  className?: string;
}

/** The shared status vocabulary; see `PluginBadgeTone` for how `error` and `danger` relate. */
export type PluginCalloutSeverity = "error" | "warning" | "danger" | "success" | "info" | "neutral";

/** Props of `Callout`, an inline message box. The glyph follows the severity. */
export interface PluginCalloutProps {
  severity: PluginCalloutSeverity;
  children?: ReactNode;
  title?: ReactNode;
  /** One trailing control, such as a Retry button. */
  action?: ReactNode;
  /** A domain glyph in place of the info mark, for `neutral` only. */
  icon?: PluginIconName;
  size?: "default" | "compact";
  className?: string;
}

/** Props of `EmptyState`. */
export interface PluginEmptyStateProps {
  title: string;
  /**
   * `zero-data`: nothing here yet (invites an action). `filtered-empty`: a
   * filter matched nothing (no icon). `user-cleared`: the user finished
   * (no description or action). Defaults to `zero-data`.
   */
  variant?: "zero-data" | "filtered-empty" | "user-cleared";
  /** `canvas` for a whole pane (the default); `sidebar`/`popover` for narrow containers. */
  scale?: "canvas" | "sidebar" | "popover";
  /** Shown at `canvas` scale only. */
  description?: ReactNode;
  icon?: PluginIconSource;
  action?: ReactNode;
  className?: string;
}

/** Props of `Skeleton`, the accessible loading region that holds skeleton bones. */
export interface PluginSkeletonProps {
  children?: ReactNode;
  /** Spoken while loading. Defaults to "Loading". */
  label?: string;
  className?: string;
}

/** Props of `SkeletonBone`, one placeholder shape. Appears after a short delay to avoid flicker. */
export interface PluginSkeletonBoneProps {
  className?: string;
  /** Fixed height, so nothing shifts when the content arrives. */
  heightPx?: number;
  shimmer?: boolean;
}

/** Props of `SkeletonText`, ragged placeholder lines. */
export interface PluginSkeletonTextProps {
  /** Defaults to 3. */
  lines?: number;
  shimmer?: boolean;
  className?: string;
}

/** Props of `ScrollShadow`: a vertical scroller with fades that show there is more. */
export interface PluginScrollShadowProps {
  children: ReactNode;
  /** Classes for the outer frame (size it here). */
  className?: string;
  /** Classes for the scrolling element (padding goes here). */
  scrollClassName?: string;
  /** A shorter fade, for lists of short rows. */
  compact?: boolean;
  /** The scrolling element. */
  ref?: Ref<HTMLDivElement>;
}

/** Props of `SearchField`: magnifier, text and an optional clear button in one field. */
/** Controlled only: pass `value` and update it from `onValueChange`. */
export interface PluginSearchFieldProps extends PluginDomProps<HTMLInputElement> {
  value: string;
  onValueChange?: (value: string) => void;
  /** Shows the clear button while there is text, and makes Escape clear first. */
  onClear?: () => void;
  placeholder?: string;
  "aria-label"?: string;
  clearLabel?: string;
  /** `compact` 28px (default), `dense` 24px, `palette` 38px. */
  size?: "compact" | "dense" | "palette";
  autoFocus?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  /** Classes for the visible field. */
  className?: string;
}

/** One row of a `DropdownMenu`. */
export type PluginDropdownMenuEntry =
  | {
      type?: "item";
      label: string;
      onSelect: () => void;
      icon?: PluginIconName;
      /** A canonical combo shown in the key column, e.g. `"Cmd+Enter"`. */
      shortcut?: string;
      disabled?: boolean;
      destructive?: boolean;
    }
  | {
      type: "checkbox";
      label: string;
      checked: boolean;
      onCheckedChange: (checked: boolean) => void;
      disabled?: boolean;
    }
  | { type: "label"; label: string }
  | { type: "separator" };

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
}

/** A footer button of a `Dialog`. */
export interface PluginDialogAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  intent?: "default" | "destructive";
}

/** Props of `Dialog`, a modal with a title bar, a scrolling body and a footer. */
export interface PluginDialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  icon?: PluginIconName;
  description?: ReactNode;
  children?: ReactNode;
  size?: "sm" | "md" | "lg";
  primaryAction?: PluginDialogAction;
  secondaryAction?: PluginDialogAction;
  /** A subdued line beside the actions: why the primary is unavailable, say. */
  hint?: ReactNode;
  /** False blocks Escape, the backdrop and the close button. Defaults to true. */
  dismissible?: boolean;
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
  icon?: PluginIconName;
  /** The confirm is running: spinner on the button, dialog locked. */
  loading?: boolean;
  confirmDisabled?: boolean;
  /** `destructive` only: the user must type this exact text to enable the confirm. */
  typedNameTarget?: string;
}

// Kit 1.1: lists, pane chrome, forms, settings grammar and severity.

/**
 * Props of `VirtualList`: a windowed list that mounts only the rows in view,
 * so ten thousand items cost what forty do. It fills its container's height;
 * give the container one (`h-full` in a sized pane, or a fixed height).
 *
 * The DOM props land on the element that directly holds the rows. Spread
 * `useListNavigation().containerProps` here to make it a keyboard listbox; the
 * rows are then options (`getRowProps(index)` on each `ListRow`). Without a
 * `role` it is a plain `list` and each row is a `listitem`.
 */
export interface PluginVirtualListProps<T = unknown> extends PluginDomProps<HTMLDivElement> {
  /** The rows. Omit and pass `count` when rows are fetched by index. */
  items?: readonly T[];
  /** The row count when there is no `items` array. Ignored when `items` is given. */
  count?: number;
  /** Renders one row. `item` is `undefined` for a `count`-only list. */
  renderItem(index: number, item: T | undefined): ReactNode;
  /** A stable key per row. Defaults to the index, which re-mounts rows when the list reorders. */
  itemKey?(index: number, item: T | undefined): string | number;
  /** Expected row height in px, before rows are measured. Defaults to 28. */
  estimatedItemSize?: number;
  /** Rows rendered beyond each edge of the viewport. Defaults to 8. */
  overscan?: number;
  /** Called once the last row scrolls into view: load the next page here. */
  onEndReached?: (lastIndex: number) => void;
  /** Keeps this row in view as it changes: the keyboard cursor from `useListNavigation`. */
  activeIndex?: number;
  /** Required: names the list for assistive tech. */
  "aria-label": string;
  /** Classes for the scrolling element. */
  className?: string;
}

/** One column of a `DataTable`. */
export interface PluginDataTableColumn<T = unknown> {
  /** Unique within the table; also the row field read when there is no `render`. */
  id: string;
  header: ReactNode;
  /** Fixed width: px as a number, or any CSS length. Columns without one share the rest. */
  width?: number | string;
  align?: "start" | "center" | "end";
  /** Draws the header as a sort button that reports through `onSortChange`. */
  sortable?: boolean;
  /** The cell. Defaults to `row[id]` when that is a string or a number. */
  render?(row: T, index: number): ReactNode;
}

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
 * Props of `DataTable`: a table whose body is always virtualised, with a
 * header that stays put. It fills its container's height, like `VirtualList`.
 * With `onRowClick` the table is a keyboard grid: one tab stop, Up/Down/Home/End
 * move the cursor and Enter activates the row.
 */
export interface PluginDataTableProps<T = unknown> {
  columns: readonly PluginDataTableColumn<T>[];
  rows: readonly T[];
  /** A stable key per row: a function, or the name of a string or number field. */
  rowKey: PluginDataTableRowKey<T> | string;
  /** The current sort, controlled. `null` or omitted is unsorted. */
  sort?: PluginDataTableSort | null;
  /** A sortable header was activated: ascending first, then it flips. */
  onSortChange?: (sort: PluginDataTableSort) => void;
  onRowClick?(row: T, index: number): void;
  /** The key of the one selected row, drawn with the list highlight. */
  selectedRowKey?: string | number | null;
  /** Shown in place of the body while `rows` is empty: usually an `EmptyState`. */
  empty?: ReactNode;
  /** Expected row height in px. Defaults to 28. */
  estimatedRowSize?: number;
  onEndReached?: (lastIndex: number) => void;
  /** Required: names the table for assistive tech. */
  "aria-label": string;
  /** Classes for the scrolling element. */
  className?: string;
}

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
export interface PluginLogViewProps {
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

/** Props of `PaneHeader`: a pane's compact title bar. */
export interface PluginPaneHeaderProps {
  title: ReactNode;
  icon?: PluginIconSource;
  /** One quiet line after the title: a count, a path, a filter in effect. */
  subtitle?: ReactNode;
  /** Trailing controls, usually a `Toolbar` of `ToolbarButton`s. */
  actions?: ReactNode;
  className?: string;
}

/**
 * Props of `Toolbar`: a row of controls that is one tab stop, with Left/Right
 * moving between them (the WAI-ARIA toolbar pattern). `bar` draws the row as a
 * pane's toolbar strip; `inline` (the default) is the bare group, for inside a
 * `PaneHeader`.
 */
export interface PluginToolbarProps {
  children?: ReactNode;
  /** Required: two toolbars on screen must be told apart. */
  "aria-label": string;
  variant?: "inline" | "bar";
  className?: string;
}

/**
 * Props of `ToolbarButton`, the in-pane toolbar control: icon-only (its
 * `aria-label` doubles as the tooltip) or, with `label`, an icon and a word.
 */
export interface PluginToolbarButtonProps {
  icon?: PluginIconSource;
  /** Visible text. Omitted, the button is icon-only and `aria-label` names it. */
  label?: string;
  "aria-label"?: string;
  onClick?: () => void;
  /** A toggle's state (`aria-pressed`). */
  pressed?: boolean;
  /** A disclosure's state (`aria-expanded`). Never set with `pressed`. */
  expanded?: boolean;
  /** Stays in the arrow-key order, announced unavailable, and ignores clicks. */
  disabled?: boolean;
  /** Tooltip text when it says more than the name (a shortcut). `false` for none. */
  tooltip?: ReactNode | false;
  tooltipSide?: "top" | "bottom";
}

/**
 * Props of `PaneState`, what a whole pane shows instead of its content.
 * `loading` stays blank for the first 400ms and then shows a spinner and the
 * title; `empty` is a zero-data state; `error` is announced and offers Retry
 * when `onRetry` is given. For an error inside content that still renders,
 * use `Callout` with `severity="error"` and a Retry `action` instead.
 */
export interface PluginPaneStateProps {
  kind: "loading" | "empty" | "error";
  /** For `loading`, the phase in words ("Loading issues"). */
  title: string;
  description?: ReactNode;
  /** `empty` only. `error` always wears the error glyph. */
  icon?: PluginIconSource;
  /** Controls under the text: an `empty` state's next step, an `error`'s extra way out. */
  action?: ReactNode;
  /** `error` only: draws a Retry button that calls this. */
  onRetry?: () => void;
  /** Defaults to "Retry". */
  retryLabel?: string;
  /** `loading` only: offers Cancel once the wait runs long. */
  onCancel?: () => void;
  className?: string;
}

/** What a `FormField` hands a control of your own: spread it onto the control. */
export interface PluginFormFieldControlProps {
  id: string;
  "aria-labelledby"?: string;
  /** The error, then the description. */
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

/**
 * Props of `FormField`: a label, an optional description and error, and the
 * control they describe, wired for assistive tech. Kit controls (`Input`,
 * `Textarea`, `Select`, `Checkbox`, `Switch`) join the field on their own. For
 * a control of your own, pass `children` as a function and spread the props
 * it receives onto the control; `htmlFor` alone links the label only.
 */
export interface PluginFormFieldProps {
  label: ReactNode;
  description?: ReactNode;
  /** Shown under the control, and marks the control invalid. */
  error?: ReactNode;
  /** Says "Required" beside the label. Also pass `required` to the control. */
  required?: boolean;
  /** The id of your own control, when it is not rendered through a `children` function. */
  htmlFor?: string;
  /** `horizontal` puts a checkbox or switch before its label, and makes the row clickable. */
  orientation?: "vertical" | "horizontal";
  /** Dims the label. Also pass `disabled` to the control. */
  disabled?: boolean;
  children: ReactNode | ((control: PluginFormFieldControlProps) => ReactNode);
  className?: string;
}

/** Props of `Switch`: an instant on/off setting. Use `Checkbox` in forms with a Save. */
export interface PluginSwitchProps extends PluginDomProps<HTMLButtonElement> {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  name?: string;
  size?: "sm" | "md";
  className?: string;
}

/** One tab of `Tabs`. */
export interface PluginTabItem {
  value: string;
  label: string;
  icon?: PluginIconName;
  /** A count or short tag after the label. A number draws a count pill. */
  badge?: ReactNode;
}

/**
 * Props of `Tabs`: switches between panes of content (not a value picker; for
 * that use `SegmentedControl`). Arrow keys and Home/End move and select.
 * Supply the active pane as `children` (a node, or a function of the value)
 * or as a `content` map by value.
 */
export interface PluginTabsProps {
  items: readonly PluginTabItem[];
  value: string;
  onValueChange: (value: string) => void;
  "aria-label": string;
  children?: ReactNode | ((value: string) => ReactNode);
  content?: Readonly<Record<string, ReactNode>>;
  /** `strip` fills a fixed-height chrome row; `page` (the default) sits above content. */
  density?: "page" | "strip";
  className?: string;
  /** Classes for the tab panel. */
  panelClassName?: string;
}

/**
 * Props of `ProgressBar`. Always neutral: progress is status, not a call to
 * action, so it never takes the accent or a status colour.
 */
export interface PluginProgressBarProps {
  /** 0 to 1. Omitted or `null` is indeterminate. */
  value?: number | null;
  /** Forces the indeterminate pulse whatever `value` says. */
  indeterminate?: boolean;
  /** Required: the accessible name. */
  label: string;
  /** Spoken instead of the percentage ("3 of 10 files"). */
  valueText?: string;
  /** `thin` is 2px, for under a line of text. */
  size?: "default" | "thin";
  className?: string;
}

/**
 * Props of `SettingsSection`, the top of the settings grammar: a page is a
 * stack of sections, a section holds `SettingsGroup`s, a group holds
 * `SettingsRow`s. Sentence-case titles, no icons.
 */
export interface PluginSettingsSectionProps {
  title: string;
  /** What the section is for, when the title does not say it. */
  description?: ReactNode;
  /** One control on the heading's right: an Add or a wizard. */
  action?: ReactNode;
  /** A short tag beside the title ("Beta"). */
  badge?: string;
  id?: string;
  children?: ReactNode;
}

/** Props of `SettingsGroup`: one surface of related rows split by hairlines. */
export interface PluginSettingsGroupProps {
  /** A sub-label above the surface, for a section with more than one group. */
  label?: string;
  id?: string;
  children?: ReactNode;
}

/** The ids a custom `SettingsRow` control wires itself to. */
export interface PluginSettingsRowControlIds {
  labelId: string;
  /** Pass as `aria-describedby`: the error, description and disabled reason, in order. */
  descriptionId: string | undefined;
  disabled: boolean;
}

/** Props of `SettingsRow`: one setting, its words on the left and its control on the rail. */
export interface PluginSettingsRowProps {
  label: ReactNode;
  /** Adds information (a consequence, a default); never restates the label. */
  description?: ReactNode;
  /**
   * The control. A function receives the ids to pass as `aria-labelledby` and
   * `aria-describedby`, and whether the row is disabled.
   */
  control?: ReactNode | ((ids: PluginSettingsRowControlIds) => ReactNode);
  /** `inline` (the default) for switches, selects, numbers; `stacked` for paths, code, lists. */
  layout?: "inline" | "stacked";
  /** Chips beside the label: scope, status. */
  accessory?: ReactNode;
  disabled?: boolean;
  /** Why the row is disabled, shown while it is. */
  disabledReason?: ReactNode;
  error?: ReactNode;
  /** Draws the modified-from-default mark; with `onReset`, a reset button too. */
  isModified?: boolean;
  onReset?: () => void;
  id?: string;
}

/** Props of `SettingsActions`: the last row of a group with an explicit Save. */
export interface PluginSettingsActionsProps {
  /** The actions, right-aligned: `contrast` Save, `outline` others, all `size="sm"`. */
  children?: ReactNode;
  /** Status on the left ("Saved"), announced politely. */
  status?: ReactNode;
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
  onSelect?: () => void;
  disabled?: boolean;
  className?: string;
}

export interface UseListNavigationOptions {
  /** Rows in the list. */
  count: number;
  /** Enter, Space or a click on a row. */
  onSelect?: (index: number) => void;
  /** Past either end, go round to the other. Defaults to false. */
  loop?: boolean;
  /** Where the cursor starts. Defaults to 0. */
  initialIndex?: number;
  /** A row's text, for typeahead: typing jumps to the next row that starts with it. */
  getLabel?: (index: number) => string;
}

/** Props `useListNavigation` hands the list element. */
export interface PluginListNavigationContainerProps {
  role: "listbox";
  tabIndex: 0;
  "aria-activedescendant": string | undefined;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/** Props `useListNavigation` hands each row. */
export interface PluginListNavigationRowProps {
  id: string;
  role: "option";
  "aria-selected": boolean;
  onClick: () => void;
  onPointerMove: () => void;
}

export interface UseListNavigationResult {
  /** The row the cursor is on, or -1 for an empty list. */
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  containerProps: PluginListNavigationContainerProps;
  getRowProps: (index: number) => PluginListNavigationRowProps;
}

/** The severity vocabulary of `SeverityIcon`, the same six as `Callout`. */
export type PluginSeverity = PluginCalloutSeverity;

/**
 * Props of `SeverityIcon`, the one glyph per severity used across Daintree:
 * error ✕-circle, warning triangle, danger octagon, success check, info and
 * neutral `i`. Pass `aria-label` when the glyph is the only statement of it.
 */
export interface PluginSeverityIconProps {
  severity: PluginSeverity;
  /** Square size in px. Defaults to 16. */
  size?: number;
  "aria-label"?: string;
  className?: string;
}

/**
 * Keys of {@link PluginThemeTokens}: Daintree's semantic theme tokens, the
 * same names as the `--theme-*` CSS variables without the prefix. The surface,
 * text, border, accent, `focus-ring` and status keys are core and stable within
 * the major version; the activity, terminal (ANSI included), syntax and
 * category keys are extended, provided best effort, and may be renamed in a
 * minor version with the change noted.
 */
export type PluginThemeTokenKey =
  | "surface-grid"
  | "surface-sidebar"
  | "surface-canvas"
  | "surface-panel"
  | "surface-panel-elevated"
  | "surface-input"
  | "surface-inset"
  | "surface-hover"
  | "surface-active"
  | "text-primary"
  | "text-secondary"
  | "text-muted"
  | "text-placeholder"
  | "text-inverse"
  | "text-link"
  | "border-default"
  | "border-subtle"
  | "border-strong"
  | "border-divider"
  | "border-interactive"
  | "accent-primary"
  | "accent-foreground"
  | "accent-hover"
  | "accent-soft"
  | "accent-muted"
  | "focus-ring"
  | "status-success"
  | "status-warning"
  | "status-danger"
  | "status-info"
  | "activity-active"
  | "activity-idle"
  | "activity-working"
  | "activity-waiting"
  | "terminal-background"
  | "terminal-foreground"
  | "terminal-muted"
  | "terminal-cursor"
  | "terminal-selection"
  | "terminal-black"
  | "terminal-red"
  | "terminal-green"
  | "terminal-yellow"
  | "terminal-blue"
  | "terminal-magenta"
  | "terminal-cyan"
  | "terminal-white"
  | "terminal-bright-black"
  | "terminal-bright-red"
  | "terminal-bright-green"
  | "terminal-bright-yellow"
  | "terminal-bright-blue"
  | "terminal-bright-magenta"
  | "terminal-bright-cyan"
  | "terminal-bright-white"
  | "syntax-comment"
  | "syntax-punctuation"
  | "syntax-number"
  | "syntax-string"
  | "syntax-operator"
  | "syntax-keyword"
  | "syntax-function"
  | "syntax-link"
  | "syntax-quote"
  | "category-blue"
  | "category-purple"
  | "category-cyan"
  | "category-green"
  | "category-amber"
  | "category-orange"
  | "category-teal"
  | "category-indigo"
  | "category-rose"
  | "category-pink"
  | "category-violet"
  | "category-slate";

/**
 * Resolved colours of the active theme, for canvas and WebGL. Each value is a
 * concrete sRGB colour, `#rrggbb` when opaque or `rgba(r, g, b, a)` when not,
 * so it parses anywhere. `category-*` is a 12-hue ramp for charts and tags.
 */
export type PluginThemeTokens = Readonly<Record<PluginThemeTokenKey, string>>;

/** What `useDaintreeTheme()` and `getDaintreeTheme()` return. Replaced, never mutated. */
export interface PluginDaintreeTheme {
  readonly colorMode: "dark" | "light";
  /** The active theme's id (a built-in such as `"daintree"`, or a custom theme's id). */
  readonly themeId: string;
  readonly tokens: PluginThemeTokens;
}
