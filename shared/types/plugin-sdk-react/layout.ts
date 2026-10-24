// Layout: pane chrome, toolbars, tabs, the settings grammar, breadcrumbs, nav
// lists, steppers, cards, accordions, description lists, stacks, grids, the
// pane shell, status strips, scrollers, the folding toolbar, container-size
// hooks, list and detail, multi-pane splits, inspectors, in-pane drawers,
// selection bars, pagination footers, job queues and stale-data signals.

import type { MouseEvent, ReactNode, Ref, RefObject } from "react";
import type { PluginChartColor } from "./charts.js";
import type {
  PluginAriaRootAttributes,
  PluginDomProps,
  PluginIconSource,
  PluginRootAttributes,
} from "./common.js";

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
 * It forwards refs and DOM handlers like `Button`, so it can be the trigger of
 * a `DropdownMenu`, `Popover`, `Tooltip` or `ContextMenu`; the state such a
 * trigger injects (`aria-expanded`) is kept.
 */
export interface PluginToolbarButtonProps extends Omit<
  PluginDomProps<HTMLButtonElement>,
  "aria-label" | "onClick"
> {
  icon?: PluginIconSource;
  /** Visible text. Omitted, the button is icon-only and `aria-label` names it. */
  label?: string;
  "aria-label"?: string;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** A toggle's state (`aria-pressed`). */
  pressed?: boolean;
  /**
   * A disclosure's state (`aria-expanded`). Never set with `pressed`: a
   * disclosure state, this or a trigger's, wins over `pressed`.
   */
  expanded?: boolean;
  /** Stays in the arrow-key order, announced unavailable, and ignores clicks. */
  disabled?: boolean;
  /** Tooltip text when it says more than the name (a shortcut). `false` for none. */
  tooltip?: ReactNode | false;
  tooltipSide?: "top" | "bottom";
  /** Work it started is in flight: the icon becomes a spinner, the button is `aria-busy` and ignores clicks. */
  loading?: boolean;
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

/** One tab of `Tabs`. */
export interface PluginTabItem {
  value: string;
  label: string;
  icon?: PluginIconSource;
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
  /**
   * Controls at the strip's trailing end, outside the tablist: a refresh
   * button and its "Updated" age, a filter. Keep it to a few `ToolbarButton`s
   * and quiet text.
   */
  trailing?: ReactNode;
  className?: string;
  /** Classes for the tab panel. */
  panelClassName?: string;
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
  /** The reset button's accessible name. Defaults to "Reset {label} to default". */
  resetAriaLabel?: string;
  id?: string;
}

/** Props of `SettingsActions`: the last row of a group with an explicit Save. */
export interface PluginSettingsActionsProps extends PluginRootAttributes {
  /** The actions, right-aligned: `contrast` Save, `outline` others, all `size="sm"`. */
  children?: ReactNode;
  /** Status on the left ("Saved"), announced politely. */
  status?: ReactNode;
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
   * read-only detail block inside another surface. `elevated` lifts off the
   * page on the raised surface with a soft shadow, so a section reads as an
   * object rather than an outline. `feature` is the one card a view leads
   * with: elevated, rounder, roomier, with a larger title and an optional
   * `capColor` cap. Use at most one `feature` card per view.
   */
  variant?: "default" | "inset" | "elevated" | "feature";
  /**
   * A `feature` card's 2px top cap, in one of the charts' category colours:
   * the view's own colour for its answer. Ignored on other variants.
   */
  capColor?: PluginChartColor;
  /**
   * The body's padding: 16 px (`md`, the default; 20 px on a `feature` card),
   * 12 px (`sm`), or none, for a list or table edge to edge.
   */
  padding?: "none" | "sm" | "md";
  /** How the footer's contents sit: `end` (the default), `start`, `between` (first item at the start, the rest at the end) or `stretch` (each fills an equal share). */
  footerAlign?: "end" | "start" | "between" | "stretch";
  className?: string;
}

/**
 * Props of `Card`: the app's card surface, a hairline frame with an optional
 * header (`title`, `description`, `actions`), a body and a `footer`. The
 * frame never takes accent; a `feature` card's `capColor` cap is the one place a
 * card carries colour. With `onClick` the whole card is one button, a destination or a
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
  /** `end` aligns inline values to the trailing edge with tabular digits, for a list of figures. Defaults to `start`. */
  valueAlign?: "start" | "end";
  /** The inline label column's width (px or a CSS length). Defaults to fit its labels, up to 40%. */
  labelWidth?: number | string;
  className?: string;
}

