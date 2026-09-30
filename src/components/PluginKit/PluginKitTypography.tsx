import {
  cloneElement,
  Fragment,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Circle } from "lucide-react";
import type {
  PluginAnnounceOptions,
  PluginCodeBlockProps,
  PluginColoredLabelProps,
  PluginCountIndicatorProps,
  PluginHeadingProps,
  PluginIndicatorPlacement,
  PluginInlineCodeProps,
  PluginLinkProps,
  PluginLiveRegionProps,
  PluginPathLabelProps,
  PluginPortalProps,
  PluginStateGlyphProps,
  PluginStatusDotProps,
  PluginStatusState,
  PluginTextProps,
  PluginUnreadDotProps,
  PluginVisuallyHiddenProps,
} from "@shared/types/plugin-sdk-react";
import { Badge, COUNT_BADGE_CLASS } from "@/components/ui/badge";
import { CopyButton } from "@/components/ui/CopyButton";
import { PathSegments } from "@/components/ui/PathSegments";
import { PathTail } from "@/components/ui/PathTail";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { ExitedCircle, HollowCircle, SpinnerCircle } from "@/components/icons";
import { activateMarkdownLink, HTTPish } from "@/components/Markdown/markdownLinkPolicy";
import { resolvePluginMarkdownPaths } from "@/components/Markdown/pluginMarkdownPaths";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { cn } from "@/lib/utils";
import { useDaintreeTheme } from "@/pluginUi/theme";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { labelColors, parseLabelHex } from "./kitLabelColor";
import {
  node,
  nonEmpty,
  oneOf,
  pickDomProps,
  pickRootProps,
  PluginStyleScope,
  positive,
  str,
} from "./kitProps";
import { useKitOverlayZClass } from "./kitScope";

// The type ramp, inline elements and small status primitives. Each maps the
// app's own vocabulary (text roles, the activity dot, the count pill, the
// Markdown link policy) onto a public prop rather than drawing anything new.

const TEXT_SIZE = {
  "3xs": "text-3xs",
  "2xs": "text-2xs",
  xs: "text-xs",
  sm: "text-sm",
  base: "text-base",
  lg: "text-lg",
  inherit: undefined,
} as const;
const TEXT_SIZES = [
  "3xs",
  "2xs",
  "xs",
  "sm",
  "base",
  "lg",
  "inherit",
] as const satisfies readonly (keyof typeof TEXT_SIZE)[];

// `danger` reads the status-danger token directly: the `status-error` class is
// an alias of it, and `danger` is the kit's spelling for both.
const TEXT_TONE = {
  primary: "text-text-primary",
  secondary: "text-text-secondary",
  muted: "text-text-muted",
  danger: "text-status-danger",
  success: "text-status-success",
  warning: "text-status-warning",
  accent: "text-accent-primary",
  inherit: undefined,
} as const;
const TEXT_TONES = [
  "primary",
  "secondary",
  "muted",
  "danger",
  "success",
  "warning",
  "accent",
  "inherit",
] as const satisfies readonly (keyof typeof TEXT_TONE)[];

const WEIGHT = { normal: "font-normal", medium: "font-medium", semibold: "font-semibold" } as const;
const WEIGHTS = [
  "normal",
  "medium",
  "semibold",
] as const satisfies readonly (keyof typeof WEIGHT)[];

const TEXT_ELEMENTS = ["span", "p", "div", "strong", "em", "small"] as const;

// A truncated run needs a box to cut at; `block` rather than `inline-block` so
// it takes its container's width without a baseline gap under it.
const TRUNCATE_CLASS = "block min-w-0 truncate";

function KitText({
  children,
  size,
  tone,
  mono,
  weight,
  truncate,
  as,
  className,
  ...rest
}: PluginTextProps) {
  const Element = oneOf(as, TEXT_ELEMENTS) ?? "span";
  const accepted = oneOf(weight, WEIGHTS);
  return (
    <Element
      {...pickDomProps(rest)}
      className={cn(
        TEXT_SIZE[oneOf(size, TEXT_SIZES) ?? "sm"],
        TEXT_TONE[oneOf(tone, TEXT_TONES) ?? "primary"],
        // A `strong` or `em` keeps its own emphasis unless a weight is asked for.
        accepted && WEIGHT[accepted],
        mono === true && "font-mono",
        truncate === true && TRUNCATE_CLASS,
        str(className)
      )}
    >
      {node(children)}
    </Element>
  );
}

