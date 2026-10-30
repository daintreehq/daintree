// The leaf types every kit family builds on: the DOM and root attributes kit
// components forward, icons, buttons, tooltips, badges, keys, callouts,
// empty and loading states, and severity.

import type {
  AriaAttributes,
  DOMAttributes,
  HTMLAttributes,
  ReactElement,
  ReactNode,
  Ref,
} from "react";

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
 * What every other non-portalled kit component forwards to its root element:
 * an `id` and any `data-*` attribute (`data-testid`, say). The component's own
 * attributes win where they overlap.
 */
export interface PluginRootAttributes {
  id?: string;
  [dataAttribute: `data-${string}`]: string | number | boolean | undefined;
}

/**
 * {@link PluginRootAttributes} plus any `aria-*` attribute, for a component
 * whose root is the control itself. An attribute the component sets (its
 * name, its state) wins over one passed here.
 */
export interface PluginAriaRootAttributes extends PluginRootAttributes, AriaAttributes {}

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
  | "banknote"
  | "bell"
  | "bell-dot"
  | "book-open"
  | "bookmark"
  | "bot"
  | "braces"
  | "bug"
  | "calendar"
  | "car"
  | "chart-column"
  | "chart-line"
  | "chart-pie"
  | "check"
  | "check-square"
  | "chevron-down"
  | "chevron-left"
  | "chevron-right"
  | "chevron-up"
  | "chevrons-up-down"
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
  | "coins"
  | "copy"
  | "credit-card"
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
  | "file-warning"
  | "filter"
  | "flame"
  | "flask"
  | "folder"
  | "folder-code"
  | "folder-open"
  | "folder-search"
  | "folder-tree"
  | "folder-x"
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
  | "heart"
  | "help"
  | "history"
  | "home"
  | "hourglass"
  | "image"
  | "import"
  | "inbox"
  | "info"
  | "key"
  | "landmark"
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
  | "mouse-pointer"
  | "notebook"
  | "package"
  | "panel-left"
  | "panel-right"
  | "panel-right-close"
  | "panel-right-open"
  | "paperclip"
  | "pause"
  | "pencil"
  | "percent"
  | "piggy-bank"
  | "pin"
  | "pin-off"
  | "play"
  | "plug"
  | "plus"
  | "puzzle"
  | "receipt"
  | "redo"
  | "refresh"
  | "rocket"
  | "rotate-ccw"
  | "rotate-cw"
  | "save"
  | "scale"
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
  | "square-dashed-mouse-pointer"
  | "star"
  | "sticky-note"
  | "table"
  | "tag"
  | "target"
  | "terminal"
  | "trash"
  | "trending-down"
  | "trending-up"
  | "undo"
  | "unlink"
  | "unlock"
  | "unplug"
  | "upload"
  | "user"
  | "user-plus"
  | "users"
  | "wallet"
  | "wifi-off"
  | "workflow"
  | "worktree"
  | "wrench"
  | "x"
  | "zap";

/** Props of `Icon`. */
export interface PluginIconProps extends PluginRootAttributes {
  name: PluginIconName | PluginLucideIconName;
  /** Square size in px. Defaults to 16. Inside a kit `Button` the button sizes it. */
  size?: number;
  className?: string;
  /** Names the icon for assistive tech. Omitted, the icon is decorative (`aria-hidden`). */
  "aria-label"?: string;
}

/**
 * Any Lucide icon by its kebab-case name ("piggy-bank", "chart-candlestick"),
 * beyond the names {@link PluginIconName} lists (https://lucide.dev/icons).
 * A listed name draws at once; any other Lucide name is loaded the first time
 * it is drawn, holding its square empty until then. A name Lucide does not
 * have draws nothing and warns in development.
 */
export type PluginLucideIconName = string & {};

/**
 * An icon a kit prop can take: a {@link PluginIconName}, any other Lucide
 * name, or your own element (an inline `<svg>`). A string is always read as a
 * name, never as text.
 */
export type PluginIconSource = PluginIconName | PluginLucideIconName | ReactElement;

export type PluginButtonVariant =
  | "default"
  | "secondary"
  | "outline"
  | "ghost"
  | "subtle"
  | "contrast"
  | "destructive"
  | "ghost-danger"
  | "link"
  /** A rounded, quiet chip-shaped button: a floating toolbar or a status strip's control. */
  | "pill";

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
  /**
   * Overrides the overflow check, for text your code shortens itself (a
   * middle-elided path): `true` always offers the tooltip, `false` never does.
   */
  isTruncated?: boolean;
}

export type PluginSpinnerSize = "xs" | "sm" | "md" | "lg" | "xl" | "2xl";

/** Props of `Spinner`. Decorative: say what is loading in text beside it. */
export interface PluginSpinnerProps extends PluginRootAttributes {
  size?: PluginSpinnerSize;
  className?: string;
}