/** Props of `DescriptionListItem`: one row, as a child of `DescriptionList`. */
export interface PluginDescriptionListItemProps
  extends PluginRootAttributes, PluginDescriptionItem {
  className?: string;
}

/**
 * The kit's spacing steps, on the scale Daintree's own panes use: `xs` 4px,
 * `sm` 8px, `md` 12px (a pane's inset), `lg` 16px, `xl` 24px.
 */
export type PluginLayoutGap = "none" | "xs" | "sm" | "md" | "lg" | "xl";

/** Cross-axis alignment of a layout's children. */
export type PluginLayoutAlign = "start" | "center" | "end" | "stretch" | "baseline";

/** Main-axis distribution of a layout's children. */
export type PluginLayoutJustify = "start" | "center" | "end" | "between" | "around" | "evenly";

/** The elements a layout component can render as. */
export type PluginLayoutElement =
  | "div"
  | "section"
  | "article"
  | "aside"
  | "header"
  | "footer"
  | "nav"
  | "main"
  | "form"
  | "fieldset"
  | "ul"
  | "ol"
  | "li"
  | "span";

/** What `Stack`, `Inline`, `Cluster`, `Grid` and `AutoGrid` share. DOM props land on the root. */
export interface PluginLayoutBaseProps extends Omit<PluginDomProps<HTMLElement>, "ref"> {
  children?: ReactNode;
  /** Space between children. */
  gap?: PluginLayoutGap;
  /** The element to render. Defaults to `div`. */
  as?: PluginLayoutElement;
  className?: string;
  ref?: Ref<HTMLElement>;
}

/** Props of `Stack`: children in a column. `gap` defaults to `md`, `align` to `stretch`. */
export interface PluginStackProps extends PluginLayoutBaseProps {
  align?: PluginLayoutAlign;
  justify?: PluginLayoutJustify;
}

/**
 * Props of `Inline`: children in a row. `gap` defaults to `sm`, `align` to
 * `center`. The row does not wrap unless `wrap` is set.
 */
export interface PluginInlineProps extends PluginLayoutBaseProps {
  align?: PluginLayoutAlign;
  justify?: PluginLayoutJustify;
  wrap?: boolean;
}

/**
 * Props of `Cluster`: a row that wraps, for chips, tags and badges. `gap`
 * defaults to `sm` and applies between rows too.
 */
export interface PluginClusterProps extends PluginLayoutBaseProps {
  align?: PluginLayoutAlign;
  justify?: PluginLayoutJustify;
}

/**
 * Props of `Grid`: explicit columns. A number is that many equal columns (1
 * to 12); a string is a `grid-template-columns` value (`"200px 1fr"`).
 * `gap` defaults to `md`.
 */
export interface PluginGridProps extends PluginLayoutBaseProps {
  columns?: number | string;
  /** Cross-axis alignment of the cells. Defaults to `stretch`. */
  align?: PluginLayoutAlign;
}

/**
 * Props of `AutoGrid`: as many equal columns as fit, each at least
 * `minColumnWidth` px, reflowing with the grid's own width rather than the
 * window's. `gap` defaults to `md`.
 */
