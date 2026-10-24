// Display: Markdown, typography, inline elements and small status primitives,
// avatars, chips, timelines, progress, media, ANSI output, the image viewer and
// the table of contents.

import type { ReactNode } from "react";
import type { PluginArtifact } from "../pluginArtifacts.js";
import type {
  PluginAriaRootAttributes,
  PluginDomProps,
  PluginIconSource,
  PluginRootAttributes,
  PluginSeverity,
} from "./common.js";
import type { PluginContainerTarget } from "./layout.js";

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
  /**
   * Puts a "Today", "Yesterday" or date header before each day's entries.
   * Entries without a timestamp stay under the header above them. It does not
   * sort: give `items` in date order, newest first, or a day's header repeats.
   */
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

/** An artifact as the media components take it: the handle, or the id of one your plugin owns. */
export type PluginMediaSource = Pick<PluginArtifact, "id" | "mimeType" | "name"> | string;

/**
 * Props of `MediaPlayer`: an audio or video artifact played from the host's
 * cache with the system's own accessible controls, seeking by byte range. It
 * never plays on its own, and it pauses when the person moves away — the
 * window hidden, the project in the background, the view parked — without
 * resuming on return. Provider controls (share, re-download, captions from a
 * service) are yours: render them beside it.
 */
export interface PluginMediaPlayerProps extends PluginRootAttributes {
  source: PluginMediaSource;
  /** Names the player for assistive technology. Defaults to the artifact's name. */
  "aria-label"?: string;
  /** An image artifact shown before a video plays. */
  poster?: PluginMediaSource;
  loop?: boolean;
  muted?: boolean;
  /** `"keep-playing"` opts out of the pause on moving away, for audio meant to run in the background. */
  whenAway?: "pause" | "keep-playing";
  /** The source could not be loaded or played. The player shows the reason with a Retry. */
  onError?: (error: Error) => void;
  className?: string;
}

/**
 * Props of `MediaThumbnail`: a still for an artifact — the image itself, a
 * video's first frame, or a glyph for audio and anything else. Decorative
 * unless named: give it `alt` when it carries meaning on its own.
 */
export interface PluginMediaThumbnailProps extends PluginRootAttributes {
  source: PluginMediaSource;
  /** The thumbnail's text alternative. Without it the thumbnail is decorative. */
  alt?: string;
  /** Defaults to `md` (64 px). */
  size?: "sm" | "md" | "lg";
  className?: string;
}

/**
 * Steps of Daintree's type ramp: Tailwind's stock `xs` (12px), `sm` (14px),
 * `base` (16px) and `lg` (18px), plus the app's own label steps `2xs` (11px)
 * and `3xs` (10px). `inherit` takes the size of the surrounding text.
 */
export type PluginTextSize = "3xs" | "2xs" | "xs" | "sm" | "base" | "lg" | "inherit";

/**
 * Daintree's text colour roles. `primary` is body text, `secondary` supporting
 * text and icons, `muted` the quietest (it has no contrast floor on some dark
 * themes, so never put anything the user must read in it). The status tones
 * carry an outcome; `accent` is at most one load-bearing signal per region.
 * `inherit` takes the surrounding colour.
 */
export type PluginTextTone =
  "primary" | "secondary" | "muted" | "danger" | "success" | "warning" | "accent" | "inherit";

/**
 * Props of `Text`: a run of text on the app's type ramp and in one of its
 * colour roles, so a view never spells font sizes or colour classes by hand.
 */
export interface PluginTextProps extends PluginDomProps {
  children?: ReactNode;
  /** A step of the type ramp. Defaults to `sm`, the app's reading size. */
  size?: PluginTextSize;
  /** A colour role. Defaults to `primary`. */
  tone?: PluginTextTone;
  /** The app's monospace face, for paths, hashes and identifiers. */
  mono?: boolean;
  /** Omitted, the weight is inherited, so a `strong` keeps its own emphasis. */
  weight?: "normal" | "medium" | "semibold";
  /**
   * One line, cut with an ellipsis. The element becomes a block so it has a
   * width to cut at; put it in a `TruncatedTooltip` to show the whole text.
   */
  truncate?: boolean;
  /** The element. Defaults to `span`; `p` for a paragraph. */
  as?: "span" | "p" | "div" | "strong" | "em" | "small";
  className?: string;
}

/**
 * Props of `Heading`: a heading at one of the app's four heading sizes. The
 * level picks both the size and the element (`h1`–`h4`) unless `as` says
 * otherwise, so a view can keep a correct outline while drawing a smaller
 * size.
 */