// The app's heading sizes, read off its own `h1`–`h4`s: a dialog or pane
// title at 18px, a page section at 16px, a group at 14px and a sub-group at
// 12px, all semibold. The largest steps tighten their tracking as the app's do.
const HEADING_SIZE = {
  1: "text-lg font-semibold tracking-tight",
  2: "text-base font-semibold",
  3: "text-sm font-semibold",
  4: "text-xs font-semibold",
} as const;
const HEADING_ELEMENTS = ["h1", "h2", "h3", "h4", "h5", "h6", "div"] as const;

function KitHeading({
  children,
  level,
  as,
  tone,
  truncate,
  className,
  ...rest
}: PluginHeadingProps) {
  const at = level === 1 || level === 2 || level === 3 || level === 4 ? level : 2;
  const Element = oneOf(as, HEADING_ELEMENTS) ?? (`h${at}` as const);
  return (
    <Element
      {...pickDomProps(rest)}
      // A `div` keeps its place in the outline.
      {...(Element === "div" ? { role: "heading", "aria-level": at } : {})}
      className={cn(
        HEADING_SIZE[at],
        tone === "secondary" ? "text-text-secondary" : "text-text-primary",
        truncate === true && TRUNCATE_CLASS,
        str(className)
      )}
    >
      {node(children)}
    </Element>
  );
}

// The link ink the app uses for inline links, underlined on hover and focus,
// with the component-owned accent ring. `rounded-xs` so the ring hugs the run.
const LINK_CLASS =
  "rounded-xs text-text-link underline-offset-2 hover:underline focus-visible:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary";

function KitLink({
  href,
  children,
  basePath,
  rootPath,
  externalIcon,
  className,
  onClick,
  onAuxClick,
  ...rest
}: PluginLinkProps) {
  const target = str(href) ?? "";
  const external = HTTPish.test(target);
  const showIcon = externalIcon === true && external && /^https?:/i.test(target);
  const ownClick = typeof onClick === "function" ? onClick : undefined;
  const ownAuxClick = typeof onAuxClick === "function" ? onAuxClick : undefined;
  const activate = (event: MouseEvent<HTMLAnchorElement>) => {
    try {
      ownClick?.(event);
    } catch (error) {
      // Even when the author's handler throws, the href must never navigate
      // the view, which would bypass the routing below.
      event.preventDefault();
      throw error;
    }
    // The author's handler took the click over.
    if (event.defaultPrevented) return;
    event.preventDefault();
    const paths = resolvePluginMarkdownPaths(basePath, rootPath);
    activateMarkdownLink(target, paths);
  };
  return (
    <a
      {...pickDomProps(rest)}
      href={target}
      onClick={activate}
      onAuxClick={(event) => {
        // First, so a throwing handler cannot leave it live: middle-click would
        // ask Chromium to open the href in a new window.
        event.preventDefault();
        ownAuxClick?.(event);
      }}
      className={cn(LINK_CLASS, str(className))}
    >
      {node(children)}
      {showIcon ? (
        <>
          <ArrowUpRight
            aria-hidden="true"
            className="ml-0.5 inline-block h-[0.85em] w-[0.85em] align-baseline"
          />
          <span className="sr-only"> (opens in browser)</span>
        </>
      ) : null}
    </a>
  );
}

// Rendered Markdown's inline code chip, in utilities: a recessed well with a
// hairline, the mono face a step smaller than the text around it. The size is
// relative to that text, which no step of the ramp can say, so it is inline.
const INLINE_CODE_STYLE = { fontSize: "0.85em" } as const;

function KitInlineCode({ children, className, ...rest }: PluginInlineCodeProps) {
  return (
    <code
      {...pickRootProps(rest)}
      style={INLINE_CODE_STYLE}
      className={cn(
        "rounded-xs border border-border-subtle bg-surface-inset px-1 py-px font-mono font-normal text-text-primary [overflow-wrap:anywhere]",
        str(className)
      )}
    >
      {node(children)}
    </code>
  );
}