export interface PluginAutoGridProps extends PluginLayoutBaseProps {
  /**
   * The narrowest a column may get, in px (up to 4096). Defaults to 180. A
   * grid narrower than this draws one column at its own width.
   */
  minColumnWidth?: number;
  /** Never more columns than this, however wide the grid gets. */
  maxColumns?: number;
  /**
   * `true` stretches a short row's cells to fill the width (CSS `auto-fit`);
   * the default keeps every column the same width as a full row's (`auto-fill`).
   */
  stretch?: boolean;
  /** Cross-axis alignment of the cells. Defaults to `stretch`. */
  align?: PluginLayoutAlign;
}

/**
 * Props of `PaneLayout`: the shell of a plugin panel. The header, toolbar,
 * footer and status bar keep their own heights and the body between them is
 * the only thing that scrolls. It fills the view's root.
 */
export interface PluginPaneLayoutProps extends PluginRootAttributes {
  /** Usually a `PaneHeader`. */
  header?: ReactNode;
  /** Usually a `Toolbar` or `OverflowToolbar` with `variant="bar"`. */
  toolbar?: ReactNode;
  /** The body. */
  children?: ReactNode;
  /** A strip above the status bar, such as a row of form actions. */
  footer?: ReactNode;
  /** Usually a `StatusBar`. */
  statusBar?: ReactNode;
  /**
   * How the body scrolls: `shadow` (the default) fades the edge that has more,
   * `plain` scrolls without fades, `none` does not scroll, for a body that
   * holds its own scroller (a `VirtualList`, a `ResizableSplit`).
   */
  scroll?: "shadow" | "plain" | "none";
  /** Inset of the body's content, on the gap scale. Defaults to `none`. */
  padding?: PluginLayoutGap;
  /** Classes for the body's content (inside the scroller). */
  bodyClassName?: string;
  /** The body's scrolling element (the body itself with `scroll="none"`). */
  bodyRef?: Ref<HTMLDivElement>;
  /** Names the body as a region for screen readers. */
  bodyLabel?: string;
  className?: string;
}

/**
 * A `StatusBar` slot: one node, or an array of facts drawn with a quiet dot
 * between them.
 */
export type PluginStatusBarSlot = ReactNode | readonly ReactNode[];

/**
 * Props of `StatusBar`: the thin strip along a pane's edge saying what the
 * view shows, with at most a control or two. Not a live region: announce
 * results yourself.
 */
export interface PluginStatusBarProps extends PluginAriaRootAttributes {
  /** Leading facts; they truncate first when the strip runs short. */
  left?: PluginStatusBarSlot;
  /** Centred between the two sides. */
  center?: PluginStatusBarSlot;
  /** Trailing facts and controls; they never truncate. */
  right?: PluginStatusBarSlot;
  /**
   * `compact` (the default) is a pane's bottom status strip in 11px text;
   * `comfortable` is the taller 12px metadata strip a file pane shows over its
   * content, which fits an `xs` `Button`.
   */
  density?: "compact" | "comfortable";
  /** Which edge the hairline is on: `bottom` (the default) draws it above the strip. */
  placement?: "bottom" | "top";
  className?: string;
}

/**
 * Props of `ScrollArea`: a scroller on either axis or both, fading each edge
 * that has more to scroll. DOM props land on the scrolling element; with an
 * `aria-label` or `aria-labelledby` and no `role`, it is a named `region`.
 */
export interface PluginScrollAreaProps extends Omit<PluginDomProps<HTMLDivElement>, "ref"> {
  children?: ReactNode;
  /** The axes that scroll. Defaults to `vertical`. */
  orientation?: "vertical" | "horizontal" | "both";
  /** Classes for the outer frame (size it here). */
  className?: string;
  /** Classes for the scrolling element (padding goes here). */
  scrollClassName?: string;
  /** A shorter fade, for dense content. */
  compact?: boolean;
  /** The scrolling element. */
  ref?: Ref<HTMLDivElement>;
}