export interface PluginHeadingProps extends PluginDomProps<HTMLHeadingElement> {
  children?: ReactNode;
  /** 1: 18px, 2: 16px, 3: 14px, 4: 12px, all semibold. Defaults to 2. */
  level?: 1 | 2 | 3 | 4;
  /** The element, when the outline needs a different level than the size. */
  as?: "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "div";
  /** Defaults to `primary`. */
  tone?: "primary" | "secondary";
  truncate?: boolean;
  className?: string;
}

/**
 * Props of `Link`: an inline link that routes a click exactly as `Markdown`
 * does. `http(s)` and `mailto` links open in the browser; a relative or
 * absolute path opens in Daintree's file viewer while it stays inside
 * `rootPath`. Nothing navigates the view itself.
 */
export interface PluginLinkProps extends PluginDomProps<HTMLAnchorElement> {
  href: string;
  children?: ReactNode;
  /**
   * Absolute path a relative `href` resolves against: a directory, or a
   * Markdown file whose directory is used, as `Markdown`'s `basePath`.
   */
  basePath?: string;
  /**
   * Absolute directory a file link must stay inside. Defaults to the
   * directory `basePath` resolves to. With neither, a path opens nothing.
   */
  rootPath?: string;
  /** Draws a small arrow after an `http(s)` link's text, and names it as opening in the browser. */
  externalIcon?: boolean;
  className?: string;
}

/** Props of `InlineCode`: a code span in running text. */
export interface PluginInlineCodeProps extends PluginRootAttributes {
  children?: ReactNode;
  className?: string;
}

/**
 * Props of `CodeBlock`: a read-only, highlighted snippet with a copy button,
 * in the same token colours as the app's diffs and Markdown fences.
 */
export interface PluginCodeBlockProps extends PluginRootAttributes {
  /** The text shown and copied. A trailing newline is dropped. */
  code: string;
  /**
   * A grammar name or fence alias (`ts`, `tsx`, `json`, `bash`, `python`,
   * `yaml`, `go`, `rust`, …). Unknown or omitted, the code shows as plain text.
   */
  language?: string;
  /** Draws line numbers in a gutter. They are never copied. */
  lineNumbers?: boolean;
  /** Line numbers to mark, as the gutter counts them (from `startLine`). A tint and an edge, never colour alone. */
  highlightLines?: readonly number[];
  /** The number the first line counts from. Defaults to 1. */
  startLine?: number;
  /** A height in px past which the block scrolls. */
  maxHeight?: number;
  /** Wraps long lines instead of scrolling sideways. */
  wrap?: boolean;
  /** Shows the copy button. Defaults to true. */
  copyable?: boolean;
  /** Names the block for assistive tech ("Install command"). */
  "aria-label"?: string;
  className?: string;
}

/**
 * Props of `PathLabel`: a file path on one line that gives way in the middle.
 * The directory ellipsises from its start while the file name stays whole, so
 * `…/Settings/AgentSettings.tsx` rather than `src/components/Sett…`. While it is
 * cut, the full path shows in a tooltip.
 */
export interface PluginPathLabelProps extends PluginRootAttributes {
  path: string;
  /** Draws the path in the monospace face. */
  mono?: boolean;
  /** Pass `false` inside a row that already owns the keyboard. Defaults to true. */
  focusable?: boolean;
  className?: string;
}

/** Props of `VisuallyHidden`: content read by assistive tech and not drawn. */
export interface PluginVisuallyHiddenProps extends PluginRootAttributes {
  children?: ReactNode;
  /** Defaults to `span`. */
  as?: "span" | "div";
}

/**
 * Props of `LiveRegion`: an element whose changes assistive tech reads out.
 * Keep it mounted and change its children; a region that mounts with its
 * message already inside is often not read. For one-off messages use
 * `useAnnounce` instead.
 */
export interface PluginLiveRegionProps extends PluginRootAttributes {
  children?: ReactNode;
  /** `polite` (the default) waits for a pause; `assertive` interrupts, for errors only. */
  politeness?: "polite" | "assertive";
  /** Reads the whole region on each change rather than just what changed. Defaults to true. */
  atomic?: boolean;
  /** Keeps the region off screen. Defaults to false. */
  visuallyHidden?: boolean;
  className?: string;
}

/** Options of the function `useAnnounce` returns. */
export interface PluginAnnounceOptions {
  /** `polite` (the default) waits for a pause; `assertive` interrupts, for errors only. */
  politeness?: "polite" | "assertive";
}

/**
 * Props of `Portal`: renders its children into a container outside the view,
 * the document body by default, marked as your plugin's style root so your
 * classes still apply there. Position what you put in it yourself.
 */
export interface PluginPortalProps {
  children?: ReactNode;
  /** An element to render into instead of the document body. */
  container?: Element | null;
}

