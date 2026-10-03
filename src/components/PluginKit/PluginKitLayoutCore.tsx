import {
  Fragment,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { Ellipsis } from "lucide-react";
import type {
  PluginAutoGridProps,
  PluginClusterProps,
  PluginGridProps,
  PluginIconSource,
  PluginInlineProps,
  PluginLayoutAlign,
  PluginLayoutGap,
  PluginLayoutJustify,
  PluginOverflowToolbarProps,
  PluginPaneLayoutProps,
  PluginScrollAreaProps,
  PluginStackProps,
  PluginStatusBarProps,
} from "@shared/types/plugin-sdk-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  PANE_STATUS_FOOTER_CLASS,
  PANE_TOOLBAR_ICON_BUTTON_CLASS,
  PANE_TOOLBAR_ICON_CLASS,
  PANE_TOOLBAR_TEXT_BUTTON_CLASS,
} from "@/components/ui/paneToolbarStyles";
import { FILE_METADATA_STRIP_CLASS } from "@/components/FileViewer/fileMetadataStrip";
import { ScrollShadow, ScrollShadowOverlay } from "@/components/ui/ScrollShadow";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToolbarRoving } from "@/hooks/useToolbarRoving";
import { cn } from "@/lib/utils";
import { renderIconSource } from "./PluginKitIcons";
import { pluginKitPatterns, sizedIcon } from "./PluginKitPatterns";
import { useKitOverlayZClass } from "./kitScope";
import {
  field,
  hasContent,
  node,
  nonEmpty,
  oneOf,
  pickDomProps,
  pickRootProps,
  positive,
  str,
  useKitOwnerAttributes,
} from "./kitProps";

const GAPS = ["none", "xs", "sm", "md", "lg", "xl"] as const;

// The steps Daintree's panes space with: 4px between a glyph and its word, 8px
// between controls, 12px (a pane's inset) between blocks, 16 and 24 between
// sections. Full literals so Tailwind sees every class.
const GAP_CLASS: Record<PluginLayoutGap, string> = {
  none: "gap-0",
  xs: "gap-1",
  sm: "gap-2",
  md: "gap-3",
  lg: "gap-4",
  xl: "gap-6",
};

// The same steps in px, for grid track arithmetic that has to know the gap.
const GAP_PX: Record<PluginLayoutGap, number> = { none: 0, xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };

const PADDING_CLASS: Record<PluginLayoutGap, string> = {
  none: "",
  xs: "p-1",
  sm: "p-2",
  md: "p-3",
  lg: "p-4",
  xl: "p-6",
};

const ALIGNS = ["start", "center", "end", "stretch", "baseline"] as const;
const ALIGN_CLASS: Record<PluginLayoutAlign, string> = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  stretch: "items-stretch",
  baseline: "items-baseline",
};

const JUSTIFIES = ["start", "center", "end", "between", "around", "evenly"] as const;
const JUSTIFY_CLASS: Record<PluginLayoutJustify, string> = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  between: "justify-between",
  around: "justify-around",
  evenly: "justify-evenly",
};

const ELEMENTS = [
  "div",
  "section",
  "article",
  "aside",
  "header",
  "footer",
  "nav",
  "main",
  "form",
  "fieldset",
  "ul",
  "ol",
  "li",
  "span",
] as const;

function gapOf(value: unknown, fallback: PluginLayoutGap): PluginLayoutGap {
  return oneOf(value, GAPS) ?? fallback;
}

interface LayoutBoxProps {
  as: unknown;
  rest: object;
  className: string;
  style?: CSSProperties;
  children: unknown;
}

// Lists keep their markers off: a layout `ul` is a list for the reader, not a
// bulleted block.
function LayoutBox({ as, rest, className, style, children }: LayoutBoxProps) {
  const Tag = oneOf(as, ELEMENTS) ?? "div";
  const dom = pickDomProps(rest);
  // The component's own track list wins over a plugin `style` for the same property.
  const own = typeof dom.style === "object" && dom.style !== null ? dom.style : {};
  const props: Record<string, unknown> = style ? { ...dom, style: { ...own, ...style } } : dom;
  return (
    <Tag
      {...props}
      className={cn((Tag === "ul" || Tag === "ol") && "m-0 list-none p-0", className)}
    >
      {node(children)}
    </Tag>
  );
}

function KitStack({ children, gap, align, justify, as, className, ...rest }: PluginStackProps) {
  return (
    <LayoutBox
      as={as}
      rest={rest}
      className={cn(
        "flex min-w-0 flex-col",
        GAP_CLASS[gapOf(gap, "md")],
        ALIGN_CLASS[oneOf(align, ALIGNS) ?? "stretch"],
        JUSTIFY_CLASS[oneOf(justify, JUSTIFIES) ?? "start"],
        str(className)
      )}
    >
      {children}
    </LayoutBox>
  );
}