/** A control of an `OverflowToolbar`: a toolbar button in the strip, a menu row once folded. */
export interface PluginOverflowToolbarAction {
  type?: "action";
  /** Non-empty and unique within the toolbar. */
  id: string;
  /** The button's name and its menu row's text. */
  label: string;
  icon?: PluginIconSource;
  onSelect?: () => void;
  /** Draws the label beside the icon in the strip. Icon-only by default. */
  showLabel?: boolean;
  /** A toggle's state: a pressed button in the strip, a check row in the menu. */
  pressed?: boolean;
  disabled?: boolean;
  /** Tooltip in the strip when it says more than the name. `false` for none. */
  tooltip?: ReactNode | false;
  /** A canonical combo for the menu's key column, e.g. `"Cmd+R"`. */
  shortcut?: string;
  /** A destructive menu row. */
  destructive?: boolean;
  /**
   * Higher stays in the strip longer. Among equals, the later control folds
   * first. Defaults to 0.
   */
  priority?: number;
}

/** A hairline between groups of an `OverflowToolbar`, in the strip and in the menu. */
export interface PluginOverflowToolbarSeparator {
  type: "separator";
}

export type PluginOverflowToolbarItem =
  PluginOverflowToolbarAction | PluginOverflowToolbarSeparator;

/**
 * Props of `OverflowToolbar`: a `Toolbar` whose controls fold into a "More
 * actions" menu when the strip is too narrow for them. One tab stop, Left and
 * Right between the controls and the menu button.
 */
export interface PluginOverflowToolbarProps extends PluginAriaRootAttributes {
  items: readonly PluginOverflowToolbarItem[];
  /** Required: two toolbars on screen must be told apart. */
  "aria-label": string;
  variant?: "inline" | "bar";
  /** Content before the controls that never folds (a title, a search field). */
  leading?: ReactNode;
  /** Content at the far end that never folds. */
  trailing?: ReactNode;
  /** The menu button's name. Defaults to "More actions". */
  overflowLabel?: string;
  className?: string;
}

/** A container's size in CSS px, as `useContainerSize` reports it. 0 before it is measured. */
export interface PluginContainerSize {
  width: number;
  height: number;
}

/** What `useContainerSize` and `useBreakpoint` observe: a ref, or the element itself. */
export type PluginContainerTarget = RefObject<Element | null> | Element | null | undefined;

/**
 * Props of `MasterDetail`: a list pane beside a detail pane that becomes one
 * pane with a Back strip when the panel is narrower than `collapseBelow`. It
 * answers to its own width, never the window's, and fills its container.
 */
export interface PluginMasterDetailProps extends PluginRootAttributes {
  /** The list pane, usually a `VirtualList` or `GroupedVirtualList`. */
  list: ReactNode;
  /** The detail pane: the selected record, or what to show while none is. */
  detail: ReactNode;
  /**
   * The selected record's id, controlled. Narrow, a value shows the detail
   * pane and `null` or `undefined` shows the list; wide, both show whatever it is.
   */
  selectedId?: string | number | null;
  /** The Back strip's button, narrow: clear `selectedId` here. */
  onBack?: () => void;
  /** Names the list pane as a region. Defaults to "List". */
  listLabel?: string;
  /** Names the detail pane as a region. Defaults to "Details". */
  detailLabel?: string;
  /** The Back button's name. Defaults to "Back". */
  backLabel?: string;
  /** What the Back strip shows beside the button, narrow: the record's title. */
  detailTitle?: ReactNode;
  /** Below this width in px the two panes become one. Defaults to 560. */
  collapseBelow?: number;
  /** The list pane's width in px when wide, before the reader resizes it. Defaults to 320. */
  defaultListSize?: number;
  /** In px. Defaults to 220. */
  minListSize?: number;
  /** In px. Defaults to 560. */
  maxListSize?: number;
  /**
   * Remembers the list pane's width under this key (see
   * `usePersistentViewState`). Without it the width lasts until unmount.
   */
  persistKey?: string;
  className?: string;
}