/** The states `StatusDot` and `StateGlyph` draw. */
export type PluginStatusState = "running" | "idle" | "waiting" | "error" | "success" | "neutral";

/**
 * Props of `StatusDot`: the app's 6px activity dot. `running` and `waiting`
 * take the agent working and waiting hues, `error` and `success` the status
 * colours, `neutral` the secondary ink, and `idle` is a hollow ring, so idle
 * never rests on colour alone.
 */
export interface PluginStatusDotProps extends PluginRootAttributes {
  state: PluginStatusState;
  /** Names the state for assistive tech. Without it the dot is decorative. */
  label?: string;
  /** A slow pulse while something is live. Still under reduced motion. */
  pulse?: boolean;
  /** `sm` 6px (the default), `md` 8px. */
  size?: "sm" | "md";
  className?: string;
}

/**
 * Props of `StateGlyph`: the app's state glyph at icon size. `running` is the
 * agent working spinner, `waiting` the amber ring, `idle` a plain ring,
 * `success` and `error` the severity glyphs, `neutral` a ring with a bar.
 */
export interface PluginStateGlyphProps extends PluginRootAttributes {
  state: PluginStatusState;
  /** Names the state for assistive tech. Without it the glyph is decorative. */
  label?: string;
  /** In px. Defaults to 16. */
  size?: number;
  className?: string;
}

/**
 * Props of `ColoredLabel`: a tag in a colour the user chose, such as a
 * GitHub or GitLab label. Drawn like a `Badge`, as a tint of the colour with
 * the text shifted until it reads at 4.5:1 on that tint over the pane, a raised
 * panel and a hovered row in the active theme, light or dark, and an edge so a pale colour keeps its
 * shape.
 */
export interface PluginColoredLabelProps extends PluginDomProps<HTMLSpanElement> {
  /** `#rgb` or `#rrggbb`, with or without the `#`. Anything else draws a neutral badge. */
  color: string;
  children?: ReactNode;
  /** As `Badge`: `xs`, `sm` (the default), `md`. */
  size?: "xs" | "sm" | "md";
  /** As `Badge`. `pill` is fully rounded. */
  shape?: "default" | "pill";
  /**
   * `tint` (the default) colours the whole label. `dot` is the chip Daintree's
   * own forge labels use: a neutral outline badge with the colour on a dot
   * before the name, for a dense row where many colours would be loud.
   */
  variant?: "tint" | "dot";
  className?: string;
}

/** Where `UnreadDot` and `CountIndicator` sit on the element they wrap. */
export type PluginIndicatorPlacement = "top-right" | "top-left" | "bottom-right" | "bottom-left";

/**
 * Props of `UnreadDot`: the app's 6px neutral unread pip. With `children` it
 * sits on their corner, cut out from them; alone it is an inline dot.
 */
export interface PluginUnreadDotProps extends PluginRootAttributes {
  children?: ReactNode;
  /** Shows the dot. Defaults to true; `false` keeps `children` alone. */
  visible?: boolean;
  /**
   * What the dot means ("Unread replies"). On a single element child it is
   * attached to that element as its description; otherwise it is read beside it.
   */
  label?: string;
  /** Defaults to `top-right`. */
  placement?: PluginIndicatorPlacement;
  className?: string;
}

/**
 * Props of `CountIndicator`: a count in the app's count pill, capped at
 * `max` ("99+"). With `children` it overlaps their corner as a solid bubble;
 * alone it is the inline count `NavList` and `Tabs` draw.
 */
export interface PluginCountIndicatorProps extends PluginRootAttributes {
  count: number;
  children?: ReactNode;
  /** Past this the pill reads "99+". Defaults to 99. */
  max?: number;
  /** Shows a zero. Defaults to false: zero draws nothing. */
  showZero?: boolean;
  /**
   * What the count means, spoken in place of the numeral ("3 unread"). On a
   * single element child it is attached to that element as its description.
   */
  label?: string;
  /** Defaults to `top-right`. */
  placement?: PluginIndicatorPlacement;
  className?: string;
}

/**
 * Props of `AnsiText`: a short run of CLI output with its ANSI colours and
 * styles, inline in your text. For a whole log, use `TerminalOutput`.
 */
export interface PluginAnsiTextProps extends PluginRootAttributes {
  /** The raw output, escape codes and all. Carriage returns and `\x1b[K` rewrite the line as a terminal would. */
  text: string;
  /** `inline` (the default) flows in a sentence; `block` is its own monospace block that keeps every line break. */
  display?: "inline" | "block";
  className?: string;
}

/**
 * Props of `TerminalOutput`: CLI output drawn in the host terminal's colours,
 * virtualised, with a wrap toggle, a copy button and optional line numbers.
 */