function KitInline({
  children,
  gap,
  align,
  justify,
  wrap,
  as,
  className,
  ...rest
}: PluginInlineProps) {
  return (
    <LayoutBox
      as={as}
      rest={rest}
      className={cn(
        "flex min-w-0 flex-row",
        wrap === true ? "flex-wrap" : "flex-nowrap",
        GAP_CLASS[gapOf(gap, "sm")],
        ALIGN_CLASS[oneOf(align, ALIGNS) ?? "center"],
        JUSTIFY_CLASS[oneOf(justify, JUSTIFIES) ?? "start"],
        str(className)
      )}
    >
      {children}
    </LayoutBox>
  );
}

function KitCluster({ children, gap, align, justify, as, className, ...rest }: PluginClusterProps) {
  return (
    <LayoutBox
      as={as}
      rest={rest}
      className={cn(
        "flex min-w-0 flex-row flex-wrap",
        GAP_CLASS[gapOf(gap, "sm")],
        ALIGN_CLASS[oneOf(align, ALIGNS) ?? "center"],
        JUSTIFY_CLASS[oneOf(justify, JUSTIFIES) ?? "start"],
        str(className)
      )}
    >
      {children}
    </LayoutBox>
  );
}

const MAX_GRID_COLUMNS = 12;

/** A `grid-template-columns` value from untyped input. Exported for tests. */
export function gridColumnsTemplate(columns: unknown): string | undefined {
  if (typeof columns === "number") {
    if (!Number.isInteger(columns) || columns < 1 || columns > MAX_GRID_COLUMNS) return undefined;
    return `repeat(${columns}, minmax(0, 1fr))`;
  }
  // A template is plugin text going into one style property: it can break the
  // grid, never more. Braces and semicolons are out so it stays one value.
  const template = nonEmpty(columns)?.trim();
  return template && !/[;{}]/.test(template) ? template : undefined;
}

function KitGrid({ children, gap, columns, align, as, className, ...rest }: PluginGridProps) {
  return (
    <LayoutBox
      as={as}
      rest={rest}
      style={{ gridTemplateColumns: gridColumnsTemplate(columns) ?? "minmax(0, 1fr)" }}
      className={cn(
        "grid min-w-0",
        GAP_CLASS[gapOf(gap, "md")],
        ALIGN_CLASS[oneOf(align, ALIGNS) ?? "stretch"],
        str(className)
      )}
    >
      {children}
    </LayoutBox>
  );
}

const AUTO_GRID_DEFAULT_MIN_PX = 180;
const AUTO_GRID_LIMIT_PX = 4096;

/**
 * The track list of an `AutoGrid`. `auto-fill`/`auto-fit` size against the
 * grid's own content box, so the reflow answers to the pane, never the window,
 * with no query and no script. `min(100%, …)` keeps one column from
 * overflowing a pane narrower than the minimum; `maxColumns` raises each
 * track's floor to the share of the width that many columns would get, so no
 * more than that many fit. Exported for tests.
 */
export function autoGridTemplate(
  minColumnWidth: unknown,
  maxColumns: unknown,
  stretch: boolean,
  gapPx: number
): string {
  const min = positive(minColumnWidth, AUTO_GRID_LIMIT_PX) ?? AUTO_GRID_DEFAULT_MIN_PX;
  const max =
    typeof maxColumns === "number" && Number.isInteger(maxColumns) && maxColumns >= 1
      ? Math.min(maxColumns, MAX_GRID_COLUMNS)
      : undefined;
  const floor =
    max === undefined
      ? `min(100%, ${min}px)`
      : `max(min(100%, ${min}px), calc((100% - ${(max - 1) * gapPx}px) / ${max}))`;
  return `repeat(${stretch ? "auto-fit" : "auto-fill"}, minmax(${floor}, 1fr))`;
}

function KitAutoGrid({
  children,
  gap,
  minColumnWidth,
  maxColumns,
  stretch,
  align,
  as,
  className,
  ...rest
}: PluginAutoGridProps) {
  const step = gapOf(gap, "md");
  return (
    <LayoutBox
      as={as}
      rest={rest}
      style={{
        gridTemplateColumns: autoGridTemplate(
          minColumnWidth,
          maxColumns,
          stretch === true,
          GAP_PX[step]
        ),
      }}
      className={cn(
        "grid min-w-0",
        GAP_CLASS[step],
        ALIGN_CLASS[oneOf(align, ALIGNS) ?? "stretch"],
        str(className)
      )}
    >
      {children}
    </LayoutBox>
  );
}

/**
 * Attaches `value` to a plugin ref and returns how to detach it: a callback
 * ref's own cleanup when it returns one (React 19), else a call with null. An
 * object is only a ref when it has `current`, and is written with
 * `Reflect.set`, so a frozen or malformed one is ignored rather than thrown on.
 */