type Highlighter = typeof import("./kitCodeHighlight");
let highlighterLoad: Promise<Highlighter> | null = null;

function loadHighlighter(): Promise<Highlighter> {
  highlighterLoad ??= import("./kitCodeHighlight").then(
    (module) => module,
    (error: unknown) => {
      highlighterLoad = null;
      throw error;
    }
  );
  return highlighterLoad;
}

/**
 * The highlighted lines of `code`, or null while the highlighter or the
 * grammar is loading or when there is none. Plain text shows meanwhile, the
 * same characters on the same lines, so nothing moves when colour arrives.
 */
function useHighlightedLines(code: string, language: string | undefined): ReactNode[] | null {
  // The module and the grammar it loaded live in state rather than being read
  // off the module global, so the compiler's memo sees them change: a cold
  // grammar landing re-runs the highlight instead of keeping the plain result.
  const [ready, setReady] = useState<{ module: Highlighter; language: string } | null>(null);
  useEffect(() => {
    if (!language) return;
    let cancelled = false;
    void loadHighlighter()
      .then(async (module) => {
        const canonical = module.canonicalLang(language);
        if (!module.isLanguageRegistered(canonical) && !module.isLanguageFailed(canonical)) {
          await module.ensureLanguage(canonical);
        }
        if (!cancelled) setReady({ module, language: canonical });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [language]);
  if (!language || !ready || ready.module.canonicalLang(language) !== ready.language) return null;
  return ready.module.highlightCodeLines(code, ready.language);
}

function lineSet(value: unknown): Set<number> {
  const out = new Set<number>();
  if (!Array.isArray(value)) return out;
  for (const entry of value) {
    if (typeof entry === "number" && Number.isInteger(entry) && entry >= 0) out.add(entry);
  }
  return out;
}

function KitCodeBlock({
  code,
  language,
  lineNumbers,
  highlightLines,
  startLine,
  maxHeight,
  wrap,
  copyable,
  "aria-label": ariaLabel,
  className,
  ...rest
}: PluginCodeBlockProps) {
  const text = (typeof code === "string" ? code : "").replace(/\n$/, "");
  const lang = nonEmpty(language);
  const highlighted = useHighlightedLines(text, lang);
  const plain = text.split("\n");
  const marked = lineSet(highlightLines);
  const first =
    typeof startLine === "number" && Number.isInteger(startLine) && startLine >= 0 ? startLine : 1;
  const gutterWidth = `${String(first + plain.length - 1).length + 1}ch`;
  const height = positive(maxHeight, 100_000);
  const label = nonEmpty(ariaLabel);
  const wraps = wrap === true;
  return (
    <div
      {...pickRootProps(rest)}
      role="group"
      aria-label={label ?? (lang ? `${lang} code` : "Code")}
      data-kit-code-block=""
      className={cn(
        "kit-code-block relative min-w-0 rounded-[var(--radius-lg)] border border-border-default bg-surface-inset",
        str(className)
      )}
    >
      {/* A scroller with no focusable content is a tab stop of its own in
          Chromium, so a clipped block stays reachable from the keyboard. */}
      <pre
        className="m-0 overflow-auto py-2 font-mono text-xs leading-5 text-text-primary"
        style={height === undefined ? undefined : { maxHeight: height }}
      >
        <code className={cn("block", wraps ? "w-full" : "w-max min-w-full")}>
          {plain.map((line, index) => {
            const number = first + index;
            const isMarked = marked.has(number);
            const body = highlighted?.[index] ?? line;
            return (
              <div
                key={index}
                data-line={index + 1}
                data-highlighted={isMarked ? "" : undefined}
                className={cn(
                  "flex border-l-2",
                  isMarked ? "border-text-secondary bg-overlay-selected" : "border-transparent"
                )}
              >
                {lineNumbers === true ? (
                  <span
                    aria-hidden="true"
                    className="shrink-0 select-none pr-3 pl-2.5 text-right text-text-muted tabular-nums"
                    style={{ width: `calc(${gutterWidth} + 1.375rem)` }}
                  >
                    {number}
                  </span>
                ) : null}
                <span
                  className={cn(
                    "min-w-0 flex-1 pr-3",
                    lineNumbers === true ? "pl-0" : "pl-3",
                    wraps ? "break-words whitespace-pre-wrap" : "whitespace-pre"
                  )}
                >
                  {isMarked ? <mark className="bg-transparent text-inherit">{body}</mark> : body}
                  {/* An empty line keeps its height. */}
                  {line === "" ? "​" : null}
                </span>
              </div>
            );
          })}
        </code>
      </pre>
      {copyable === false ? null : (
        <CopyButton
          text={text}
          aria-label="Copy code"
          className="absolute top-1 right-1 bg-surface-inset"
        />
      )}
    </div>
  );
}

function splitPath(path: string): { directory: string; name: string } {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  // A trailing separator names a directory: keep it whole as the "name".
  if (at === path.length - 1) return { directory: "", name: path };
  return { directory: path.slice(0, at + 1), name: path.slice(at + 1) };
}

function overflows(element: HTMLElement | null): boolean {
  return element !== null && element.scrollWidth > element.clientWidth + 0.5;
}

function KitPathLabel({ path, mono, focusable, className, ...rest }: PluginPathLabelProps) {
  const full = str(path) ?? "";
  const { directory, name } = splitPath(full);
  const rootRef = useRef<HTMLSpanElement>(null);
  const nameRef = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  const overlayZ = useKitOverlayZClass();
  // TruncatedTooltip watches one element; here either half can be the one cut.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () =>
      setCut(
        overflows(root.querySelector<HTMLElement>("[data-kit-path-directory]")) ||
          overflows(nameRef.current)
      );
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    for (const child of root.children) observer.observe(child);
    return () => observer.disconnect();
    // Typography moves the halves' widths without resizing the root.
  }, [full, mono, className]);
  return (
    <TruncatedTooltip
      content={
        <PluginStyleScope>
          <span className="font-mono">
            <PathSegments path={full} />
          </span>
        </PluginStyleScope>
      }
      contentClassName={overlayZ}
      isTruncated={cut}
      focusable={focusable !== false}
    >
      <span
        {...pickRootProps(rest)}
        ref={rootRef}
        data-kit-path-label=""
        className={cn(
          "flex min-w-0 max-w-full items-baseline",
          mono === true && "font-mono",
          str(className)
        )}
        // The directory's rtl run reorders nothing that is read, but a path
        // given as one string is the clearer name while it is cut.
        aria-label={cut ? full : undefined}
      >
        {directory ? (
          <PathTail
            data-kit-path-directory=""
            // The directory gives way first; the name only once it is all gone.
            className="min-w-0 shrink text-text-secondary"
          >
            {directory}
          </PathTail>
        ) : null}
        {/* Never shrinks, only capped at the label's width: a shrink share, even a
            fraction of a pixel, would ellipsise the name while directory remains. */}
        <span ref={nameRef} className="max-w-full min-w-0 shrink-0 truncate">
          {name}
        </span>
      </span>
    </TruncatedTooltip>
  );
}

function KitVisuallyHidden({ children, as, ...rest }: PluginVisuallyHiddenProps) {
  const Element = as === "div" ? "div" : "span";
  return (
    <Element {...pickRootProps(rest)} className="sr-only">
      {node(children)}
    </Element>
  );
}

function KitLiveRegion({
  children,
  politeness,
  atomic,
  visuallyHidden,
  className,
  ...rest
}: PluginLiveRegionProps) {
  const assertive = politeness === "assertive";
  return (
    <div
      {...pickRootProps(rest)}
      role={assertive ? "alert" : "status"}
      aria-live={assertive ? "assertive" : "polite"}
      aria-atomic={atomic !== false}
      className={cn(visuallyHidden === true && "sr-only", str(className))}
    >
      {node(children)}
    </div>
  );
}

/**
 * Speaks `message` through the host's announcer: `document.ariaNotify` where
 * Chromium has it, which reaches VoiceOver even from under a modal, else the
 * app's always-mounted live regions. The same path the kit's CopyButton uses.
 */
function announce(message: unknown, options?: PluginAnnounceOptions): void {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) return;
  const politeness =
    typeof options === "object" && options !== null && options.politeness === "assertive"
      ? "assertive"
      : "polite";
  useAnnouncerStore.getState().announce(text, politeness);
}

