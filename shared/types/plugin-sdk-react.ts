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
  MouseEvent,
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
  /**
   * `center` (the default) centres the document's reading measure in its
   * container, as Daintree's own document views do. `start` keeps the measure
   * but sets it against the leading edge, in line with the controls above it:
   * for a preview inside a form or an editor.
   */
  align?: "center" | "start";
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
  | "help"
  | "history"
  | "home"
  | "hourglass"
  | "image"
  | "import"
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
  | "rotate-cw"
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
  | "square-dashed-mouse-pointer"
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
  | "unplug"
  | "upload"
  | "user"
  | "user-plus"
  | "users"
  | "wifi-off"
  | "workflow"
  | "worktree"
  | "wrench"
  | "x"
  | "zap";

/** Props of `Icon`. */
export interface PluginIconProps extends PluginRootAttributes {
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
  /**
   * `date`, `time` and `datetime-local` use the platform's
   * picker, drawn in the active theme's light or dark scheme; `value` is the
   * ISO form (`"2026-09-30"`, `"14:05"`, `"2026-09-30T14:05"`).
   */
  type?:
    | "text"
    | "search"
    | "email"
    | "url"
    | "password"
    | "number"
    | "tel"
    | "date"
    | "time"
    | "datetime-local";
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
  /** A leading glyph, shown in the list and on the trigger (`Select` only). */
  icon?: PluginIconName;
  disabled?: boolean;
}

/** A labelled run of options in a `Select`. */
export interface PluginSelectOptionGroup {
  label: string;
  options: readonly PluginSelectOption[];
}