function attachRef(ref: unknown, value: HTMLDivElement): () => void {
  if (typeof ref === "function") {
    const cleanup: unknown = Reflect.apply(ref, undefined, [value]);
    return typeof cleanup === "function"
      ? () => void Reflect.apply(cleanup, undefined, [])
      : () => void Reflect.apply(ref, undefined, [null]);
  }
  if (typeof ref === "object" && ref !== null && !Array.isArray(ref) && "current" in ref) {
    Reflect.set(ref, "current", value);
    return () => void Reflect.set(ref, "current", null);
  }
  return () => {};
}

// The shell answers to the host's own pane frame: chrome rows keep the heights
// their components give them (the 32px PaneHeader, the toolbar strip, the
// status strip) and never shrink, and the body between them is the one
// element that scrolls. `min-h-0` down the column is what lets it.
function KitPaneLayout({
  header,
  toolbar,
  children,
  footer,
  statusBar,
  scroll,
  padding,
  bodyClassName,
  bodyRef,
  bodyLabel,
  className,
  ...rest
}: PluginPaneLayoutProps) {
  const mode = oneOf(scroll, ["shadow", "plain", "none"] as const) ?? "shadow";
  const inset = PADDING_CLASS[gapOf(padding, "none")];
  const label = nonEmpty(bodyLabel);
  const region = label ? { role: "region", "aria-label": label } : {};
  const release = useRef<(() => void) | null>(null);
  // Read only when React attaches or detaches the body, never in render. The
  // shadow scroller detaches with null rather than calling a cleanup, so the
  // release is kept for that moment.
  const ref = (el: HTMLDivElement | null) => {
    release.current?.();
    release.current = el ? attachRef(bodyRef, el) : null;
  };
  const chrome = (slot: unknown, name: string) =>
    hasContent(slot) ? (
      <div data-pane-layout-slot={name} className="flex min-w-0 shrink-0 flex-col">
        {node(slot)}
      </div>
    ) : null;

  let body: ReactNode;
  if (mode === "shadow") {
    body = (
      <ScrollShadow
        {...region}
        ref={ref}
        data-pane-layout-slot="body"
        className="min-h-0 min-w-0 flex-1"
        scrollClassName={cn("min-w-0", inset, str(bodyClassName))}
      >
        {node(children)}
      </ScrollShadow>
    );
  } else {
    body = (
      <div
        {...region}
        ref={ref}
        data-pane-layout-slot="body"
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col",
          mode === "plain" ? "overflow-y-auto" : "overflow-hidden",
          inset,
          str(bodyClassName)
        )}
      >
        {node(children)}
      </div>
    );
  }

  return (
    <div
      {...pickRootProps(rest)}
      data-pane-layout=""
      className={cn(
        "flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden",
        str(className)
      )}
    >
      {chrome(header, "header")}
      {chrome(toolbar, "toolbar")}
      {body}
      {chrome(footer, "footer")}
      {chrome(statusBar, "status")}
    </div>
  );
}

/** A dimmed dot between two facts. Hidden from AT, which reads the facts. */
function StatusDot() {
  return (
    <span aria-hidden="true" className="text-text-muted">
      ·
    </span>
  );
}

/** The facts a slot draws: text, numbers and elements, nested arrays flattened, empties dropped. */
function statusFacts(value: unknown): unknown[] {
  const out: unknown[] = [];
  const visit = (entry: unknown) => {
    if (Array.isArray(entry)) entry.forEach(visit);
    else if (
      (typeof entry === "string" && entry !== "") ||
      (typeof entry === "number" && Number.isFinite(entry)) ||
      isValidElement(entry)
    ) {
      out.push(entry);
    }
  };
  visit(value);
  return out;
}

// A yielding side gives up width from its end, as the file pane's metadata
// run does: the earlier facts keep their words and the last text ellipsizes,
// rather than every fact shrinking to a stub at once. An element (a Button, a
// Tooltip target) keeps its size, so a focus ring is never clipped.
function statusSlot(facts: unknown[], yields: boolean): ReactNode {
  let lastText = -1;
  facts.forEach((fact, index) => {
    if (typeof fact === "string" || typeof fact === "number") lastText = index;
  });
  return facts.map((fact, index) => (
    <Fragment key={index}>
      {index > 0 ? <StatusDot /> : null}
      {typeof fact === "string" || typeof fact === "number" ? (
        <span className={yields && index === lastText ? "min-w-0 truncate" : "shrink-0"}>
          {fact}
        </span>
      ) : (
        node(fact)
      )}
    </Fragment>
  ));
}