function KitPortal({ children, container }: PluginPortalProps) {
  const target =
    container instanceof Element
      ? container
      : typeof document === "undefined"
        ? null
        : document.body;
  if (!target) return null;
  // `contents`, so the marker adds no box: what the view positions inside it is
  // laid out against the container, as a bare createPortal child would be.
  return createPortal(
    <PluginStyleScope block className="contents">
      {node(children)}
    </PluginStyleScope>,
    target
  );
}

const STATES = ["running", "idle", "waiting", "error", "success", "neutral"] as const;

// The activity dot's inks: the agent working and waiting hues, the status
// colours, and the secondary ink for neutral. Idle is the ActivityLight's
// hollow ring, so it never rests on colour alone. Forced colours paint every
// background as Canvas, so a filled dot re-declares itself in CanvasText there.
const DOT_STATE: Record<PluginStatusState, string> = {
  running: "bg-state-working",
  waiting: "bg-state-waiting",
  error: "bg-status-danger",
  success: "bg-status-success",
  neutral: "bg-text-secondary",
  idle: "border border-text-secondary bg-transparent",
};

function KitStatusDot({ state, label, pulse, size, className, ...rest }: PluginStatusDotProps) {
  const at = oneOf(state, STATES) ?? "neutral";
  const name = nonEmpty(label);
  return (
    <span
      {...pickRootProps(rest)}
      data-state={at}
      className={cn(
        "inline-block shrink-0 rounded-full",
        size === "md" ? "h-2 w-2" : "h-1.5 w-1.5",
        DOT_STATE[at],
        at !== "idle" && "forced-colors:bg-[CanvasText]",
        // The app's activity pulse; the reduce-motion block in index.css
        // stills it under the OS setting and the app's own.
        pulse === true && "animate-activity-pulse",
        str(className)
      )}
      {...(name ? { role: "img", "aria-label": name } : { "aria-hidden": true })}
    />
  );
}