/** One pane of a `SplitGroup`. */
export interface PluginSplitPane {
  /** Non-empty and unique within the group. */
  id: string;
  content: ReactNode;
  /**
   * The pane's starting size in px. Omit it on the one pane that fills what
   * the others leave (or mark that pane `fill`); without either, the last pane fills.
   */
  defaultSize?: number;
  /** Takes the room the sized panes leave. At most one pane fills. */
  fill?: boolean;
  /** In px. Defaults to 120 (a filling pane: 0). */
  minSize?: number;
  /** In px. Defaults to 100000. */
  maxSize?: number;
  /**
   * The pane can collapse: a drag below half its `minSize`, or Enter or Space
   * on its handle. It stays mounted while collapsed. A filling pane cannot.
   */
  collapsible?: boolean;
  /** Starts collapsed when uncontrolled. */
  defaultCollapsed?: boolean;
  /** Names the pane's handle ("Resize inspector"). Defaults to "Resize pane". */
  handleLabel?: string;
}

/** A `SplitGroup`'s layout, as `onLayoutChange` reports it and `persistKey` stores it. */
export interface PluginSplitLayout {
  /** Each sized pane's size in px, by pane id. */
  sizes: Record<string, number>;
  /** The ids of the collapsed panes. */
  collapsed: string[];
}

/**
 * Props of `SplitGroup`: two or more panes in a row or a column, each sized
 * pane with its own draggable, keyboard-resizable handle on the side facing
 * the filling pane. Nest a `SplitGroup` in a pane for a grid of splits.
 */
export interface PluginSplitGroupProps extends PluginRootAttributes {
  panes: readonly PluginSplitPane[];
  /** `horizontal` (the default) puts the panes side by side; `vertical` stacks them. */
  orientation?: "horizontal" | "vertical";
  /** Remembers sizes and collapsed panes under this key (see `usePersistentViewState`). */
  persistKey?: string;
  /** The collapsed panes' ids, controlled: a toolbar toggle for an inspector. */
  collapsed?: readonly string[];
  onCollapsedChange?: (collapsed: string[]) => void;
  /** Called when a drag ends, on a key press and on a reset. */
  onLayoutChange?: (layout: PluginSplitLayout) => void;
  className?: string;
}

/**
 * Props of `Inspector`: the frame of a property panel. Its `PropertyRow`s put
 * the label beside the value while the inspector is at least 240px wide and
 * above it when narrower.
 */
export interface PluginInspectorProps extends PluginAriaRootAttributes {
  children?: ReactNode;
  /** Names the inspector as a region. */
  "aria-label"?: string;
  /** The label column's width in px, wide. Defaults to 88. */
  labelWidth?: number;
  className?: string;
}

/**
 * Props of `InspectorSection`: a heading row over a group of `PropertyRow`s,
 * collapsible by default. A folded section keeps its rows mounted and hidden,
 * so a half-edited field keeps its value.
 */
export interface PluginInspectorSectionProps extends PluginRootAttributes {
  /** Sentence case; drawn as a small uppercase label. */
  title: string;
  children?: ReactNode;
  /** `false` for a section that cannot fold. Defaults to `true`. */
  collapsible?: boolean;
  open?: boolean;
  /** Defaults to `true`. */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** A control or two at the end of the heading row (an add or reset button). */
  actions?: ReactNode;
  className?: string;
}

/**
 * Props of `PropertyRow`: a label beside its value in a 28px row. A kit
 * control in `children` is labelled by the row, as in a `FormField`.
 */
export interface PluginPropertyRowProps extends PluginRootAttributes {
  label: string;
  /** The control, or read-only text. */
  children?: ReactNode;
  /** A control id to label, when the row cannot find its control. */
  htmlFor?: string;
  /** A quiet note after the label (a unit, "Inherited"); never part of its name. */
  hint?: ReactNode;
  /** `start` pins the label to the first line of a tall control. Defaults to `center`. */
  align?: "center" | "start";
  className?: string;
}

/**
 * Props of `Drawer`: a panel that slides in from an edge of its own pane,
 * over the content (`overlay`) or beside it (`push`). Wrap the pane's content
 * in it; `Sheet` is the window-edge equivalent.
 */