// Two geometries the host already draws: the pane's bottom status strip
// (PANE_STATUS_FOOTER_CLASS: 24px, 11px text) and the file pane's metadata
// strip (FILE_METADATA_STRIP_CLASS: 28px, 12px text, fits an `xs` button). The
// hairline goes on the side that faces the content.
function KitStatusBar({
  left,
  center,
  right,
  density,
  placement,
  className,
  ...rest
}: PluginStatusBarProps) {
  const comfortable = oneOf(density, ["compact", "comfortable"] as const) === "comfortable";
  const top = oneOf(placement, ["bottom", "top"] as const) === "top";
  const leftFacts = statusFacts(left);
  const centerFacts = statusFacts(center);
  const rightFacts = statusFacts(right);
  const hasCenter = centerFacts.length > 0;
  const frame = comfortable ? FILE_METADATA_STRIP_CLASS : PANE_STATUS_FOOTER_CLASS;
  // The compact strip's 24px floor already holds a line of its text; its
  // padding would only add height around an `xs` control, so it goes, as the
  // host drops it on strips that carry buttons.
  const pad = comfortable ? undefined : "py-0";
  // Each geometry keeps its own hairline ink; placement only picks the edge.
  const ink = comfortable ? "border-border-default" : "border-divider";
  return (
    <div
      {...pickRootProps(rest, { aria: true })}
      data-status-bar=""
      className={cn(
        frame,
        pad,
        top ? "border-t-0 border-b" : "border-b-0 border-t",
        ink,
        "min-w-0",
        str(className)
      )}
    >
      <div
        data-status-bar-slot="left"
        className={cn(
          "flex min-w-0 items-center gap-1.5 overflow-clip whitespace-nowrap [overflow-clip-margin:4px]",
          hasCenter ? "flex-1 basis-0" : "flex-1"
        )}
      >
        {statusSlot(leftFacts, true)}
      </div>
      {hasCenter ? (
        <div
          data-status-bar-slot="center"
          className="flex min-w-0 shrink items-center justify-center gap-1.5 overflow-clip whitespace-nowrap [overflow-clip-margin:4px]"
        >
          {statusSlot(centerFacts, true)}
        </div>
      ) : null}
      {rightFacts.length > 0 || hasCenter ? (
        <div
          data-status-bar-slot="right"
          className={cn(
            "flex items-center justify-end gap-2 whitespace-nowrap",
            // Balances the left side around the centre, but never below its
            // own content: the right side is the one that does not truncate.
            hasCenter ? "min-w-fit flex-1 basis-0" : "shrink-0"
          )}
        >
          {statusSlot(rightFacts, false)}
        </div>
      ) : null}
    </div>
  );
}

interface ScrollEdges {
  top: boolean;
  bottom: boolean;
  left: boolean;
  right: boolean;
}

const NO_EDGES: ScrollEdges = { top: false, bottom: false, left: false, right: false };
const EDGE_EPSILON = 1;

/** Which physical edges have more to scroll. RTL's negative scrollLeft included. Exported for tests. */
export function scrollEdgesOf(metrics: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
  rtl: boolean;
}): ScrollEdges {
  const overY = metrics.scrollHeight > metrics.clientHeight + EDGE_EPSILON;
  const overX = metrics.scrollWidth > metrics.clientWidth + EDGE_EPSILON;
  const travelX = metrics.scrollWidth - metrics.clientWidth;
  // Distance scrolled from the inline start, whichever way the axis runs.
  const fromStart = Math.abs(metrics.scrollLeft);
  const atStart = fromStart <= EDGE_EPSILON;
  const atEnd = fromStart >= travelX - EDGE_EPSILON;
  return {
    top: overY && metrics.scrollTop > EDGE_EPSILON,
    bottom: overY && metrics.scrollTop + metrics.clientHeight < metrics.scrollHeight - EDGE_EPSILON,
    left: overX && (metrics.rtl ? !atEnd : !atStart),
    right: overX && (metrics.rtl ? !atStart : !atEnd),
  };
}

function sameEdges(a: ScrollEdges, b: ScrollEdges): boolean {
  return a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right;
}

// The two-axis sibling of useVerticalScrollShadows: re-read at most once a
// frame on scroll and on a size change of the scroller or its content.
function useScrollEdges(ref: RefObject<HTMLDivElement | null>): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>(NO_EDGES);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    let pending = false;
    const read = () => {
      pending = false;
      const next = scrollEdgesOf({
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        scrollLeft: el.scrollLeft,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        rtl: getComputedStyle(el).direction === "rtl",
      });
      setEdges((previous) => (sameEdges(previous, next) ? previous : next));
    };
    const schedule = () => {
      if (pending) return;
      pending = true;
      frame = requestAnimationFrame(read);
    };
    schedule();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(el);
    const content = el.firstElementChild;
    if (content) observer?.observe(content);
    el.addEventListener("scroll", schedule, { passive: true });
    return () => {
      if (pending) cancelAnimationFrame(frame);
      observer?.disconnect();
      el.removeEventListener("scroll", schedule);
    };
  }, [ref]);
  return edges;
}