// The app's state glyphs: the agent working spinner and waiting ring, the
// severity glyphs for an outcome, and a plain ring for idle.
type StateGlyphComponent = ComponentType<{
  className?: string;
  style?: CSSProperties;
  "aria-hidden"?: "true";
}>;

const GLYPH_STATE: Record<PluginStatusState, { Glyph: StateGlyphComponent; tone: string }> = {
  running: { Glyph: SpinnerCircle, tone: "text-state-working animate-spin-slow" },
  waiting: { Glyph: HollowCircle, tone: "text-state-waiting" },
  idle: { Glyph: Circle, tone: "text-text-secondary" },
  success: { Glyph: SEVERITY_GLYPH.success, tone: "text-status-success" },
  error: { Glyph: SEVERITY_GLYPH.error, tone: "text-status-danger" },
  neutral: { Glyph: ExitedCircle, tone: "text-text-secondary" },
};

function KitStateGlyph({ state, label, size, className, ...rest }: PluginStateGlyphProps) {
  const at = oneOf(state, STATES) ?? "neutral";
  const { Glyph, tone } = GLYPH_STATE[at];
  const px = positive(size, 512) ?? 16;
  const name = nonEmpty(label);
  const glyph = (
    <Glyph
      className={cn("shrink-0", tone, name ? undefined : str(className))}
      style={{ width: px, height: px }}
      aria-hidden="true"
    />
  );
  // The spinner is a styled box, not an svg, so the name and root attributes
  // go on a wrapper that every glyph shares.
  return (
    <span
      {...pickRootProps(rest)}
      data-state={at}
      className={cn("inline-flex shrink-0", str(className))}
      {...(name ? { role: "img", "aria-label": name } : { "aria-hidden": true })}
    >
      {glyph}
    </span>
  );
}

/** `kitLabelColor`'s parsed colour as the dot's fill variable. */
function labelDotStyle(rgb: readonly number[]): CSSProperties & Record<"--kit-label-dot", string> {
  return { "--kit-label-dot": `rgb(${rgb.join(", ")})` };
}