export interface PluginDrawerProps extends PluginRootAttributes {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The pane's own content, which the drawer slides over or beside. */
  children?: ReactNode;
  /** The drawer's body. */
  panel: ReactNode;
  /** The drawer's heading. With it the drawer draws a header row with a close button. */
  title?: ReactNode;
  /** Names the drawer when there is no string `title`. */
  "aria-label"?: string;
  /** Controls at the end of the header row, before the close button. */
  actions?: ReactNode;
  /** A strip along the drawer's bottom (Apply, Reset). */
  footer?: ReactNode;
  /** Defaults to `right`. */
  side?: "left" | "right" | "top" | "bottom";
  /** `overlay` (the default) floats over the content; `push` narrows it. */
  mode?: "overlay" | "push";
  /**
   * An overlay drawer that holds focus until closed, over a scrim that closes
   * it. Defaults to `true` for `overlay`; a `push` drawer is never modal.
   */
  modal?: boolean;
  /** Width (or height, top and bottom) in px. Defaults to 320; never more than 90% of the pane. */
  size?: number;
  /** The drawer panel's id, for a `DrawerToggle`'s `controls`. Generated when omitted. */
  panelId?: string;
  className?: string;
}

/** Props of `DrawerToggle`: the toolbar button that opens and closes a `Drawer`. */
export interface PluginDrawerToggleProps extends PluginRootAttributes {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Required: the drawer it opens ("Filters"). The name holds still; the state is `aria-expanded`. */
  label: string;
  /** The `Drawer`'s `panelId`. */
  controls?: string;
  /** Defaults to a panel glyph facing `side`. */
  icon?: PluginIconSource;
  /** Where the drawer sits, for the default glyph. Defaults to `right`. */
  side?: "left" | "right" | "top" | "bottom";
  /** Draws the label beside the icon. */
  showLabel?: boolean;
  /** A count of what the drawer has in effect (active filters), as a quiet badge. */
  badge?: number;
  disabled?: boolean;
  className?: string;
}

/** One action of a `BulkActionBar`. */
export interface PluginBulkAction {
  /** Non-empty and unique within the bar. */
  id: string;
  label: string;
  icon?: PluginIconSource;
  onSelect?: () => void;
  disabled?: boolean;
  /** A destructive menu row once it has folded. */
  destructive?: boolean;
  /** Higher stays in the bar longer. Defaults to 0. */
  priority?: number;
}

/**
 * Props of `BulkActionBar`: "3 issues selected", the actions that apply to
 * them and a clear button, in the band along a list's bottom. It renders
 * nothing while the count is 0. Actions that do not fit fold into a menu.
 */
export interface PluginBulkActionBarProps extends PluginRootAttributes {
  /** How many are selected. Or pass `selection`. */
  count?: number;
  /** A `useSelection` result: its `count` and `clear` drive the bar. */
  selection?: { count: number; clear: () => void };
  /** What is selected: `"issue"`, or `{ one: "pull request", other: "pull requests" }`. */
  noun?: string | { one: string; other: string };
  /** How many selected rows the list is not showing (filtered or not loaded). */
  hiddenCount?: number;
  actions?: readonly PluginBulkAction[];
  /** Clears the selection. Defaults to `selection.clear`. */
  onClear?: () => void;
  /** Names the bar. Defaults to "Bulk actions". */
  "aria-label"?: string;
  className?: string;
}

/**
 * Props of `LoadMoreFooter`: the end of a paged list. A Load more button, a
 * loading row, "All 212 loaded", or the error with Retry.
 */