const SCROLL_AXIS_CLASS = {
  vertical: "overflow-y-auto overflow-x-hidden",
  horizontal: "overflow-x-auto overflow-y-hidden",
  both: "overflow-auto",
} as const;

// Content sizes to itself along a scrolling axis, so a row of cards overflows
// sideways instead of squeezing, and the first child is what the observer
// watches for growth.
const SCROLL_CONTENT_CLASS = {
  vertical: "min-w-0",
  horizontal: "flex h-full w-max min-w-full",
  both: "w-max min-w-full",
} as const;

function KitScrollArea({
  children,
  orientation,
  className,
  scrollClassName,
  compact,
  ref,
  ...rest
}: PluginScrollAreaProps) {
  const axis = oneOf(orientation, ["vertical", "horizontal", "both"] as const) ?? "vertical";
  const innerRef = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(innerRef);
  // The prop is read only when React attaches the element, never in render.
  const setRef = (el: HTMLDivElement) => {
    innerRef.current = el;
    const detach = attachRef(ref, el);
    return () => {
      innerRef.current = null;
      detach();
    };
  };
  const dom = pickDomProps(rest);
  // A named scroller is a region; a generic div cannot carry a name.
  const named = nonEmpty(dom["aria-label"]) ?? nonEmpty(dom["aria-labelledby"]);
  const role = nonEmpty(dom.role) ?? (named ? "region" : undefined);
  const small = compact === true;
  const vertical = axis !== "horizontal";
  const horizontal = axis !== "vertical";
  return (
    <div
      data-scroll-area={axis}
      className={cn("relative flex min-h-0 min-w-0 flex-col overflow-hidden", str(className))}
    >
      {vertical ? <ScrollShadowOverlay edge="top" visible={edges.top} compact={small} /> : null}
      {horizontal ? <ScrollShadowOverlay edge="left" visible={edges.left} compact={small} /> : null}
      <div
        {...dom}
        role={role}
        ref={setRef}
        className={cn("min-h-0 min-w-0 flex-1", SCROLL_AXIS_CLASS[axis], str(scrollClassName))}
      >
        <div className={SCROLL_CONTENT_CLASS[axis]}>{node(children)}</div>
      </div>
      {horizontal ? (
        <ScrollShadowOverlay edge="right" visible={edges.right} compact={small} />
      ) : null}
      {vertical ? (
        <ScrollShadowOverlay edge="bottom" visible={edges.bottom} compact={small} />
      ) : null}
    </div>
  );
}

interface OverflowAction {
  kind: "action";
  id: string;
  label: string;
  icon: PluginIconSource | undefined;
  onSelect: (() => void) | undefined;
  showLabel: boolean;
  pressed: boolean | undefined;
  disabled: boolean;
  tooltip: ReactNode | false | undefined;
  shortcut: string | undefined;
  destructive: boolean;
  priority: number;
}

type OverflowEntry = OverflowAction | { kind: "separator" };

// A name the kit does not know draws nothing, so any string passes here.
function isIconSource(value: unknown): value is PluginIconSource {
  return typeof value === "string" || isValidElement(value);
}

/** An `OverflowToolbar`'s items from untyped input: bad rows and repeated ids dropped. */
export function readOverflowItems(items: unknown): OverflowEntry[] {
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  const out: OverflowEntry[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    if (field(item, "type") === "separator") {
      out.push({ kind: "separator" });
      continue;
    }
    const type = field(item, "type");
    if (type !== undefined && type !== "action") continue;
    const id = nonEmpty(field(item, "id"));
    const label = nonEmpty(field(item, "label"));
    if (id === undefined || label === undefined || seen.has(id)) continue;
    seen.add(id);
    const pressed = field(item, "pressed");
    const priority = field(item, "priority");
    const onSelect = field(item, "onSelect");
    const icon = field(item, "icon");
    const tooltip = field(item, "tooltip");
    out.push({
      kind: "action",
      id,
      label,
      icon: isIconSource(icon) ? icon : undefined,
      onSelect:
        typeof onSelect === "function"
          ? () => {
              Reflect.apply(onSelect, undefined, []);
            }
          : undefined,
      showLabel: field(item, "showLabel") === true,
      pressed: typeof pressed === "boolean" ? pressed : undefined,
      disabled: field(item, "disabled") === true,
      tooltip: tooltip === false ? false : tooltip === undefined ? undefined : node(tooltip),
      shortcut: nonEmpty(field(item, "shortcut")),
      destructive: field(item, "destructive") === true,
      priority: typeof priority === "number" && Number.isFinite(priority) ? priority : 0,
    });
  }
  return out;
}