function KitColoredLabel({
  color,
  children,
  size,
  shape,
  variant,
  className,
  style,
  ...rest
}: PluginColoredLabelProps) {
  const theme = useDaintreeTheme();
  const own = typeof style === "object" && style !== null && !Array.isArray(style) ? style : {};
  if (variant === "dot") {
    const hex = parseLabelHex(color);
    // The forge hover card's LabelChip: a neutral chip, the colour on a dot.
    return (
      <Badge
        {...pickDomProps(rest)}
        tone="outline"
        size={oneOf(size, ["xs", "sm", "md"] as const)}
        shape={oneOf(shape, ["default", "pill"] as const) ?? "pill"}
        data-kit-colored-label="dot"
        style={own}
        className={str(className)}
      >
        {hex ? (
          <span
            aria-hidden="true"
            // Through a variable, so the forced-colors fill can still win: an
            // inline background would beat the class and be painted as Canvas.
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--kit-label-dot)] forced-colors:bg-[CanvasText]"
            style={labelDotStyle(hex)}
          />
        ) : null}
        {node(children)}
      </Badge>
    );
  }
  // The pane, a raised panel and a hovered row: where a label actually sits.
  const colors = labelColors(
    color,
    [
      theme.tokens["surface-panel"],
      theme.tokens["surface-panel-elevated"],
      theme.tokens["surface-hover"],
    ],
    theme.colorMode
  );
  return (
    <Badge
      {...pickDomProps(rest)}
      size={oneOf(size, ["xs", "sm", "md"] as const)}
      shape={oneOf(shape, ["default", "pill"] as const)}
      data-kit-colored-label="tint"
      style={
        colors
          ? {
              ...own,
              backgroundColor: colors.background,
              color: colors.color,
              // Inset, so the edge adds nothing to the Badge's geometry.
              boxShadow: `inset 0 0 0 1px ${colors.border}`,
            }
          : own
      }
      className={str(className)}
    >
      {node(children)}
    </Badge>
  );
}

const PLACEMENTS = ["top-right", "top-left", "bottom-right", "bottom-left"] as const;

// The toolbar pip's corner: 2px past the edge, cut out of what it sits on by a
// 1px ring in the pane's surface. Forced colours drop box-shadow, so the cut-out
// comes back as an outline there.
const PIP_PLACEMENT: Record<PluginIndicatorPlacement, string> = {
  "top-right": "-top-0.5 -right-0.5",
  "top-left": "-top-0.5 -left-0.5",
  "bottom-right": "-bottom-0.5 -right-0.5",
  "bottom-left": "-bottom-0.5 -left-0.5",
};

// A count bubble centres on the corner instead, so a wide "99+" grows outwards.
const BUBBLE_PLACEMENT: Record<PluginIndicatorPlacement, string> = {
  "top-right": "top-0 right-0 translate-x-1/2 -translate-y-1/2",
  "top-left": "top-0 left-0 -translate-x-1/2 -translate-y-1/2",
  "bottom-right": "bottom-0 right-0 translate-x-1/2 translate-y-1/2",
  "bottom-left": "bottom-0 left-0 -translate-x-1/2 translate-y-1/2",
};

const CUTOUT_CLASS =
  "ring-1 ring-surface-panel forced-colors:outline forced-colors:outline-1 forced-colors:outline-[Canvas]";

/**
 * Wraps `children` with an indicator on one corner. The indicator's spoken
 * `label` is attached to a lone element child as its description, since a
 * sibling of a button is not read when the button takes focus.
 */
function Anchored({
  children,
  indicator,
  label,
  rootProps,
  className,
}: {
  children: ReactNode;
  indicator: ReactNode;
  label: string | undefined;
  rootProps: Record<string, string | number | boolean>;
  className: string | undefined;
}) {
  const id = useId();
  let body = node(children);
  let describedHere = false;
  // A fragment takes no attributes, so its description stays in the tree.
  if (
    label &&
    isValidElement<{ "aria-describedby"?: string }>(children) &&
    children.type !== Fragment
  ) {
    const element = children as ReactElement<{ "aria-describedby"?: string }>;
    const existing = element.props["aria-describedby"];
    body = cloneElement(element, {
      "aria-describedby": existing ? `${existing} ${id}` : id,
    });
    describedHere = true;
  }
  return (
    <span {...rootProps} className={cn("relative inline-flex", className)}>
      {body}
      {indicator}
      {label ? (
        <span id={id} className="sr-only" {...(describedHere ? { "aria-hidden": true } : {})}>
          {label}
        </span>
      ) : null}
    </span>
  );
}