export interface PluginLoadMoreFooterProps extends PluginRootAttributes {
  status: "idle" | "loading" | "error" | "done";
  onLoadMore?: () => void;
  /** Rows loaded so far, for "50 of 212". */
  loadedCount?: number;
  /** Rows there are in all, when known. */
  totalCount?: number;
  /** What the rows are: `"issue"`, or `{ one, other }`. Defaults to "item". */
  noun?: string | { one: string; other: string };
  /** What went wrong, with `status: "error"`. Defaults to "Couldn't load more". */
  error?: ReactNode;
  /** Loads the next page when the footer scrolls into view while `idle`. Never retries an error. */
  autoLoad?: boolean;
  /** The button's label. Defaults to "Load more". */
  label?: string;
  className?: string;
}

/** A `TaskList` job's state. */
export type PluginTaskStatus = "pending" | "running" | "done" | "failed" | "cancelled";

/** One job of a `TaskList`. */
export interface PluginTask {
  /** Non-empty and unique within the list. */
  id: string;
  title: string;
  status: PluginTaskStatus;
  /** 0 to 1 while running: a thin bar under the title. Omitted or `null`, the spinner alone. */
  progress?: number | null;
  /** A quiet line under the title ("12 of 40 issues", the failure's cause). */
  detail?: ReactNode;
  /** Epoch ms, an ISO string or a `Date`: when the job started. */
  startedAt?: number | string | Date;
  /** When it finished; with `startedAt`, the duration a settled job shows. */
  finishedAt?: number | string | Date;
  /** Offers Retry on a failed or cancelled job. Defaults to `true` when `onRetry` is set. */
  retryable?: boolean;
  /** Offers Cancel on a pending or running job. Defaults to `true` when `onCancel` is set. */
  cancellable?: boolean;
}

/**
 * Props of `TaskList`: a queue of jobs, each with its state, progress,
 * duration and Retry or Cancel, under a summary ("2 running · 1 failed").
 */
export interface PluginTaskListProps extends PluginRootAttributes {
  tasks: readonly PluginTask[];
  /** Required: names the list ("Sync jobs"). */
  "aria-label": string;
  /** A heading drawn before the summary. */
  title?: ReactNode;
  /** The summary line of counts. Defaults to `true`. */
  summary?: boolean;
  /** Controls at the end of the summary row ("Clear finished"). */
  actions?: ReactNode;
  onRetry?: (task: PluginTask) => void;
  onCancel?: (task: PluginTask) => void;
  /** Shown when there are no tasks. */
  empty?: ReactNode;
  className?: string;
}

/**
 * Props of `RefreshOverlay`: content that is still valid while a fresh copy
 * loads. A thin bar along the top and an "Updating…" note, drawn after 400ms
 * so a quick refresh shows nothing; the content never moves or blocks.
 */
export interface PluginRefreshOverlayProps extends PluginRootAttributes {
  refreshing: boolean;
  children?: ReactNode;
  /** The note's words. Defaults to "Updating…". */
  label?: string;
  className?: string;
}

/**
 * Props of `StaleIndicator`: when the data was last updated, whether that is
 * now old or the source is disconnected, and a refresh button.
 */
export interface PluginStaleIndicatorProps extends PluginRootAttributes {
  /** Epoch ms, an ISO string or a `Date`. Omitted reads "Not updated yet". */
  updatedAt?: number | string | Date | null;
  /** Older than this many ms (positive) reads as stale. Omit to never go stale on age alone. */
  staleAfterMs?: number;
  /** Stale whatever the age. */
  stale?: boolean;
  /** The source is unreachable: the strongest state, with the last update after it. */
  disconnected?: boolean;
  /** A refresh is in flight: the button spins and is disabled. */
  refreshing?: boolean;
  onRefresh?: () => void;
  /** The refresh button's name. Defaults to "Refresh". */
  refreshLabel?: string;
  /** More about the data's age, in a tooltip on the reading ("Prices fetched 30 Sep 14:02; 2 kept from cache"). */
  detail?: string;
  /** What a stale reading tints: `glyph` (the default) the clock only, `text` the words too. */
  staleTint?: "glyph" | "text";
  /** Announced politely each time it changes: say how a refresh went ("Prices updated", "2 prices kept from cache"). */
  announce?: string;
  className?: string;
}