/** Props of `SpinningIcon`: an icon that finishes its current turn before it stops. */
export interface PluginSpinningIconProps extends PluginRootAttributes {
  icon: PluginIconSource;
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

/** Props of `Kbd`: one literal key cap. */
export interface PluginKbdProps extends PluginRootAttributes {
  children: ReactNode;
  /** `compact` for a dense one-line row, the same box `KbdChord` draws. */
  density?: "default" | "compact";
  className?: string;
}

/** Props of `KbdChord`: a shortcut drawn the platform's way. */
export interface PluginKbdChordProps extends PluginRootAttributes {
  /** The canonical combo, e.g. `"Cmd+Shift+P"` or a two-step `"Cmd+K T"`. */
  shortcut: string;
  /** `compact` for dense rows; `bare` drops the key boxes where every row has a binding. */
  density?: "default" | "compact" | "bare";
  foreground?: "secondary" | "primary" | "inverse";
  /** Spoken form. Defaults to the chord described in words. */
  "aria-label"?: string;
  className?: string;
}

interface PluginCopyButtonBaseProps extends PluginAriaRootAttributes {
  /** The text to copy, or a function read at click time. A throw counts as a failed copy. */
  text: string | (() => string | Promise<string>);
  tooltip?: ReactNode;
  tooltipSide?: PluginSide;
  onCopied?: () => void;
  /** Report the failure yourself; the button then stays quiet about it. */
  onCopyError?: (error: unknown) => void;
  /** Spoken politely after a successful copy ("Path copied"). Defaults to "Copied". */
  announcement?: string;
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
export interface PluginDismissButtonProps extends PluginAriaRootAttributes {
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

/**
 * Props of `Callout`, an inline message box. The glyph follows the severity.
 * DOM props (`id`, `role`, `aria-*`, `data-*`, handlers) land on its root,
 * including `role="alert"` or `role="status"` for a message that should
 * be announced. The `strip` variant is the host's pane banner: it keeps `id`,
 * `role`, `aria-*` and `data-*`, but not handlers, `style` or `ref`.
 */
export interface PluginCalloutProps extends Omit<PluginDomProps<HTMLDivElement>, "title"> {
  severity: PluginCalloutSeverity;
  children?: ReactNode;
  title?: ReactNode;
  /** One trailing control, such as a Retry button. */
  action?: ReactNode;
  /**
   * `inline` (the default) puts `action` beside the message, or under it when
   * the box is too narrow for both; `below` always puts it under the text, for
   * a long message or more than one control.
   */
  actionPlacement?: "inline" | "below";
  /** Draws the dismiss X, which calls this. */
  onDismiss?: () => void;
  /** Names the dismiss X ("Dismiss warning"). Defaults to "Dismiss". */
  dismissLabel?: string;
  /**
   * `box` (the default) sits among content. `strip` is the full-width band
   * across the top of a pane or popover, Daintree's pane banner: `title` is its
   * headline and `children` one line under it. A strip never stands green:
   * `success` draws as a neutral strip with the check glyph. A strip forwards
   * `id`, `role`, `aria-*` and `data-*`, but not handlers, `style` or `ref`.
   */
  variant?: "box" | "strip";
  /** A domain glyph in place of the info mark, for `neutral` only. */
  icon?: PluginIconSource;
  size?: "default" | "compact";
  className?: string;
}

/** Props of `EmptyState`. */
export interface PluginEmptyStateProps extends PluginRootAttributes {
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
export interface PluginSkeletonProps extends PluginRootAttributes {
  children?: ReactNode;
  /** Spoken while loading. Defaults to "Loading". */
  label?: string;
  className?: string;
}

/** Props of `SkeletonBone`, one placeholder shape. Appears after a short delay to avoid flicker. */
export interface PluginSkeletonBoneProps extends PluginRootAttributes {
  className?: string;
  /** Fixed height, so nothing shifts when the content arrives. */
  heightPx?: number;
  shimmer?: boolean;
  /** Skip the anti-flicker delay: for a placeholder that replaces content already on screen. */
  immediate?: boolean;
}

/** Props of `SkeletonText`, ragged placeholder lines. */
export interface PluginSkeletonTextProps extends PluginRootAttributes {
  /** Defaults to 3. */
  lines?: number;
  shimmer?: boolean;
  /** As on `SkeletonBone`. */
  immediate?: boolean;
  className?: string;
}

/**
 * Props of `SkeletonHint`, the companion to a `Skeleton` for a long load: it
 * stays invisible for 8 seconds, then says "Still working…", escalates, and
 * offers Cancel and later Retry when you pass them. Place it beside the
 * `Skeleton`, never inside it (both are live regions).
 */
export interface PluginSkeletonHintProps extends PluginRootAttributes {
  /** Your own progress line ("Fetching 3 of 12 files…") in place of the generic copy. */
  message?: string;
  /** Surfaces Cancel with the first hint. */
  onCancel?: () => void;
  /** Surfaces Retry once the wait is long (20s by default). */
  onRetry?: () => void;
  /** ms before the first hint. Defaults to 8000. */
  firstThreshold?: number;
  /** ms before the copy escalates. Defaults to 13000. */
  secondThreshold?: number;
  /** ms before Retry appears. Defaults to 20000. */
  actionThreshold?: number;
  className?: string;
}

/**
 * Props of `ScrollShadow`: a vertical scroller with fades that show there is
 * more. The DOM props (`id`, `role`, `tabIndex`, `aria-*`, `data-*`,
 * handlers) land on the scrolling element, so it can be a listbox. For a
 * windowed list, use `VirtualList` with `shadows` instead.
 */
export interface PluginScrollShadowProps extends Omit<PluginDomProps<HTMLDivElement>, "ref"> {
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

/** The severity vocabulary of `SeverityIcon`, the same six as `Callout`. */
export type PluginSeverity = PluginCalloutSeverity;

/**
 * Props of `SeverityIcon`, the one glyph per severity used across Daintree:
 * error ✕-circle, warning triangle, danger octagon, success check, info and
 * neutral `i`. Pass `aria-label` when the glyph is the only statement of it.
 */
export interface PluginSeverityIconProps extends PluginRootAttributes {
  severity: PluginSeverity;
  /** Square size in px. Defaults to 16. */
  size?: number;
  "aria-label"?: string;
  className?: string;
}