function KitUnreadDot({
  children,
  visible,
  label,
  placement,
  className,
  ...rest
}: PluginUnreadDotProps) {
  const show = visible !== false;
  const name = show ? nonEmpty(label) : undefined;
  const dot = (anchored: boolean) => (
    <span
      aria-hidden="true"
      data-kit-unread-dot=""
      className={cn(
        "h-1.5 w-1.5 shrink-0 rounded-full bg-text-secondary forced-colors:bg-[CanvasText]",
        anchored
          ? cn(
              "pointer-events-none absolute",
              CUTOUT_CLASS,
              PIP_PLACEMENT[oneOf(placement, PLACEMENTS) ?? "top-right"]
            )
          : "inline-block"
      )}
    />
  );
  if (children === undefined || children === null) {
    if (!show) return null;
    return (
      <span
        {...pickRootProps(rest)}
        className={cn("inline-flex items-center", str(className))}
        {...(name ? { role: "img", "aria-label": name } : {})}
      >
        {dot(false)}
      </span>
    );
  }
  return (
    <Anchored
      indicator={show ? dot(true) : null}
      label={name}
      rootProps={pickRootProps(rest)}
      className={str(className)}
    >
      {children}
    </Anchored>
  );
}

function capCount(count: number, max: number): string {
  return count > max ? `${max}+` : String(count);
}

function KitCountIndicator({
  count,
  children,
  max,
  showZero,
  label,
  placement,
  className,
  ...rest
}: PluginCountIndicatorProps) {
  const value =
    typeof count === "number" && Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
  const cap = typeof max === "number" && Number.isInteger(max) && max > 0 ? max : 99;
  const show = value > 0 || showZero === true;
  const shown = capCount(value, cap);
  const name = show
    ? (nonEmpty(label) ?? (value > cap ? `More than ${cap}` : undefined))
    : undefined;
  if (children === undefined || children === null) {
    if (!show) return null;
    // NavList's count pill exactly, so a count reads the same wherever it sits.
    return (
      <span
        {...pickRootProps(rest)}
        data-kit-count-indicator=""
        className={cn(COUNT_BADGE_CLASS, str(className))}
      >
        {name ? (
          <>
            <span aria-hidden="true">{shown}</span>
            <span className="sr-only">{name}</span>
          </>
        ) : (
          shown
        )}
      </span>
    );
  }
  // On top of something the translucent pill would show it through, so the
  // bubble is solid: the secondary ink with inverse text, which holds 4.5:1
  // both ways because the pair is the app's own text on its canvas.
  const bubble = show ? (
    <span
      aria-hidden="true"
      data-kit-count-indicator=""
      className={cn(
        // The count pill's recipe, made solid and a fixed 16px tall.
        COUNT_BADGE_CLASS,
        "pointer-events-none absolute h-4 min-w-4 bg-text-secondary px-1 py-0 text-text-inverse",
        CUTOUT_CLASS,
        BUBBLE_PLACEMENT[oneOf(placement, PLACEMENTS) ?? "top-right"]
      )}
    >
      {shown}
    </span>
  ) : null;
  return (
    <Anchored
      indicator={bubble}
      label={name ?? (show ? shown : undefined)}
      rootProps={pickRootProps(rest)}
      className={str(className)}
    >
      {children}
    </Anchored>
  );
}

export const pluginKitTypography = {
  Text: KitText,
  Heading: KitHeading,
  Link: KitLink,
  InlineCode: KitInlineCode,
  CodeBlock: KitCodeBlock,
  PathLabel: KitPathLabel,
  VisuallyHidden: KitVisuallyHidden,
  LiveRegion: KitLiveRegion,
  Portal: KitPortal,
  StatusDot: KitStatusDot,
  StateGlyph: KitStateGlyph,
  ColoredLabel: KitColoredLabel,
  UnreadDot: KitUnreadDot,
  CountIndicator: KitCountIndicator,
};

/** Kit functions the facade calls outside React components. */
export const pluginKitTypographyFunctions = { announce };