export interface PluginTerminalOutputProps extends PluginAriaRootAttributes {
  /**
   * Everything the process has printed so far, escape codes and all. Pass
   * the longer string as output arrives: when the new text starts with the
   * old, only the new tail is parsed.
   */
  text: string;
  /** Required: names the output for assistive tech ("Build log"). */
  "aria-label": string;
  /** A quiet title at the start of the toolbar ("npm test"). */
  title?: ReactNode;
  /** Your own controls in the toolbar, before Wrap and Copy. */
  actions?: ReactNode;
  /** Draws the toolbar strip. Defaults to true. */
  toolbar?: boolean;
  /** Wraps long lines, controlled. Pair with `onWrapChange`. */
  wrap?: boolean;
  /** Whether lines wrap at first when `wrap` is not given. Defaults to true. */
  defaultWrap?: boolean;
  onWrapChange?: (wrap: boolean) => void;
  /** Numbers each line in a gutter. */
  lineNumbers?: boolean;
  /** Stays pinned to the newest line while the reader is at the bottom. Defaults to true. */
  follow?: boolean;
  /** The newest lines kept. Defaults to 10,000 (at most 100,000); older lines are dropped from the view. */
  maxLines?: number;
  /** Shown while there is no output. Defaults to a quiet "No output". */
  empty?: ReactNode;
  /** Classes for the outer frame. It fills its container's height. */
  className?: string;
}

/** One picture in an `ImageViewer`. */
export interface PluginImageViewerImage {
  /** Any URL the view can load: `data:`, `blob:`, `https:`. */
  src: string;
  /** Required: what the picture shows. */
  alt: string;
  /** A line under the picture. */
  caption?: ReactNode;
}

/**
 * Props of `ImageViewer`: a screenshot or design preview with zoom, pan and
 * stepping through a set, in a pane or as a modal lightbox.
 */
export interface PluginImageViewerProps extends PluginRootAttributes {
  images: readonly PluginImageViewerImage[];
  /** The picture shown, controlled. Pair with `onIndexChange`. */
  index?: number;
  /** The picture shown first when `index` is not given. Defaults to 0. */
  defaultIndex?: number;
  onIndexChange?: (index: number) => void;
  /** `pane` (the default) fills its container; `modal` is a lightbox over the window. */
  mode?: "pane" | "modal";
  /** `modal` only: whether the lightbox is open. */
  open?: boolean;
  /** `modal` only: called with `false` when the lightbox closes (Escape, the close button). */
  onOpenChange?: (open: boolean) => void;
  /** `modal` only: the lightbox's title. Defaults to "Image". */
  title?: ReactNode;
  /**
   * The zoom each picture opens at: `fit` (the default) shrinks it to the
   * stage, `actual` draws it at its own pixels, and a number is a scale of
   * them (2 is 200%).
   */
  defaultZoom?: "fit" | "actual" | number;
  /** Draws a checkerboard under the picture, so transparency shows. Defaults to true. */
  checkerboard?: boolean;
  /** Names the viewer. Defaults to the picture's `alt`. */
  "aria-label"?: string;
  className?: string;
}

/** One entry of a `TableOfContents`. */
export interface PluginTocHeading {
  /** The heading element's `id`, when it has one. */
  id?: string;
  text: string;
  /** 1 to 6, as `h1` to `h6`. */
  level: number;
}

/**
 * Props of `TableOfContents`: the headings of a document as a sticky outline
 * that tracks the section in view and scrolls to the one clicked.
 */
export interface PluginTableOfContentsProps extends PluginRootAttributes {
  /** The Markdown the document renders, read for its headings. */
  markdown?: string;
  /** The headings themselves, when there is no Markdown source. */
  headings?: readonly PluginTocHeading[];
  /**
   * The element the document is drawn in (a ref, or the element). Its `h1`
   * to `h6` are matched to the headings in order (by `id` when a heading has
   * one), and the scroller around it is the one tracked and scrolled.
   */
  target: PluginContainerTarget;
  /** The deepest level listed. Defaults to 3. */
  maxLevel?: number;
  /** Lets a heading's subsections fold. Defaults to true. */
  collapsible?: boolean;
  /** Sticks to the top of its own scroller. Defaults to true. */
  sticky?: boolean;
  /** The quiet title above the list. Defaults to "On this page"; `null` for none. */
  title?: ReactNode;
  /** How far below the scroller's top edge, in px, a heading counts as reached. Defaults to 24. */
  offset?: number;
  /** Called with the heading and its index after a click scrolls to it. */
  onNavigate?: (heading: PluginTocHeading, index: number) => void;
  /** Names the navigation landmark. Defaults to "Table of contents". */
  "aria-label"?: string;
  className?: string;
}