/** What `fitOverflow` weighs: the strip's order and the measured widths. */
export interface OverflowLayout {
  /** The strip in order: an action's index into `widths`, or a separator. */
  sequence: readonly (number | "separator")[];
  widths: readonly number[];
  priorities: readonly number[];
  available: number;
  gap: number;
  moreWidth: number;
  separatorWidth: number;
}

/**
 * The width of the strip drawing `kept`: only the separators that land between
 * two drawn actions count, as `withSeparators` draws them.
 */
function rowWidth(layout: OverflowLayout, kept: ReadonlySet<number>, withMore: boolean): number {
  let width = 0;
  let parts = 0;
  let drawn = 0;
  let pendingSeparator = false;
  for (const entry of layout.sequence) {
    if (entry === "separator") {
      if (drawn > 0) pendingSeparator = true;
      continue;
    }
    if (!kept.has(entry)) continue;
    if (pendingSeparator) {
      width += layout.separatorWidth;
      parts += 1;
    }
    pendingSeparator = false;
    width += layout.widths[entry] ?? 0;
    parts += 1;
    drawn += 1;
  }
  if (withMore) {
    width += layout.moreWidth;
    parts += 1;
  }
  return width + Math.max(0, parts - 1) * layout.gap;
}

/**
 * Which actions stay in the strip: all of them when they fit, otherwise the
 * highest priorities (earlier first among equals) that fit beside the menu
 * button. One that does not fit is skipped, so a wide control never keeps a
 * narrower one behind it out of the strip. Exported for tests.
 */
export function fitOverflow(layout: OverflowLayout): Set<number> {
  const all = new Set(layout.widths.map((_, index) => index));
  if (rowWidth(layout, all, false) <= layout.available) return all;
  const order = layout.widths
    .map((_, index) => index)
    .sort((a, b) => (layout.priorities[b] ?? 0) - (layout.priorities[a] ?? 0) || a - b);
  const kept = new Set<number>();
  for (const index of order) {
    kept.add(index);
    if (rowWidth(layout, kept, true) > layout.available) kept.delete(index);
  }
  return kept;
}

/** Entries in order with separators only between two shown actions, never doubled. */
function withSeparators(entries: OverflowEntry[], shown: (action: OverflowAction) => boolean) {
  const out: OverflowEntry[] = [];
  let pendingSeparator = false;
  for (const entry of entries) {
    if (entry.kind === "separator") {
      if (out.length > 0) pendingSeparator = true;
      continue;
    }
    if (!shown(entry)) continue;
    if (pendingSeparator) out.push({ kind: "separator" });
    pendingSeparator = false;
    out.push(entry);
  }
  return out;
}

// An `hr`, as Divider draws one: the separator role without a hand-rolled one.
// The pane divider ink, not the app toolbar's `.toolbar-divider`, whose theme
// value is tuned for that bar's own surface and all but vanishes on a pane.
// Forced-colors resets a background to Canvas, so there it paints CanvasText,
// as `.toolbar-divider` does, rather than letting the groups run together.
const OVERFLOW_SEPARATOR_CLASS =
  "mx-1 my-0 h-4 w-px shrink-0 border-0 bg-border-divider forced-colors:bg-[CanvasText]";
// Its 1px line and the 4px margin either side.
const OVERFLOW_SEPARATOR_PX = 9;

type PendingFocus = { kind: "more" } | { kind: "action"; id: string };