/** Props of `Select`. The list opens in a host overlay, so only the trigger takes classes. */
export interface PluginSelectProps extends PluginAriaRootAttributes {
  options: readonly (PluginSelectOption | PluginSelectOptionGroup)[];
  /**
   * The chosen value, controlled. Passing the prop at all makes the Select
   * controlled: `""`, `null` or `undefined` then shows the `placeholder` again
   * (a form reset). Leave it out entirely for an uncontrolled Select.
   */
  value?: string | null;
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
export interface PluginSegmentedControlProps extends PluginAriaRootAttributes {
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
 * be announced.
 */
export interface PluginCalloutProps extends Omit<PluginDomProps<HTMLDivElement>, "title"> {
  severity: PluginCalloutSeverity;
  children?: ReactNode;
  title?: ReactNode;
  /** One trailing control, such as a Retry button. */
  action?: ReactNode;
  /**
   * `inline` (the default) puts `action` beside the message; `below` puts it
   * under the text, for a long message or more than one control.
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
   * `role`, `aria-live` and `data-testid` only.
   */
  variant?: "box" | "strip";
  /** A domain glyph in place of the info mark, for `neutral` only. */
  icon?: PluginIconName;
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
  | { type: "separator" };

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

// Lists, pane chrome, forms, settings grammar and severity.

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

/** Props of `PaneHeader`: a pane's compact title bar. */
export interface PluginPaneHeaderProps extends PluginRootAttributes {
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
export interface PluginToolbarProps extends PluginAriaRootAttributes {
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
export interface PluginToolbarButtonProps extends PluginAriaRootAttributes {
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
export interface PluginPaneStateProps extends PluginRootAttributes {
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
export interface PluginFormFieldProps extends PluginRootAttributes {
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
  /** @deprecated Ignored: switches draw at one size everywhere in Daintree. */
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
export interface PluginTabsProps extends PluginRootAttributes {
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
export interface PluginProgressBarProps extends PluginAriaRootAttributes {
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
export interface PluginSettingsSectionProps extends PluginRootAttributes {
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
export interface PluginSettingsGroupProps extends PluginRootAttributes {
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
export interface PluginSettingsRowProps extends PluginRootAttributes {
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
export interface PluginSettingsActionsProps extends PluginRootAttributes {
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
  /** Enter, Space or a click on a row. */
  onSelect?: (index: number) => void;
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
}

/** Props `useListNavigation` hands each row. */
export interface PluginListNavigationRowProps {
  id: string;
  role: "option";
  "aria-selected": boolean;
  /** Set on rows `isDisabled` reports. */
  "aria-disabled"?: true;
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
export interface PluginSeverityIconProps extends PluginRootAttributes {
  severity: PluginSeverity;
  /** Square size in px. Defaults to 16. */
  size?: number;
  "aria-label"?: string;
  className?: string;
}

// Avatars, popovers and the gaps the builtin plugins hit.

/**
 * Props of `Avatar`: a person's or bot's picture, falling back to their
 * initials when there is no `src` or it fails to load.
 */
export interface PluginAvatarProps extends PluginRootAttributes {
  /** The picture's URL. Empty or omitted draws the initials. */
  src?: string;
  /** Who it is. The accessible name, and where the initials come from. */
  name: string;
  /** `xs` 16px, `sm` 20px (the default), `md` 24px, `lg` 32px. */
  size?: "xs" | "sm" | "md" | "lg";
  /** `square` says "bot or app, not a person". */
  shape?: "circle" | "square";
  /** Hover text, usually the name or handle. */
  tooltip?: string;
  /** True beside the name in text: hidden from assistive tech. */
  decorative?: boolean;
  className?: string;
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

// File trees, stat cards, sparklines and field groups.

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

/**
 * Props of `StatCard`: one figure with its sentence-case label, for a
 * dashboard row. The figure stays neutral; a `tone` adds its severity glyph
 * beside the label. `success` is for a recorded result ("All checks passed"),
 * never for "healthy" standing status.
 */
export interface PluginStatCardProps extends PluginDomProps<HTMLDivElement> {
  label: ReactNode;
  /** The figure. Format it yourself (`formatCount`, `formatBytes`, `formatDuration`). */
  value: ReactNode;
  /**
   * The change beside the figure. A number is signed and drawn with an up or
   * down arrow; anything else is shown as given. Neutral either way: whether
   * up is good depends on the figure.
   */
  delta?: ReactNode;
  tone?: PluginSeverity;
  /** One quiet line under the figure: its scope or source. */
  hint?: ReactNode;
  /** Below the hint: a `Sparkline`, say. */
  children?: ReactNode;
  className?: string;
}

/**
 * Props of `Sparkline`: a small trend line with no axes, drawn in a theme
 * colour. It fills its container's width. Fewer than two finite values draw
 * an empty box of the same size; a non-finite value is a gap.
 */
export interface PluginSparklineProps extends PluginRootAttributes {
  values: readonly number[];
  /** Required: the trend in words ("Events per second, last 60 s"). Empty hides it from assistive tech. */
  "aria-label": string;
  /** In px. Defaults to 24. */
  height?: number;
  /**
   * `neutral` (the default) draws in the secondary text colour, and so does
   * `success`: a trend is standing status, and green is kept for results that
   * just landed. Never accent.
   */
  tone?: PluginSeverity;
  /** Fixed ends of the scale. Omitted, the values' own range is used. */
  min?: number;
  max?: number;
  className?: string;
}

/**
 * A chart colour. Series take the categorical slots in this fixed order
 * (`blue`, `amber`, `indigo`, `orange`, `violet`, `teal`), read from the
 * theme's `category-*` tokens, so neighbours stay apart under colour-vision
 * deficiency and in the colour-vision themes. Pin one on a series so it keeps
 * its colour when a filter removes the series before it. `neutral` is a quiet
 * grey for a comparison series such as "previous period".
 */
export type PluginChartColor =
  "blue" | "amber" | "indigo" | "orange" | "violet" | "teal" | "neutral";

/** One series of a `BarChart` or `LineChart`: the row key its values live under. */
export interface PluginChartSeries {
  /** The key in each `data` row that holds this series' number. */
  key: string;
  /** Its name in the legend, tooltip and data table. */
  label: string;
  /** Pins the colour. Omitted, the series takes the next slot in the fixed order. */
  color?: PluginChartColor;
}

/** What every kit chart takes. */
export interface PluginChartBaseProps extends PluginRootAttributes {
  /**
   * The rows: one plain object per x position (or per part, for a
   * `DonutChart`). A value that is not a finite number is a gap, never a zero.
   */
  data: readonly Record<string, unknown>[];
  /** Required: what the chart shows ("Builds per day, last 30 days"). */
  "aria-label": string;
  /** The plot's height in px, legend excluded. Defaults to 200. The width fills the container. */
  height?: number;
  /**
   * Formats a value for the axis, tooltip, legend and data table. Omitted,
   * axes read compact (`1.2K`) and the tooltip reads in full (`1,234`).
   */
  formatValue?: (value: number) => string;
  /** Draws the kit's skeleton at the chart's height in place of the chart. */
  loading?: boolean;
  /** Shown when there is nothing to draw. Omitted, a quiet "No data" at the chart's height. */
  empty?: ReactNode;
  className?: string;
}

/**
 * Props of `BarChart`: a value per category, for one or more series, grouped
 * side by side or stacked, drawn upward or across.
 */
export interface PluginBarChartProps extends PluginChartBaseProps {
  /** The key in each row that holds the category ("day", "branch"). */
  x: string;
  /** Up to six series; any past the sixth are not drawn. */
  series: readonly PluginChartSeries[];
  /** `grouped` (the default) sets a category's bars side by side; `stacked` piles them. */
  mode?: "grouped" | "stacked";
  /** `vertical` (the default) draws columns; `horizontal` draws bars, for long category names. */
  orientation?: "vertical" | "horizontal";
  /** Formats a category for its axis label, the tooltip and the table. Defaults to `String(value)`. */
  formatX?: (value: unknown) => string;
  /** The category column's header in the accessible data table. Defaults to "Category". */
  xLabel?: string;
}

/**
 * Props of `LineChart`: one or more series over a numeric or time x axis,
 * with an optional area wash.
 */
export interface PluginLineChartProps extends PluginChartBaseProps {
  /** The key in each row that holds x: a number, a `Date`, epoch ms, or an ISO date string. */
  x: string;
  /** Up to six series; any past the sixth are not drawn. */
  series: readonly PluginChartSeries[];
  /**
   * `time` reads x as a date and ticks on calendar steps; `number` as a plain
   * number. Omitted, `time` when the first x is a `Date` or a string.
   */
  xType?: "number" | "time";
  /** Fills under each line with a faint wash of its colour, down to zero. */
  area?: boolean;
  /** `linear` (the default) joins points straight; `monotone` smooths without overshooting a value. */
  curve?: "linear" | "monotone";
  /** Formats x (a number; epoch ms for `time`) for the axis, tooltip and table. */
  formatX?: (value: number) => string;
  /** The x column's header in the accessible data table. Defaults to "Time" or "X". */
  xLabel?: string;
}

/**
 * Props of `DonutChart`: parts of a whole, with the total (or your own
 * figure) in the centre and a legend that lists every part's value and share.
 */
export interface PluginDonutChartProps extends PluginChartBaseProps {
  /** The key in each row that holds the part's name. */
  x: string;
  /** The key in each row that holds the part's size. Zero, negative and non-finite parts are left out. */
  value: string;
  /** The figure in the centre. Defaults to the formatted total. */
  centerValue?: ReactNode;
  /** A quiet line under the centre figure ("Total files"). */
  centerLabel?: ReactNode;
  /** The name of the part that gathers everything past the fifth. Defaults to "Other". */
  otherLabel?: string;
}

/**
 * Props of `FormFieldGroup`: one label over a set of controls that answer it
 * together, such as a row of checkboxes. The label matches a `FormField`'s;
 * each control inside is its own horizontal `FormField`.
 */
export interface PluginFormFieldGroupProps extends PluginRootAttributes {
  label: ReactNode;
  description?: ReactNode;
  /** Shown under the controls. */
  error?: ReactNode;
  /** Says "Required" beside the label. */
  required?: boolean;
  /** Disables every control inside and dims the label. */
  disabled?: boolean;
  /** `stack` (the default) puts one control per line; `inline` wraps them in a row. */
  layout?: "stack" | "inline";
  children?: ReactNode;
  className?: string;
}

// Context menus, sheets, command palettes, breadcrumbs, nav lists and steppers.

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

/** One crumb of `Breadcrumbs`. */
export interface PluginBreadcrumbItem {
  label: string;
  /** Makes the crumb a link back to that level. The last crumb is the current page and never is. */
  onSelect?: () => void;
  icon?: PluginIconSource;
}

/**
 * Props of `Breadcrumbs`: the path to the current page, each level a link
 * back to it and the last one the page itself (`aria-current`). A long path
 * keeps its first and last crumbs and folds the middle ones into a menu.
 */
export interface PluginBreadcrumbsProps extends PluginRootAttributes {
  items: readonly PluginBreadcrumbItem[];
  /** How many crumbs show before the middle ones fold into a menu. Defaults to 4; at least 2. */
  maxItems?: number;
  /** Names the trail. Defaults to "Breadcrumb". */
  "aria-label"?: string;
  className?: string;
}

/** One destination of a `NavList`. */
export interface PluginNavListItem {
  /** Unique within the list; what `value` and `onValueChange` carry. */
  id: string;
  label: string;
  icon?: PluginIconSource;
  /** A count at the row's end: unread, open, failing. Zero shows nothing. */
  count?: number;
  /** A short tag at the row's end instead of a count: a kit `Badge`, say. */
  badge?: ReactNode;
  /** Shown but skipped by the cursor and never selected. */
  disabled?: boolean;
  /** Destinations under this one, indented beneath it. One level: theirs are ignored. */
  children?: readonly PluginNavListItem[];
}

/** A band of a `NavList`, with an optional heading. */
export interface PluginNavListSection {
  label?: string;
  items: readonly PluginNavListItem[];
}

/**
 * Props of `NavList`: the left rail of an app, the destinations its pages
 * switch between, drawn with Daintree's sidebar rows (the selected one takes
 * the neutral highlight, never the accent). One tab stop: Up/Down/Home/End
 * move the cursor, Enter or Space selects, typing jumps to a matching label.
 * Give it `sections`, or `items` for one band with no heading.
 */
export interface PluginNavListProps extends PluginRootAttributes {
  sections?: readonly PluginNavListSection[];
  items?: readonly PluginNavListItem[];
  /** The selected destination's id, controlled. Passing it at all makes the list controlled. */
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (id: string) => void;
  /** Required: names the list for assistive tech ("Sections"). */
  "aria-label": string;
  className?: string;
}

/** Where a `Stepper` step stands. */
export type PluginStepState = "complete" | "current" | "upcoming" | "error";

/** One step of a `Stepper`. */
export interface PluginStepperStep {
  /** Unique within the stepper; what `current` and `onStepSelect` carry. */
  id: string;
  label: string;
  /** A quieter line under the label. */
  description?: string;
  /**
   * Overrides the state the step's place gives it (before `current` is
   * complete, after it upcoming): `error` for a step that needs another look,
   * `complete` for one done out of order.
   */
  state?: PluginStepState;
}

/**
 * Props of `Stepper`: a wizard's progress, one marker per step with its
 * label. Neutral throughout: the current step is the high-contrast marker, a
 * completed one a check, a failed one the error glyph.
 */
export interface PluginStepperProps extends PluginRootAttributes {
  steps: readonly PluginStepperStep[];
  /** The current step's id. */
  current: string;
  /** `horizontal` (the default) runs across the top of a wizard; `vertical` down its side. */
  orientation?: "horizontal" | "vertical";
  /** Makes complete and error steps buttons that go back to them. */
  onStepSelect?: (id: string) => void;
  /** Names the steps. Defaults to "Progress". */
  "aria-label"?: string;
  className?: string;
}

/**
 * Props of `FilterChip`: one value in a filter bar that narrows a list
 * ("Open", "Status: Open"). A toggle chip is pressed while its filter is on;
 * with `onRemove` it is an applied filter that shows a × and removes itself on
 * click, Backspace or Delete. Never accent: several chips can be on at once.
 */
export interface PluginFilterChipProps extends Omit<
  PluginDomProps<HTMLButtonElement>,
  "aria-pressed"
> {
  /** The chip's text, which is also its accessible name. */
  children?: ReactNode;
  /** Whether the filter is on. Pass with `onSelectedChange` to control it. */
  selected?: boolean;
  /** The starting state when `selected` is not passed. */
  defaultSelected?: boolean;
  /** Called with the next state when the chip is clicked. */
  onSelectedChange?(selected: boolean): void;
  /** Matches for this value, shown as "(3)". `0` on an unselected chip drops it to a quiet edge. Not shown on a removable chip. */
  count?: number;
  /** Makes it a removable, applied filter: always pressed, with a ×. Called on click, Backspace or Delete. */
  onRemove?(): void;
  /** The removable chip's tooltip. Defaults to "Remove filter". */
  removeLabel?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Props of `HighlightedText`: text with the parts that matched a search drawn
 * on a neutral band, never accent. Pass `query` for a case-insensitive
 * substring match (its first occurrence, which is what a substring filter
 * tested), or `ranges` for matches you computed yourself.
 */
export interface PluginHighlightedTextProps extends PluginRootAttributes {
  text: string;
  /** Highlights the first case-insensitive occurrence. Ignored when `ranges` is given. */
  query?: string;
  /** Inclusive `[start, end]` character offsets, the shape fuse.js reports. Overlapping and touching ranges merge. */
  ranges?: readonly (readonly [number, number])[];
  className?: string;
}

/**
 * Props of `DiffStat`: line churn in Daintree's one spelling, "+12 -3", the
 * additions in the success ink and the deletions in the error ink. A zero side
 * is left out, and so is the whole stat when both are. Size comes from the
 * text around it.
 */
export interface PluginDiffStatProps extends PluginRootAttributes {
  additions?: number;
  deletions?: number;
  className?: string;
}

/** One person or bot in an `AvatarGroup`. */
export interface PluginAvatarGroupItem {
  /** The accessible name, the tooltip and the initials. */
  name: string;
  src?: string;
  /** `square` says "bot or app, not a person". */
  shape?: "circle" | "square";
}

/**
 * Props of `AvatarGroup`: overlapping avatars for the people on something (the
 * reviewers of a pull request, the members of a channel), with a "+N" that
 * lists the rest in its tooltip.
 */
export interface PluginAvatarGroupProps extends PluginRootAttributes {
  avatars: readonly PluginAvatarGroupItem[];
  /** The most avatars drawn before the rest fold into "+N". Defaults to 4. */
  max?: number;
  /** `xs` 16px, `sm` 20px (the default), `md` 24px, `lg` 32px. */
  size?: "xs" | "sm" | "md" | "lg";
  /** Names the group ("Reviewers"). Omitted, it is not announced as a group. */
  "aria-label"?: string;
  className?: string;
}

/** Where a `Meter` changes tone, as fractions of `max` (0 to 1). */
export interface PluginMeterThresholds {
  /** At or above this fraction the fill turns to the warning colour. */
  warning?: number;
  /** At or above this fraction the fill turns to the danger colour. */
  danger?: number;
}

/**
 * Props of `Meter`: how much of a known limit is used (a quota, a disk, a
 * rate limit). Unlike `ProgressBar` it measures a level rather than a task,
 * and it can change tone: neutral below its `thresholds`, then warning or
 * danger, each with its glyph beside the value so colour is never the only
 * signal. Announced as a `meter`.
 */
export interface PluginMeterProps extends PluginAriaRootAttributes {
  /** The amount used, from 0 to `max`. Values outside that range are clamped. */
  value: number;
  /** The limit. Defaults to 1, so `value` can be a fraction. */
  max?: number;
  /** Required: the accessible name, and the visible label unless `showLabel` is false. */
  label: string;
  /** False drops the visible label and puts the value beside the bar, for a meter inside a row that already names it. Defaults to true. */
  showLabel?: boolean;
  /** The visible and spoken value ("812 of 1,000 requests"). Defaults to the percentage. */
  valueText?: string;
  /** Neutral when omitted. `{ warning: 0.8, danger: 0.95 }` warns at 80% and 95%. */
  thresholds?: PluginMeterThresholds;
  className?: string;
}

/** Who did a `Timeline` item: a name, or a name with a picture. */
export interface PluginTimelineActor {
  name: string;
  src?: string;
  shape?: "circle" | "square";
}

/** One entry of a `Timeline`. Extend it with your own fields and read them in `renderContent`. */
export interface PluginTimelineItem {
  /** Unique within the timeline; keys the row. */
  id: string | number;
  /** The rail marker. Omitted, a `tone` draws its severity glyph and anything else a dot. */
  icon?: PluginIconSource;
  /** One line: what happened ("opened this pull request"). */
  title: ReactNode;
  /** A quieter line under the title. */
  description?: ReactNode;
  /** Epoch ms, an ISO string or a Date. Drawn as a relative time with the exact time on hover. */
  timestamp?: number | string | Date;
  /** Drawn before the title, with their avatar when `src` is given. */
  actor?: string | PluginTimelineActor;
  /** Names the severity to assistive tech and marks it: its severity glyph without an `icon`, or a tint on the icon (`success` leaves an icon neutral). */
  tone?: PluginSeverity;
}

/**
 * Props of `Timeline`: an activity feed or audit log, one entry per row on a
 * connecting rail, virtualised so a feed of thousands mounts one screen of
 * rows. Rows are measured as they render, so entries of different heights (a
 * comment body under one, a single line under the next) need no fixed height.
 * The timeline is as tall as its rows up to its container's height and scrolls
 * past that, so a long feed needs a sized container (`h-full` in a sized pane).
 */
export interface PluginTimelineProps<
  T extends PluginTimelineItem = PluginTimelineItem,
> extends PluginRootAttributes {
  /** In display order: newest first for a feed, oldest first for a history. */
  items: readonly T[];
  /** Required: names the feed for assistive tech ("Activity"). */
  "aria-label": string;
  /** Custom content under an entry's title and description: a comment body in `Markdown`, a diff summary. */
  renderContent?(item: T, index: number): ReactNode;
  /** Puts a "Today", "Yesterday" or date header before each day's entries. Entries without a timestamp stay under the header above them. */
  groupByDay?: boolean;
  /** `compact` (the default) is "5m ago"; `verbose` is "5 minutes ago". */
  timeFormat?: "compact" | "verbose";
  /** A fixed clock for relative times and day headers. Omitted, the times refresh on a shared minute tick. */
  now?: number;
  /** Expected entry height in px, before rows are measured. Defaults to 44. */
  estimatedItemSize?: number;
  /** Called once the last entry scrolls into view: load the next page here. */
  onEndReached?(lastIndex: number): void;
  className?: string;
}

/**
 * A calendar day as an ISO date string, `"YYYY-MM-DD"`. A day, not an
 * instant: it carries no time or zone, so `"2026-09-30"` is the 30th for
 * every user whatever their offset or daylight saving. Never round-trip one
 * through `new Date("2026-09-30")`, which reads it as UTC midnight and lands
 * on the 29th west of Greenwich.
 */
export type PluginIsoDate = string;

/** An inclusive run of days. `start` is never after `end`; a one-day range has them equal. */
export interface PluginDateRange {
  start: PluginIsoDate;
  end: PluginIsoDate;
}

export interface PluginCalendarBaseProps extends PluginRootAttributes {
  /** The earliest day that can be chosen, inclusive. */
  min?: PluginIsoDate;
  /** The latest day that can be chosen, inclusive. */
  max?: PluginIsoDate;
  /** Days that cannot be chosen (weekends, holidays). They can still take keyboard focus. */
  isDateDisabled?: (date: PluginIsoDate) => boolean;
  /** The first month shown, `"YYYY-MM"`, controlled. */
  month?: string;
  /** The first month shown at mount. Defaults to the selection's month, else this month. */
  defaultMonth?: string;
  /** The first month shown changed: a header arrow, or the keyboard moving past its edge. */
  onMonthChange?: (month: string) => void;
  /** Months side by side. Defaults to 1. */
  numberOfMonths?: 1 | 2;
  /** 0 is Sunday, 1 Monday, … 6 Saturday. Defaults to the user's locale. */
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** Names the calendar when nothing around it does. */
  "aria-label"?: string;
  className?: string;
}

/** Props of `Calendar` choosing one day. */
export interface PluginCalendarSingleProps extends PluginCalendarBaseProps {
  mode?: "single";
  /** The chosen day, controlled. `null` shows none. Passing the prop at all makes it controlled. */
  value?: PluginIsoDate | null;
  defaultValue?: PluginIsoDate | null;
  onValueChange?: (value: PluginIsoDate) => void;
}

/** Props of `Calendar` choosing a run of days. */
export interface PluginCalendarRangeProps extends PluginCalendarBaseProps {
  mode: "range";
  /** The chosen range, controlled. Passing the prop at all makes it controlled. */
  value?: PluginDateRange | null;
  defaultValue?: PluginDateRange | null;
  /**
   * Called once both ends are picked: the first press sets one end and the
   * second the other, in either order. Between the two the range is only
   * previewed.
   */
  onValueChange?: (value: PluginDateRange) => void;
}

/**
 * Props of `Calendar`: an inline month grid. One tab stop; arrow keys move by
 * day and week, PageUp/PageDown by month (with Shift, by year), Home/End to
 * the week's ends, Enter or Space chooses. Today is marked, selection is
 * neutral, and the month name and weekdays follow the user's locale.
 */
export type PluginCalendarProps = PluginCalendarSingleProps | PluginCalendarRangeProps;

export interface PluginDateFieldBaseProps extends PluginAriaRootAttributes {
  min?: PluginIsoDate;
  max?: PluginIsoDate;
  /** Days that cannot be chosen, in the calendar or by typing. */
  isDateDisabled?: (date: PluginIsoDate) => boolean;
  /** 0 is Sunday, 1 Monday, … 6 Saturday. Defaults to the user's locale. */
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** Shown while the field is empty. */
  placeholder?: string;
  /** Draws a clear button while there is a value. Default true. */
  clearable?: boolean;
  disabled?: boolean;
  /** Also pass `required` to the enclosing `FormField`. Stops the field clearing. */
  required?: boolean;
  /** Marks the field invalid, beside the field's own check of what was typed. */
  invalid?: boolean;
  /** Submits the ISO value in a native form under this name. */
  name?: string;
  /** The calendar popover, controlled. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** `compact` (28px) for filter bars. */
  density?: "default" | "compact";
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  /** Classes for the field. */
  className?: string;
}

/**
 * Props of `DatePicker`: a field that takes a typed date or opens a calendar.
 * Typing is lenient (`2026-09-30`, `2026/9/30`, `Sep 30 2026`, `30 September`,
 * or the locale's numeric order) and is checked on Enter or blur: text that
 * is not a date, or a day outside `min`/`max`, marks the field invalid and
 * leaves the value alone. Escape puts the text back. Joins a `FormField` on
 * its own.
 */
export interface PluginDatePickerProps extends PluginDateFieldBaseProps {
  /** The day, controlled. `null` is empty. Passing the prop at all makes it controlled. */
  value?: PluginIsoDate | null;
  defaultValue?: PluginIsoDate | null;
  /** The new day, or `null` when the field was cleared. */
  onValueChange?: (value: PluginIsoDate | null) => void;
}

/** A shortcut in a `DateRangePicker`'s popover. Work the range out when you render. */
export interface PluginDateRangePreset {
  label: string;
  range: PluginDateRange;
}

/**
 * Props of `DateRangePicker`: `DatePicker` for a run of days. The popover
 * shows two months where the window has room, and `presets` beside them. The
 * field takes typed ranges too: two dates with `–`, ` - ` or `to` between.
 */
export interface PluginDateRangePickerProps extends PluginDateFieldBaseProps {
  /** The range, controlled. `null` is empty. Passing the prop at all makes it controlled. */
  value?: PluginDateRange | null;
  defaultValue?: PluginDateRange | null;
  /** The new range, or `null` when the field was cleared. */
  onValueChange?: (value: PluginDateRange | null) => void;
  /** Shortcuts such as "Last 7 days", listed beside the calendar. */
  presets?: readonly PluginDateRangePreset[];
}

/**
 * Props of `TimeAgo`: an age that keeps itself current ("5m ago"), in a
 * `<time>` with the full date and time one hover away. Every `TimeAgo` shares
 * one timer, ticking less often as the time recedes and not at all while the
 * view is hidden.
 */
export interface PluginTimeAgoProps extends PluginRootAttributes {
  /** Epoch ms, an ISO string or a `Date`. Anything else reads "Unknown". */
  value: number | string | Date;
  /** `formatRelativeTime` wording ("5 minutes ago", "in 3 hours") instead of `formatTimeAgo`'s "5m ago". */
  verbose?: boolean;
  /** Words that belong inside the label, before the age: `"Updated "`. */
  prefix?: string;
  /**
   * The full date in a tooltip (the default). `false` puts it in a native
   * `title` instead: for an age inside a button, option or other control,
   * where a tooltip trigger would fight the control's own pointer and focus.
   */
  tooltip?: boolean;
  className?: string;
}

interface PluginCardBaseProps extends Omit<PluginDomProps<HTMLElement>, "title" | "onClick"> {
  /** The card's heading, sentence case. */
  title?: ReactNode;
  /** One or two quiet lines under the title. */
  description?: ReactNode;
  children?: ReactNode;
  /**
   * A row under the body, set off by a hairline: the card's actions, or a
   * quiet line such as "Updated 5m ago" on a clickable card.
   */
  footer?: ReactNode;
  /**
   * `default` is the panel surface. `inset` recedes: a nested group or a
   * read-only detail block inside another surface.
   */
  variant?: "default" | "inset";
  /** The body's padding: 16 px (`md`, the default), 12 px (`sm`), or none, for a list or table edge to edge. */
  padding?: "none" | "sm" | "md";
  className?: string;
}

/**
 * Props of `Card`: the app's card surface, a hairline frame with an optional
 * header (`title`, `description`, `actions`), a body and a `footer`. Never
 * accent. With `onClick` the whole card is one button, a destination or a
 * choice; controls cannot sit inside a button, so a clickable card takes no
 * `actions`. DOM props land on the root.
 */
export type PluginCardProps =
  | (PluginCardBaseProps & {
      onClick?: undefined;
      /** Trailing controls in the header row. */
      actions?: ReactNode;
      disabled?: undefined;
    })
  | (PluginCardBaseProps & {
      /** Makes the whole card a button that calls this. */
      onClick: (event: MouseEvent<HTMLButtonElement>) => void;
      actions?: undefined;
      disabled?: boolean;
    });

/**
 * Props of `Divider`: a hairline between groups. A `label` sits in the middle
 * of a horizontal line ("or", "Older").
 */
export interface PluginDividerProps extends PluginRootAttributes {
  /** `horizontal` (the default) spans the width; `vertical` stretches to the row's height. */
  orientation?: "horizontal" | "vertical";
  /** Short text centred on a horizontal line. Ignored on a vertical one. */
  label?: ReactNode;
  className?: string;
}

/**
 * Props of `SectionLabel`: the small quiet heading above a group of content.
 * It is drawn uppercase, so write the text in sentence case, and keep it to a
 * word or two of your own vocabulary: never a branch, a path or anything the
 * user typed, which uppercasing would misstate.
 */
export interface PluginSectionLabelProps extends PluginRootAttributes {
  children?: ReactNode;
  /**
   * `section` (the default) names a section of a pane, page or card.
   * `list` is a step smaller, for a band of rows inside a list.
   */
  variant?: "section" | "list";
  /** The element. Defaults to `h3` for `section` and `div` for `list`. */
  as?: "h2" | "h3" | "h4" | "div";
  className?: string;
}

/**
 * Props of `ResizableSplit`: two panes with a draggable divider between them.
 * One pane (`sizedPane`) holds a size in px and the other takes the rest. The
 * divider is keyboard resizable (arrows, Shift+arrows, Home, End) and
 * double-click resets it. Sizes commit when a drag ends, so `onSizeChange`
 * runs once per gesture, not on every frame. It fills its container.
 */
export interface PluginResizableSplitProps extends PluginRootAttributes {
  first: ReactNode;
  second: ReactNode;
  /** `horizontal` (the default) puts the panes side by side; `vertical` stacks them. */
  orientation?: "horizontal" | "vertical";
  /** The pane that holds the size. Defaults to `first`. */
  sizedPane?: "first" | "second";
  /** Required: names the divider ("Resize file list"). */
  "aria-label": string;
  /** The sized pane's size in px, controlled. */
  size?: number;
  /** The starting size in px when uncontrolled, and what a reset returns to. Defaults to 280. */
  defaultSize?: number;
  /** Called with the new size when a drag ends, on a key press and on a reset. */
  onSizeChange?: (size: number) => void;
  /** In px. Defaults to 160. */
  minSize?: number;
  /** In px. Defaults to 640. The sized pane never takes more than its container either way. */
  maxSize?: number;
  /**
   * Lets the sized pane collapse: dragging it below half its `minSize`
   * collapses it, and Enter or Space on the divider toggles it. The divider
   * stays at the edge, so dragging it out or an arrow key brings the pane back.
   * A collapsed pane stays mounted, keeping its state.
   */
  collapsible?: boolean;
  collapsed?: boolean;
  defaultCollapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  className?: string;
}

/** One section of an `Accordion`. */
export interface PluginAccordionItem {
  value: string;
  title: ReactNode;
  /** Mounted only while the section is open. */
  content: ReactNode;
  /** Beside the title: a count or a `Badge`. Text, never a control. */
  trailing?: ReactNode;
  disabled?: boolean;
}

/**
 * Props of `Accordion`: stacked sections, each a heading button that shows or
 * hides its content. Up/Down/Home/End move between the headings. `value` is
 * the open sections in both modes; `single` keeps at most one open.
 */
export interface PluginAccordionProps extends PluginRootAttributes {
  items: readonly PluginAccordionItem[];
  /** `single` (the default) opens one section at a time; `multiple` any number. */
  type?: "single" | "multiple";
  /** The open sections' values, controlled. */
  value?: readonly string[];
  defaultValue?: readonly string[];
  onValueChange?: (value: string[]) => void;
  /** The heading level of each section's title. Defaults to 3. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  className?: string;
}

/** Props of `Disclosure`: one heading button that shows or hides the content under it. */
export interface PluginDisclosureProps extends PluginRootAttributes {
  title: ReactNode;
  /** Mounted only while open. */
  children?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Beside the title: a count or a `Badge`. Text, never a control. */
  trailing?: ReactNode;
  disabled?: boolean;
  /** The heading level of the title. Defaults to 3. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  className?: string;
}

/** One row of a `DescriptionList`: a label and its value. */
export interface PluginDescriptionItem {
  label: ReactNode;
  /** Empty draws a quiet dash, read as "None". */
  value?: ReactNode;
  /** One quiet line under the value. */
  hint?: ReactNode;
  /** Draws a copy button after the value that copies this text. */
  copyText?: string;
}

/**
 * Props of `DescriptionList`: the label and value rows of a record's detail
 * page. Give the rows as `items`, or as `DescriptionListItem` children.
 */
export interface PluginDescriptionListProps extends PluginRootAttributes {
  items?: readonly PluginDescriptionItem[];
  children?: ReactNode;
  /** `inline` (the default) puts labels in a column beside the values; `stacked` puts each label above its value. */
  layout?: "inline" | "stacked";
  /** Draws a copy button after every value that is text or a number. An item's `copyText` wins. */
  copyable?: boolean;
  className?: string;
}

/** Props of `DescriptionListItem`: one row, as a child of `DescriptionList`. */
export interface PluginDescriptionListItemProps
  extends PluginRootAttributes, PluginDescriptionItem {
  className?: string;
}

// Inputs: radio groups, numbers, sliders, pickers, tags, file drops and emoji.
// Each joins an enclosing `FormField` on its own; in a `SettingsRow`, pass the
// row's `labelId` and `descriptionId` as `aria-labelledby` / `aria-describedby`.

/** One choice in a `RadioGroup`. */
export interface PluginRadioOption {
  /** Non-empty and unique within the group. */
  value: string;
  label: string;
  /** A second line under the label, announced as the option's description. */
  description?: string;
  disabled?: boolean;
}

/**
 * Props of `RadioGroup`: exactly one of a few options, each shown with its
 * label and an optional description. Native radios, so the group is one tab
 * stop and the arrow keys move the choice.
 */
export interface PluginRadioGroupProps extends PluginRootAttributes {
  options: readonly PluginRadioOption[];
  /**
   * The chosen value, controlled. Passing the prop at all makes the group
   * controlled: `""`, `null` or `undefined` then leaves nothing chosen. Leave
   * it out entirely for an uncontrolled group.
   */
  value?: string | null;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** `vertical` (the default) stacks the options; `horizontal` sets them side by side. */
  orientation?: "vertical" | "horizontal";
  /** `card` (the default) draws each option as a bordered, clickable card; `plain` as a bare radio and label. */
  variant?: "card" | "plain";
  /** The radios' form name. Generated when omitted. */
  name?: string;
  disabled?: boolean;
  required?: boolean;
  /** Names the group when no `FormField` label does. */
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  className?: string;
}

/**
 * Props of `NumberInput`: a number field with optional stepper buttons. Typing
 * is free; the value commits on blur, Enter, a stepper press or an arrow key,
 * clamped to `min`/`max` and rounded to `precision`. Text that is not a number
 * marks the field invalid while you type and reverts on commit.
 */
export interface PluginNumberInputProps extends PluginAriaRootAttributes {
  /**
   * The value, controlled. Passing the prop at all makes the field controlled;
   * `null` is an empty field. Leave it out for an uncontrolled field.
   */
  value?: number | null;
  defaultValue?: number | null;
  /** The committed value. `null` when the field is cleared (never, with `required`). */
  onValueChange?: (value: number | null) => void;
  min?: number;
  max?: number;
  /** What an arrow key or a stepper press adds. Shift, Page Up and Page Down step ten times. Defaults to 1. */
  step?: number;
  /** Decimal places the value is rounded to and shown with. Defaults to the step's own. */
  precision?: number;
  /** A suffix drawn inside the field ("ms", "px", "%") and spoken with the value. */
  unit?: string;
  /** The decrease and increase buttons. Defaults to `true`. */
  stepper?: boolean;
  placeholder?: string;
  name?: string;
  disabled?: boolean;
  readOnly?: boolean;
  /** An empty field reverts to the last value rather than committing `null`. */
  required?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  density?: "default" | "compact";
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  /** Classes for the field's outer box. */
  className?: string;
}

/**
 * Props of `Slider`: one value on a track, for a setting where the rough
 * position matters more than the exact figure. The track is neutral. Arrow
 * keys step, Page Up/Down step ten times, Home/End jump to the ends.
 */
export interface PluginSliderProps extends PluginAriaRootAttributes {
  /** The value, controlled. A number makes the slider controlled. */
  value?: number;
  defaultValue?: number;
  /** Every move of the thumb. */
  onValueChange?: (value: number) => void;
  /** Once a drag or a key press ends: the moment to save. */
  onValueCommit?: (value: number) => void;
  /** Defaults to 0. */
  min?: number;
  /** Defaults to 100. */
  max?: number;
  /** Defaults to 1. */
  step?: number;
  /** The value in words, spoken as `aria-valuetext` and shown by `showValue` ("40%", "2 s"). */
  formatValue?: (value: number) => string;
  /** Shows the formatted value beside the track. */
  showValue?: boolean;
  name?: string;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  className?: string;
}

/**
 * The props `Combobox` and `MultiSelect` share: a trigger that looks like a
 * `Select`'s, opening a searchable, virtualised list.
 */
export interface PluginPickerBaseProps extends PluginAriaRootAttributes {
  /** Values non-empty and unique, as for `Select`. */
  options: readonly (PluginSelectOption | PluginSelectOptionGroup)[];
  /** Shown on the trigger while nothing is chosen. */
  placeholder?: string;
  /** The search field's placeholder. Defaults to "Search…". */
  searchPlaceholder?: string;
  /** The query on every keystroke, for options you load as the user types. */
  onSearchChange?: (query: string) => void;
  /**
   * `contains` (the default) filters `options` by label and description as the
   * user types. `none` shows `options` as given: for options you filter or
   * fetch yourself from `onSearchChange`.
   */
  filter?: "contains" | "none";
  /** Options are on their way: the list says so rather than "No matches". */
  loading?: boolean;
  /** What the list says when nothing matches. Defaults to "No matches". */
  emptyMessage?: ReactNode;
  disabled?: boolean;
  density?: "default" | "compact";
  name?: string;
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  /** Classes for the trigger. */
  className?: string;
}

/** Props of `Combobox`: a single choice from a list long enough to want a search. */
export interface PluginComboboxProps extends PluginPickerBaseProps {
  /**
   * The chosen value, controlled. Passing the prop at all makes it controlled:
   * `""`, `null` or `undefined` then shows the placeholder again.
   */
  value?: string | null;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Offers the typed text as a value of its own when no option's label matches it exactly. */
  allowCustomValue?: boolean;
}

/** Props of `MultiSelect`: any number of choices, such as labels or assignees. */
export interface PluginMultiSelectProps extends PluginPickerBaseProps {
  /** The chosen values, controlled. Passing the prop at all makes it controlled. */
  value?: readonly string[];
  defaultValue?: readonly string[];
  /** The whole new selection, in the order the values were chosen. */
  onValueChange?: (value: string[]) => void;
  /** At most this many; the rest of the list is disabled once it is reached. */
  max?: number;
  /** Chips on the trigger before the rest collapse into "+N". Defaults to 3. */
  maxChips?: number;
}

/**
 * Props of `TagInput`: free-text tags. Enter or a comma adds the text, a
 * pasted list is split on commas and new lines, Backspace in the empty field
 * removes the last tag, and a tag already there (ignoring case) is not added
 * twice.
 */
export interface PluginTagInputProps extends PluginAriaRootAttributes {
  /** The tags, controlled. Passing the prop at all makes it controlled. */
  value?: readonly string[];
  defaultValue?: readonly string[];
  onValueChange?: (value: string[]) => void;
  /** Refuse a tag by returning `false`: the text stays in the field, marked invalid. */
  validate?: (tag: string, tags: readonly string[]) => boolean;
  /** At most this many tags. */
  max?: number;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  className?: string;
}

/**
 * Props of `FileDropzone`: a drop target with a button that opens the
 * system's file dialog. You get `File` objects: name, size, type and contents
 * (`file.text()`, `file.arrayBuffer()`), never a path on disk.
 */
export interface PluginFileDropzoneProps extends PluginRootAttributes {
  /** The accepted files from a drop or the dialog. Never called with an empty list. */
  onFiles: (files: File[]) => void;
  /** Dropped files `accept` ruled out. The dialog only offers accepted ones. */
  onReject?: (files: File[]) => void;
  /** As on `<input type="file">`: extensions (`.md`) and MIME types (`image/*`), comma-separated. */
  accept?: string;
  /** More than one file at a time. Without it, a drop of several keeps the first. */
  multiple?: boolean;
  disabled?: boolean;
  /** The headline. Defaults to "Drop files here" (or "Drop a file here"). */
  label?: ReactNode;
  /** One quiet line under it: what fits ("Markdown or text, up to 1 MB"). */
  description?: ReactNode;
  /** Defaults to `upload`. */
  icon?: PluginIconSource;
  /** The button's label. Defaults to "Choose files…" (or "Choose file…"). */
  browseLabel?: string;
  /** Replaces the headline, description and icon; the button stays. */
  children?: ReactNode;
  className?: string;
}

/**
 * Props of `EmojiPicker`: Daintree's emoji picker in a popover opened from
 * `trigger`, with search, categories and the keyboard grid. Picking closes it.
 */
export interface PluginEmojiPickerProps {
  /** The element that opens it; it must accept a ref and DOM props (a kit `Button` does). */
  trigger: ReactElement;
  onSelect: (emoji: string) => void;
  /** The emoji you hold now, marked in the grid. */
  value?: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: PluginSide;
  align?: PluginAlign;
  /** Names the panel. Defaults to "Choose emoji". */
  "aria-label"?: string;
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