// The strip draws every action twice: the live row, and an invisible copy of
// each as a plain span with the button's own classes, which is what gets
// measured. Spans, so the roving hook (which only sees buttons) never counts
// them and the reader never hears them.
function KitOverflowToolbar({
  items,
  "aria-label": ariaLabel,
  variant,
  leading,
  trailing,
  overflowLabel,
  className,
  ...rest
}: PluginOverflowToolbarProps) {
  const entries = readOverflowItems(items);
  const rootRef = useRef<HTMLDivElement>(null);
  const regionRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const foldedRef = useRef<ReadonlySet<string>>(new Set());
  const pendingFocus = useRef<PendingFocus | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const skipCloseFocus = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const onKeyDown = useToolbarRoving(rootRef);
  const overlayZ = useKitOverlayZClass();
  const owner = useKitOwnerAttributes();
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const bar = oneOf(variant, ["inline", "bar"] as const) === "bar";
  const moreName = nonEmpty(overflowLabel) ?? "More actions";
  // Everything that changes what the strip needs; the ruler's own resize
  // catches the rest (a font, an icon element's size).
  const signature = entries
    .map((entry) =>
      entry.kind === "separator"
        ? "|"
        : [
            entry.id,
            entry.label,
            entry.showLabel,
            entry.priority,
            typeof entry.icon === "string" ? entry.icon : entry.icon ? "element" : "",
          ].join("\u0000")
    )
    .join("\u0001");

  const measure = useCallback(() => {
    const region = regionRef.current;
    const ruler = measureRef.current;
    if (!region || !ruler) return;
    const available = region.clientWidth;
    // Hidden or not laid out yet: keep the last answer rather than folding
    // everything on a reveal.
    if (available <= 0) return;
    const cells = [
      ...ruler.querySelectorAll<HTMLElement>("[data-measure-id], [data-measure-separator]"),
    ];
    const actionCells = cells.filter((cell) => cell.dataset.measureId !== undefined);
    const ids = actionCells.map((cell) => cell.dataset.measureId ?? "");
    const sequence = cells.map((cell) =>
      cell.dataset.measureId === undefined ? ("separator" as const) : actionCells.indexOf(cell)
    );
    const more = ruler.querySelector<HTMLElement>("[data-measure-more]");
    const kept = fitOverflow({
      sequence,
      widths: actionCells.map((cell) => cell.getBoundingClientRect().width),
      priorities: actionCells.map((cell) => Number(cell.dataset.measurePriority ?? "0")),
      available,
      gap: parseFloat(getComputedStyle(region).columnGap) || 0,
      moreWidth: more ? more.getBoundingClientRect().width : 0,
      separatorWidth: OVERFLOW_SEPARATOR_PX,
    });
    const nextFolded = new Set(ids.filter((_, index) => !kept.has(index)));
    const previous = foldedRef.current;
    if (previous.size === nextFolded.size && [...previous].every((id) => nextFolded.has(id))) {
      return;
    }
    // A focused control that folds, or a focused menu button that goes away
    // because everything fits again, would drop focus to the page: hand it
    // to where that control now lives.
    const active = document.activeElement;
    const inMenu = active instanceof HTMLElement && menuRef.current?.contains(active) === true;
    if (inMenu) {
      // Focus is in the open menu. When the row it sits on (or the whole
      // menu) returns to the strip, the menu closes and focus follows the
      // control there instead of falling to the page with the unmounted row.
      const menuId = active.closest<HTMLElement>("[data-overflow-menu-id]")?.dataset.overflowMenuId;
      const back =
        menuId !== undefined && !nextFolded.has(menuId)
          ? menuId
          : nextFolded.size === 0
            ? ids.find((id) => previous.has(id))
            : undefined;
      if (back !== undefined) {
        pendingFocus.current = { kind: "action", id: back };
        skipCloseFocus.current = true;
        setMenuOpen(false);
      }
    } else if (active instanceof HTMLElement && region.contains(active)) {
      const focusedId = active.dataset.overflowId;
      if (focusedId !== undefined && nextFolded.has(focusedId)) {
        pendingFocus.current = { kind: "more" };
      } else if (active.dataset.overflowMore !== undefined && nextFolded.size === 0) {
        const first = ids.find((id) => previous.has(id));
        if (first !== undefined) pendingFocus.current = { kind: "action", id: first };
      }
    }
    foldedRef.current = nextFolded;
    setFolded(nextFolded);
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [measure, signature]);

  useEffect(() => {
    const region = regionRef.current;
    if (!region || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    let pending = false;
    const observer = new ResizeObserver(() => {
      if (pending) return;
      pending = true;
      frame = requestAnimationFrame(() => {
        pending = false;
        measure();
      });
    });
    observer.observe(region);
    if (measureRef.current) observer.observe(measureRef.current);
    return () => {
      if (pending) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [measure]);

  // Every commit: the handoff waits for the commit that mounts its target,
  // which can be a later one than the commit that decided it.
  useLayoutEffect(() => {
    const want = pendingFocus.current;
    if (!want) return;
    const target =
      want.kind === "more"
        ? moreRef.current
        : [...(regionRef.current?.querySelectorAll<HTMLElement>("[data-overflow-id]") ?? [])].find(
            (button) => button.dataset.overflowId === want.id
          );
    if (target) {
      pendingFocus.current = null;
      target.focus();
    } else if (
      want.kind === "more" ? foldedRef.current.size === 0 : foldedRef.current.has(want.id)
    ) {
      // The latest fold no longer has the target: the strip moved on.
      pendingFocus.current = null;
    }
  });

  const shown = withSeparators(entries, (action) => !folded.has(action.id));
  const hidden = withSeparators(entries, (action) => folded.has(action.id));
  const ToolbarButton = pluginKitPatterns.ToolbarButton;

  return (
    <div
      {...pickRootProps(rest, { aria: true })}
      ref={rootRef}
      role="toolbar"
      aria-label={str(ariaLabel) ?? ""}
      onKeyDown={onKeyDown}
      data-overflow-toolbar=""
      className={cn(
        "relative flex min-w-0 items-center",
        bar
          ? // The same strip as Toolbar's `bar`: FileViewerToolbar's row.
            "shrink-0 gap-1.5 border-b border-overlay bg-surface px-2 py-1.5"
          : "gap-0.5",
        str(className)
      )}
    >
      {hasContent(leading) ? (
        <div className="flex min-w-0 shrink-0 items-center gap-1.5">{node(leading)}</div>
      ) : null}
      <div
        ref={regionRef}
        data-overflow-region=""
        className={cn(
          "toolbar-measured-row flex min-w-0 flex-1 items-center",
          bar ? "gap-1.5" : "gap-0.5"
        )}
      >
        {shown.map((entry, index) =>
          entry.kind === "separator" ? (
            <hr
              key={`separator-${index}`}
              aria-orientation="vertical"
              className={OVERFLOW_SEPARATOR_CLASS}
            />
          ) : (
            <ToolbarButton
              key={entry.id}
              data-overflow-id={entry.id}
              icon={entry.icon}
              label={entry.showLabel ? entry.label : undefined}
              aria-label={entry.label}
              pressed={entry.pressed}
              disabled={entry.disabled}
              tooltip={entry.tooltip}
              onClick={entry.onSelect}
            />
          )
        )}
        {hidden.length > 0 ? (
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button
                    ref={moreRef}
                    type="button"
                    aria-label={moreName}
                    data-overflow-more=""
                    className={PANE_TOOLBAR_ICON_BUTTON_CLASS}
                  >
                    <Ellipsis className={PANE_TOOLBAR_ICON_CLASS} aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom" className={overlayZ}>
                {moreName}
              </TooltipContent>
            </Tooltip>
            <DropdownMenuContent
              {...owner}
              ref={menuRef}
              onCloseAutoFocus={(event) => {
                // A handoff closed the menu and already put focus on the
                // control; Radix would restore to the trigger after the exit
                // animation and pull it back.
                if (!skipCloseFocus.current) return;
                skipCloseFocus.current = false;
                event.preventDefault();
              }}
              align="end"
              aria-label={moreName}
              className={cn("min-w-[200px]", overlayZ)}
            >
              {hidden.map((entry, index) => {
                if (entry.kind === "separator") {
                  return <DropdownMenuSeparator key={`separator-${index}`} />;
                }
                const icon = renderIconSource(entry.icon, "h-3.5 w-3.5");
                const glyph = icon ? (
                  <span data-menu-icon="" aria-hidden="true" className="mr-2 inline-flex shrink-0">
                    {icon}
                  </span>
                ) : null;
                if (entry.pressed !== undefined) {
                  return (
                    <DropdownMenuCheckboxItem
                      key={entry.id}
                      data-overflow-menu-id={entry.id}
                      checked={entry.pressed}
                      disabled={entry.disabled}
                      onCheckedChange={() => entry.onSelect?.()}
                    >
                      {entry.label}
                      <DropdownMenuShortcut shortcut={entry.shortcut} />
                    </DropdownMenuCheckboxItem>
                  );
                }
                return (
                  <DropdownMenuItem
                    key={entry.id}
                    data-overflow-menu-id={entry.id}
                    disabled={entry.disabled}
                    destructive={entry.destructive}
                    onSelect={() => entry.onSelect?.()}
                  >
                    {glyph}
                    {entry.label}
                    <DropdownMenuShortcut shortcut={entry.shortcut} />
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {hasContent(trailing) ? (
        <div className="flex min-w-0 shrink-0 items-center gap-1.5">{node(trailing)}</div>
      ) : null}
      <div
        ref={measureRef}
        aria-hidden="true"
        data-overflow-measure=""
        className="pointer-events-none invisible absolute left-0 top-0 flex h-0 items-center overflow-hidden whitespace-nowrap"
      >
        {entries.map((entry, index) =>
          entry.kind === "separator" ? (
            <span key={`separator-${index}`} data-measure-separator="" />
          ) : (
            <span
              key={entry.id}
              data-measure-id={entry.id}
              data-measure-priority={entry.priority}
              className={
                entry.showLabel ? PANE_TOOLBAR_TEXT_BUTTON_CLASS : PANE_TOOLBAR_ICON_BUTTON_CLASS
              }
            >
              {sizedIcon(entry.icon, PANE_TOOLBAR_ICON_CLASS)}
              {entry.showLabel ? entry.label : null}
            </span>
          )
        )}
        <span data-measure-more="" className={PANE_TOOLBAR_ICON_BUTTON_CLASS}>
          <Ellipsis className={PANE_TOOLBAR_ICON_CLASS} aria-hidden="true" />
        </span>
      </div>
    </div>
  );
}

export const pluginKitLayoutCore = {
  Stack: KitStack,
  Inline: KitInline,
  Cluster: KitCluster,
  Grid: KitGrid,
  AutoGrid: KitAutoGrid,
  PaneLayout: KitPaneLayout,
  StatusBar: KitStatusBar,
  ScrollArea: KitScrollArea,
  OverflowToolbar: KitOverflowToolbar,
};
