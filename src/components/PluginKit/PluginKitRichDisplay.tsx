import {
  isValidElement,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { Virtuoso } from "react-virtuoso";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ImageOff,
  Minus,
  Plus,
  RefreshCw,
  WrapText,
} from "lucide-react";
import type {
  PluginAnsiTextProps,
  PluginHoverCardProps,
  PluginImageViewerProps,
  PluginTableOfContentsProps,
  PluginTerminalOutputProps,
  PluginTocHeading,
} from "@shared/types/plugin-sdk-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { ROW_CONTROL_CLASS, RowControlTooltip } from "@/components/ui/RowControl";
import { LIST_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { CopyButton } from "@/components/ui/CopyButton";
import {
  PANE_STATUS_FOOTER_CLASS,
  PANE_TOOLBAR_ICON_BUTTON_CLASS,
  PANE_TOOLBAR_ICON_CLASS,
  PANE_TOOLBAR_TEXT_BUTTON_CLASS,
} from "@/components/ui/paneToolbarStyles";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { clampZoom, fitScale, zoomForWheel } from "@/components/FileViewer/ZoomableImage";
import { transparencyCheckerboardUnderScale } from "@/components/FileViewer/transparencyCheckerboard";
import { activateMarkdownLink, HTTPish } from "@/components/Markdown/markdownLinkPolicy";
import { DEFAULT_TERMINAL_FONT_FAMILY } from "@/config/terminalFont";
import { useToolbarRoving } from "@/hooks/useToolbarRoving";
import { cn } from "@/lib/utils";
import {
  AnsiParser,
  lineText,
  PLAIN_STYLE,
  TERMINAL_BACKGROUND,
  TERMINAL_FOREGROUND,
  type AnsiLine,
  type AnsiSnapshot,
  type AnsiStyle,
} from "./kitAnsi";
import {
  ALIGNS,
  SIDES,
  content,
  field,
  fn,
  hasContent,
  node,
  nonEmpty,
  oneOf,
  pickRootProps,
  PluginStyleScope,
  positive,
  str,
} from "./kitProps";
import { PluginKitLayerContext, useKitOverlayZClass } from "./kitScope";
import { pluginKitRichCharts } from "./PluginKitRichCharts";

// Rich display: CLI output in the terminal's own colours, the host's hover
// card, an image viewer on the file viewer's zoom model, and a table of
// contents for long documents. The new chart forms live beside the first
// three in PluginKitRichCharts.tsx.

// ANSI output

const NO_LINK_PATHS = { filePath: "", rootPath: "" };

/** A run's inline style. `inverse` swaps in the terminal's own ink and surface, as xterm does. */
export function ansiStyle(style: AnsiStyle): CSSProperties | undefined {
  if (style === PLAIN_STYLE) return undefined;
  let fg = style.fg;
  let bg = style.bg;
  if (style.inverse) {
    const ink = fg ?? TERMINAL_FOREGROUND;
    fg = bg ?? TERMINAL_BACKGROUND;
    bg = ink;
  }
  const decoration = [style.underline && "underline", style.strike && "line-through"]
    .filter(Boolean)
    .join(" ");
  return {
    color: style.hidden ? "transparent" : (fg ?? undefined),
    backgroundColor: bg ?? undefined,
    fontWeight: style.bold ? 700 : undefined,
    fontStyle: style.italic ? "italic" : undefined,
    textDecorationLine: decoration || undefined,
    // xterm draws faint text at half strength of its own colour.
    opacity: style.dim ? 0.5 : undefined,
  };
}

function openLink(event: MouseEvent<HTMLAnchorElement>, href: string) {
  event.preventDefault();
  activateMarkdownLink(href, NO_LINK_PATHS);
}

/** One line's runs. A hyperlink opens through the host, as the kit `Link` does. */
function AnsiRuns({ line }: { line: AnsiLine }) {
  return (
    <>
      {line.segments.map((segment, index) => {
        const style = ansiStyle(segment.style);
        const link = segment.style.link;
        if (link !== null && HTTPish.test(link)) {
          return (
            <a
              key={index}
              href={link}
              title={link}
              style={style}
              onClick={(event) => openLink(event, link)}
              onAuxClick={(event) => event.preventDefault()}
              // A dragged link would carry its URL past the host's link policy.
              draggable={false}
              onDragStart={(event) => event.preventDefault()}
              className="rounded-[var(--radius-xs)] underline decoration-dotted underline-offset-2 hover:decoration-solid focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
            >
              {segment.text}
            </a>
          );
        }
        return style ? (
          <span key={index} style={style}>
            {segment.text}
          </span>
        ) : (
          segment.text
        );
      })}
    </>
  );
}

// The terminal's own face at its default 12px, on an 18px line.
const TERMINAL_TEXT_STYLE: CSSProperties = { fontFamily: DEFAULT_TERMINAL_FONT_FAMILY };
const TERMINAL_TEXT_CLASS = "text-xs leading-4.5";

function KitAnsiText({ text, display, className, ...rest }: PluginAnsiTextProps) {
  const source = str(text) ?? "";
  const lines = useMemo(() => {
    const parser = new AnsiParser();
    parser.write(source);
    return parser.snapshot().lines;
  }, [source]);
  const block = oneOf(display, ["inline", "block"] as const) === "block";
  const runs = lines.map((line, index) => (
    <span key={index}>
      {index > 0 ? "\n" : null}
      <AnsiRuns line={line} />
    </span>
  ));
  return block ? (
    <pre
      {...pickRootProps(rest)}
      style={TERMINAL_TEXT_STYLE}
      className={cn(
        "m-0 whitespace-pre-wrap [overflow-wrap:anywhere]",
        TERMINAL_TEXT_CLASS,
        str(className)
      )}
    >
      {runs}
    </pre>
  ) : (
    <span {...pickRootProps(rest)} className={cn("whitespace-pre-wrap font-mono", str(className))}>
      {runs}
    </span>
  );
}

/**
 * The parser behind a `TerminalOutput`, kept across renders: output that
 * grows by appending is parsed only for its new tail, so a streaming log
 * costs what arrived, not everything so far.
 */
export class TerminalOutputCache {
  private text = "";
  private max = 0;
  private parser: AnsiParser | null = null;

  update(text: string, max: number): AnsiSnapshot {
    if (this.parser === null || max !== this.max || !text.startsWith(this.text)) {
      this.parser = new AnsiParser(max);
      this.max = max;
      this.text = "";
    }
    if (text.length > this.text.length) this.parser.write(text.slice(this.text.length));
    this.text = text;
    return this.parser.snapshot();
  }
}

const DEFAULT_OUTPUT_LINES = 10_000;
const MAX_OUTPUT_LINES = 100_000;
const OUTPUT_LINE_PX = 18;

/** An in-pane toolbar icon button with its name as its tooltip, as the file viewer's are. */
function PaneIconButton({
  label,
  onClick,
  pressed,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const overlayZ = useKitOverlayZClass();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={pressed}
          // aria-disabled, not disabled: an unavailable step keeps its place in
          // the toolbar's arrow-key order and its tooltip.
          aria-disabled={disabled || undefined}
          onClick={() => {
            if (!disabled) onClick();
          }}
          className={PANE_TOOLBAR_ICON_BUTTON_CLASS}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className={overlayZ}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function KitTerminalOutput({
  text,
  "aria-label": ariaLabel,
  title,
  actions,
  toolbar,
  wrap,
  defaultWrap,
  onWrapChange,
  lineNumbers,
  follow,
  maxLines,
  empty,
  className,
  ...rest
}: PluginTerminalOutputProps) {
  const max =
    Math.floor(positive(maxLines, MAX_OUTPUT_LINES) ?? DEFAULT_OUTPUT_LINES) ||
    DEFAULT_OUTPUT_LINES;
  const [cache] = useState(() => new TerminalOutputCache());
  const source = str(text) ?? "";
  const snapshot = useMemo(() => cache.update(source, max), [cache, source, max]);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const onToolbarKeyDown = useToolbarRoving(toolbarRef);
  const [ownWrap, setOwnWrap] = useState(defaultWrap !== false);
  const wrapped = typeof wrap === "boolean" ? wrap : ownWrap;
  const notifyWrap = fn(onWrapChange);
  const numbered = lineNumbers === true;
  const following = follow !== false;
  const label = str(ariaLabel) ?? "";
  const { lines, dropped } = snapshot;
  const isEmpty = lines.length === 1 && lines[0]!.length === 0;
  const gutterCh = String(dropped + lines.length).length + 1;
  const copyText = () => lines.map(lineText).join("\n");

  return (
    <div
      {...pickRootProps(rest, { aria: true })}
      className={cn("flex h-full min-h-0 min-w-0 flex-col overflow-hidden", str(className))}
      style={{ backgroundColor: TERMINAL_BACKGROUND, color: TERMINAL_FOREGROUND }}
    >
      {toolbar !== false ? (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-divider bg-surface-panel pl-3 pr-1.5">
          <div className="min-w-0 flex-1 truncate text-xs font-medium text-text-secondary">
            {node(title)}
          </div>
          <div
            ref={toolbarRef}
            role="toolbar"
            aria-label={label ? `${label} actions` : "Output actions"}
            onKeyDown={onToolbarKeyDown}
            className="flex shrink-0 items-center gap-0.5"
          >
            {content(actions)}
            <PaneIconButton
              label="Wrap lines"
              pressed={wrapped}
              onClick={() => {
                if (typeof wrap !== "boolean") setOwnWrap(!wrapped);
                notifyWrap?.(!wrapped);
              }}
            >
              <WrapText className={PANE_TOOLBAR_ICON_CLASS} aria-hidden="true" />
            </PaneIconButton>
            <CopyButton
              text={copyText}
              aria-label="Copy output"
              tooltip="Copy output"
              tooltipSide="bottom"
              disabled={isEmpty}
            />
          </div>
        </div>
      ) : null}
      {isEmpty ? (
        <div
          role="log"
          aria-label={label}
          className="flex min-h-0 flex-1 items-center justify-center text-xs text-text-secondary"
        >
          {hasContent(empty) ? node(empty) : "No output"}
        </div>
      ) : (
        <Virtuoso
          // A live region would read out every line of a busy job; the output
          // is there to be read on demand, from the keyboard as well as the wheel.
          role="log"
          aria-live="off"
          aria-label={label}
          tabIndex={0}
          className="min-h-0 flex-1 py-1.5 text-xs leading-4.5 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
          style={TERMINAL_TEXT_STYLE}
          data={lines}
          // Keyed by line number in the whole output, so a line keeps its row
          // as older ones drop.
          computeItemKey={(index) => dropped + index}
          defaultItemHeight={OUTPUT_LINE_PX}
          increaseViewportBy={400}
          atBottomThreshold={24}
          initialTopMostItemIndex={following ? Math.max(0, lines.length - 1) : 0}
          followOutput={(atBottom) => (following && atBottom ? "auto" : false)}
          itemContent={(index, line) => (
            <div
              data-ansi-line=""
              className={cn(
                "flex min-h-[18px]",
                wrapped
                  ? "whitespace-pre-wrap [overflow-wrap:anywhere]"
                  : "w-max min-w-full whitespace-pre"
              )}
            >
              {numbered ? (
                <span
                  aria-hidden="true"
                  className="sticky left-0 shrink-0 select-none pl-3 pr-3 text-right tabular-nums"
                  style={{
                    width: `calc(${gutterCh}ch + 1.5rem)`,
                    color: "var(--theme-terminal-muted, var(--theme-text-secondary))",
                    backgroundColor: TERMINAL_BACKGROUND,
                  }}
                >
                  {dropped + index + 1}
                </span>
              ) : null}
              <span className={cn("min-w-0 flex-1 pr-3", !numbered && "pl-3")}>
                <AnsiRuns line={line} />
              </span>
            </div>
          )}
        />
      )}
    </div>
  );
}

// Hover card

// ForgeTooltipContent's fence for the host's own hover cards: a click inside
// the card must not reach the row or the drag source behind its trigger.
const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
const HOVER_CARD_FENCE = {
  "data-no-dnd": "",
  onClick: stop,
  onDoubleClick: stop,
  onContextMenu: stop,
} as const;

const HOVER_CARD_WIDTH = {
  sm: "w-56",
  // The host's issue and pull request cards: 280px plus the p-3.
  md: "w-[304px]",
  // The tooltip surface's own cap.
  lg: "w-80",
} as const;

const DEFAULT_OPEN_DELAY = 300;
const DEFAULT_CLOSE_DELAY = 150;

function delayOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(value, 10_000)
    : fallback;
}

function KitHoverCard({
  children,
  content: body,
  openDelay,
  closeDelay,
  side,
  align,
  width,
  open,
  defaultOpen,
  onOpenChange,
  "aria-label": ariaLabel,
  disabled,
}: PluginHoverCardProps) {
  const overlayZ = useKitOverlayZClass();
  const [ownOpen, setOwnOpen] = useState(defaultOpen === true);
  const controlled = typeof open === "boolean";
  const shown = controlled ? open : ownOpen;
  const notify = fn(onOpenChange);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set while the pointer is outside both the trigger and the card. Leaving
  // starts the `closeDelay` timer, coming back cancels it, and while it runs
  // Radix's own pointer close is left to it; Escape and a blur with the
  // pointer elsewhere close at once.
  const pointerAway = useRef(false);
  useEffect(
    () => () => {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    },
    []
  );
  if (!isValidElement(children)) return null;
  if (disabled === true || !hasContent(body)) return children;
  const lingering = delayOf(closeDelay, DEFAULT_CLOSE_DELAY);
  const cancelClose = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const commit = (next: boolean) => {
    if (!controlled) setOwnOpen(next);
    notify?.(next);
  };
  const handleOpenChange = (next: boolean) => {
    if (next) {
      cancelClose();
      commit(true);
      return;
    }
    if (pointerAway.current && lingering > 0) return;
    cancelClose();
    commit(false);
  };
  const enter = () => {
    pointerAway.current = false;
    cancelClose();
  };
  const leave = () => {
    pointerAway.current = true;
    if (!shown || lingering === 0) return;
    cancelClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      commit(false);
    }, lingering);
  };
  const widthKey = oneOf(width, ["sm", "md", "lg"] as const) ?? "md";
  return (
    <Tooltip
      open={shown}
      onOpenChange={handleOpenChange}
      delayDuration={delayOf(openDelay, DEFAULT_OPEN_DELAY)}
      // A hover card's body is the content: it stays while it is read, through
      // dialog transitions, and while the pointer crosses onto it (WCAG 1.4.13).
      autoDismiss={false}
      dismissOnDialogTransition={false}
      disableHoverableContent={false}
    >
      <TooltipTrigger asChild onPointerEnter={enter} onPointerLeave={leave} onFocus={enter}>
        {children}
      </TooltipTrigger>
      <TooltipContent
        side={oneOf(side, SIDES) ?? "bottom"}
        align={oneOf(align, ALIGNS) ?? "start"}
        className={cn("p-3", HOVER_CARD_WIDTH[widthKey], overlayZ)}
        aria-label={nonEmpty(ariaLabel)}
        onPointerEnter={enter}
        onPointerLeave={leave}
        onEscapeKeyDown={() => {
          pointerAway.current = false;
        }}
        {...HOVER_CARD_FENCE}
      >
        <PluginStyleScope block>{node(body)}</PluginStyleScope>
      </TooltipContent>
    </Tooltip>
  );
}

// Image viewer

type Zoom = "fit" | number;

interface ViewState {
  zoom: Zoom;
  x: number;
  y: number;
}

interface Size {
  width: number;
  height: number;
}

const BUTTON_ZOOM_STEP = 1.25;
const KEYBOARD_PAN_STEP = 48;

function startZoom(value: unknown): Zoom {
  if (value === "actual") return 1;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return clampZoom(value);
  return "fit";
}

/** How far the picture may move from centre: to its own edges, never past them. Exported for tests. */
export function clampPan(
  x: number,
  y: number,
  scale: number,
  natural: Size | null,
  stage: Size | null
): { x: number; y: number } {
  if (!natural || !stage) return { x: 0, y: 0 };
  const maxX = Math.max(0, (natural.width * scale - stage.width) / 2);
  const maxY = Math.max(0, (natural.height * scale - stage.height) / 2);
  return { x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) };
}

interface ViewerImage {
  src: string;
  alt: string;
  caption: unknown;
}

function readImages(value: unknown): ViewerImage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const src = nonEmpty(field(entry, "src"));
    if (!src) return [];
    return [{ src, alt: str(field(entry, "alt")) ?? "", caption: field(entry, "caption") }];
  });
}

type LoadStatus = "pending" | "loaded" | "failed";

function ImageStage({
  images,
  index,
  onStep,
  startAt,
  checkerboard,
  label,
  className,
}: {
  images: ViewerImage[];
  index: number;
  onStep: (index: number) => void;
  startAt: Zoom;
  checkerboard: boolean;
  label: string | undefined;
  className?: string;
}) {
  const image = images[index]!;
  const count = images.length;
  const [retry, setRetry] = useState(0);
  const key = `${image.src}\u0000${retry}`;
  const [load, setLoad] = useState<{ key: string; status: LoadStatus; natural: Size | null }>({
    key: "",
    status: "pending",
    natural: null,
  });
  const status: LoadStatus = load.key === key ? load.status : "pending";
  const natural = load.key === key ? load.natural : null;

  // Each picture opens at the starting zoom, centred.
  const [view, setView] = useState<ViewState>({ zoom: startAt, x: 0, y: 0 });
  const [viewFor, setViewFor] = useState(image.src);
  if (viewFor !== image.src) {
    setViewFor(image.src);
    setView({ zoom: startAt, x: 0, y: 0 });
  }

  const [stageElement, setStageElement] = useState<HTMLDivElement | null>(null);
  const [stage, setStage] = useState<Size | null>(null);
  useLayoutEffect(() => {
    if (stageElement === null) return;
    const read = () =>
      setStage({ width: stageElement.clientWidth, height: stageElement.clientHeight });
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(stageElement);
    return () => observer.disconnect();
  }, [stageElement]);

  const fit = fitScale(natural, stage);
  const scale = view.zoom === "fit" ? fit : view.zoom;
  const offset = clampPan(view.x, view.y, scale, natural, stage);
  const overflows = {
    x: natural !== null && stage !== null && natural.width * scale > stage.width + 0.5,
    y: natural !== null && stage !== null && natural.height * scale > stage.height + 0.5,
  };

  /** Zooms to `next`, keeping the point `about` (from the stage's centre) still. */
  const zoomTo = (next: number | "fit", about = { x: 0, y: 0 }) =>
    setView((previous) => {
      const from = previous.zoom === "fit" ? fit : previous.zoom;
      if (next === "fit") return { zoom: "fit", x: 0, y: 0 };
      const to = clampZoom(next);
      const ratio = from > 0 ? to / from : 1;
      const at = clampPan(previous.x, previous.y, from, natural, stage);
      const moved = clampPan(
        about.x - (about.x - at.x) * ratio,
        about.y - (about.y - at.y) * ratio,
        to,
        natural,
        stage
      );
      return { zoom: to, ...moved };
    });

  // Native and non-passive: React's wheel listener is passive, and a passive
  // listener cannot keep the page from scrolling behind the zoom. A trackpad
  // pinch arrives here as a wheel with ctrlKey.
  useEffect(() => {
    if (stageElement === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = stageElement.getBoundingClientRect();
      const about = {
        x: event.clientX - box.left - box.width / 2,
        y: event.clientY - box.top - box.height / 2,
      };
      setView((previous) => {
        const from = previous.zoom === "fit" ? fit : previous.zoom;
        const to = zoomForWheel(from, event.ctrlKey ? event.deltaY * 4 : event.deltaY);
        const ratio = from > 0 ? to / from : 1;
        const at = clampPan(previous.x, previous.y, from, natural, stage);
        return {
          zoom: to,
          ...clampPan(
            about.x - (about.x - at.x) * ratio,
            about.y - (about.y - at.y) * ratio,
            to,
            natural,
            stage
          ),
        };
      });
    };
    stageElement.addEventListener("wheel", onWheel, { passive: false });
    return () => stageElement.removeEventListener("wheel", onWheel);
  }, [stageElement, fit, natural, stage]);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  // The last pointer position (one finger or the mouse), or the last midpoint
  // and spread of two fingers, in stage-centre coordinates.
  const gesture = useRef<{ x: number; y: number; distance: number } | null>(null);
  const centred = (point: { x: number; y: number }) => {
    const box = stageElement?.getBoundingClientRect();
    return box
      ? { x: point.x - box.left - box.width / 2, y: point.y - box.top - box.height / 2 }
      : point;
  };
  const reading = () => {
    const points = [...pointers.current.values()];
    const [a, b] = points;
    if (a && b) {
      return {
        ...centred({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }),
        distance: Math.hypot(a.x - b.x, a.y - b.y),
      };
    }
    return a ? { ...centred(a), distance: 0 } : null;
  };
  /**
   * Moves the view so the image point under `from` lands under `to`, scaled by
   * `ratio` about it: a drag is ratio 1, a pinch keeps the spot between the
   * fingers under them as they spread and move. From the previous state, so
   * moves batched into one render all count.
   */
  const follow = (from: { x: number; y: number }, to: { x: number; y: number }, ratio: number) =>
    setView((previous) => {
      const was = previous.zoom === "fit" ? fit : previous.zoom;
      const now = clampZoom(was * ratio);
      const applied = was > 0 ? now / was : 1;
      const at = clampPan(previous.x, previous.y, was, natural, stage);
      return {
        zoom: ratio === 1 ? previous.zoom : now,
        ...clampPan(
          to.x - (from.x - at.x) * applied,
          to.y - (from.y - at.y) * applied,
          now,
          natural,
          stage
        ),
      };
    });
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || status !== "loaded") return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = reading();
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) || gesture.current === null) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const last = gesture.current;
    const next = reading();
    if (!next) return;
    gesture.current = next;
    const ratio = next.distance > 0 && last.distance > 0 ? next.distance / last.distance : 1;
    follow(last, next, ratio);
  };
  const endPointer = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    gesture.current = reading();
  };

  const step = (to: number) => {
    if (to >= 0 && to < count && to !== index) onStep(to);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    // The toolbar keeps its own arrows.
    if (event.target instanceof Element && event.target.closest('[role="toolbar"]')) return;
    const key = event.key;
    let handled = true;
    if (key === "+" || key === "=") zoomTo(scale * BUTTON_ZOOM_STEP);
    else if (key === "-" || key === "_") zoomTo(scale / BUTTON_ZOOM_STEP);
    else if (key === "0") zoomTo("fit");
    else if (key === "1") zoomTo(1);
    else if (key === "PageUp") step(index - 1);
    else if (key === "PageDown") step(index + 1);
    else if (key === "Home") step(0);
    else if (key === "End") step(count - 1);
    else if (key === "ArrowLeft" || key === "ArrowRight") {
      const sign = key === "ArrowLeft" ? 1 : -1;
      // Arrows pan a picture larger than the stage, and step through the set otherwise.
      if (overflows.x)
        setView({
          zoom: scale,
          ...clampPan(offset.x + sign * KEYBOARD_PAN_STEP, offset.y, scale, natural, stage),
        });
      else if (count > 1) step(index - sign);
      else handled = false;
    } else if (key === "ArrowUp" || key === "ArrowDown") {
      const sign = key === "ArrowUp" ? 1 : -1;
      if (overflows.y)
        setView({
          zoom: scale,
          ...clampPan(offset.x, offset.y + sign * KEYBOARD_PAN_STEP, scale, natural, stage),
        });
      else handled = false;
    } else handled = false;
    if (handled) event.preventDefault();
  };

  // Warm the neighbours so stepping does not flash an empty stage.
  useEffect(() => {
    for (const neighbour of [images[index - 1], images[index + 1]]) {
      if (!neighbour) continue;
      const preload = new Image();
      preload.src = neighbour.src;
    }
  }, [images, index]);

  const toolbarRef = useRef<HTMLDivElement>(null);
  const onToolbarKeyDown = useToolbarRoving(toolbarRef);
  const percent = Math.round(scale * 100);
  const isFit = view.zoom === "fit";
  const caption = content(image.caption);
  const name = label ?? image.alt;

  return (
    <div
      onKeyDown={onKeyDown}
      className={cn("flex min-h-0 min-w-0 flex-col", className)}
      data-image-viewer=""
    >
      <div
        ref={setStageElement}
        role="group"
        aria-roledescription="image viewer"
        aria-label={`${name}. Plus and minus zoom, 0 fits, 1 is actual size${count > 1 ? ", Page Up and Page Down step through the images" : ""}.`}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onDoubleClick={(event) => {
          if (status !== "loaded" || !stageElement) return;
          const box = stageElement.getBoundingClientRect();
          zoomTo(isFit ? Math.max(1, fit * 2) : "fit", {
            x: event.clientX - box.left - box.width / 2,
            y: event.clientY - box.top - box.height / 2,
          });
        }}
        className={cn(
          "relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-overlay-subtle",
          "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary",
          overflows.x || overflows.y ? "cursor-grab active:cursor-grabbing" : "cursor-default"
        )}
      >
        {status === "failed" ? (
          <div
            role="status"
            className="flex h-full flex-col items-center justify-center gap-3 text-text-secondary"
          >
            <ImageOff className="h-8 w-8" aria-hidden="true" />
            <p className="text-sm">Couldn't load the image</p>
            <Button
              variant="subtle"
              size="sm"
              onClick={() => {
                setRetry((n) => n + 1);
                stageElement?.focus({ preventScroll: true });
              }}
            >
              <RefreshCw aria-hidden="true" />
              Retry
            </Button>
          </div>
        ) : (
          <img
            key={key}
            src={image.src}
            alt={image.alt}
            draggable={false}
            onLoad={(event) =>
              setLoad({
                key,
                status: "loaded",
                natural: {
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                },
              })
            }
            onError={() => setLoad({ key, status: "failed", natural: null })}
            style={{
              ...(checkerboard ? transparencyCheckerboardUnderScale(scale) : null),
              width: natural?.width,
              height: natural?.height,
              maxWidth: "none",
              transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              // Past 200% a screenshot's pixels are the point: keep them square.
              imageRendering: scale >= 2 ? "pixelated" : undefined,
            }}
            className={cn(
              "absolute left-1/2 top-1/2 origin-center",
              status === "loaded" ? "opacity-100" : "opacity-0"
            )}
          />
        )}
        {status === "pending" ? (
          <Skeleton inert className="absolute inset-0" label="Loading image">
            <SkeletonBone className="h-full w-full rounded-none" />
          </Skeleton>
        ) : null}
      </div>
      {caption !== undefined ? (
        <div className="shrink-0 border-t border-divider px-3 py-1.5 text-xs text-text-primary">
          <PluginStyleScope>{caption}</PluginStyleScope>
        </div>
      ) : null}
      <div
        className={cn(PANE_STATUS_FOOTER_CLASS, "flex-wrap justify-between gap-x-2 gap-y-0.5 py-0")}
      >
        <span role="status" className="tabular-nums" data-image-viewer-status="">
          {natural ? (
            <span className="whitespace-nowrap">
              {natural.width} × {natural.height}
              <span aria-hidden="true" className="px-1.5">
                ·
              </span>
            </span>
          ) : null}
          <span className="whitespace-nowrap">{isFit ? `Fit, ${percent}%` : `${percent}%`}</span>
        </span>
        <div
          ref={toolbarRef}
          role="toolbar"
          aria-label="Image controls"
          onKeyDown={onToolbarKeyDown}
          className="ml-auto flex shrink-0 items-center gap-1"
        >
          {count > 1 ? (
            <>
              <PaneIconButton
                label="Previous image"
                disabled={index === 0}
                onClick={() => step(index - 1)}
              >
                <ChevronLeft className={PANE_TOOLBAR_ICON_CLASS} aria-hidden="true" />
              </PaneIconButton>
              <span className="min-w-12 text-center tabular-nums" aria-hidden="true">
                {index + 1} of {count}
              </span>
              <PaneIconButton
                label="Next image"
                disabled={index === count - 1}
                onClick={() => step(index + 1)}
              >
                <ChevronRight className={PANE_TOOLBAR_ICON_CLASS} aria-hidden="true" />
              </PaneIconButton>
              <span aria-hidden="true" className="mx-1 h-3.5 w-px bg-border-default" />
            </>
          ) : null}
          <PaneIconButton
            label="Zoom out"
            disabled={scale <= 0.1 + 1e-6}
            onClick={() => zoomTo(scale / BUTTON_ZOOM_STEP)}
          >
            <Minus className={PANE_TOOLBAR_ICON_CLASS} aria-hidden="true" />
          </PaneIconButton>
          <PaneIconButton
            label="Zoom in"
            disabled={scale >= 16 - 1e-6}
            onClick={() => zoomTo(scale * BUTTON_ZOOM_STEP)}
          >
            <Plus className={PANE_TOOLBAR_ICON_CLASS} aria-hidden="true" />
          </PaneIconButton>
          <button
            type="button"
            aria-pressed={isFit}
            onClick={() => zoomTo("fit")}
            className={PANE_TOOLBAR_TEXT_BUTTON_CLASS}
          >
            Fit
          </button>
          <button
            type="button"
            aria-pressed={!isFit && Math.abs(scale - 1) < 0.001}
            onClick={() => zoomTo(1)}
            className={PANE_TOOLBAR_TEXT_BUTTON_CLASS}
          >
            100%
          </button>
        </div>
      </div>
      {count > 1 ? (
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {`${image.alt || "Image"}, ${index + 1} of ${count}`}
        </span>
      ) : null}
    </div>
  );
}

function KitImageViewer({
  images,
  index,
  defaultIndex,
  onIndexChange,
  mode,
  open,
  onOpenChange,
  title,
  defaultZoom,
  checkerboard,
  "aria-label": ariaLabel,
  className,
  ...rest
}: PluginImageViewerProps) {
  const list = useMemo(() => readImages(images), [images]);
  const whole = (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
  const [ownIndex, setOwnIndex] = useState(whole(defaultIndex) ?? 0);
  const asked = whole(index) ?? ownIndex;
  const at = Math.min(asked, Math.max(0, list.length - 1));
  const notifyIndex = fn(onIndexChange);
  const notifyOpen = fn(onOpenChange);
  const modal = oneOf(mode, ["pane", "modal"] as const) === "modal";
  const step = (next: number) => {
    if (whole(index) === undefined) setOwnIndex(next);
    notifyIndex?.(next);
  };
  const stage =
    list.length === 0 ? (
      <div className="flex h-full items-center justify-center text-xs text-text-secondary">
        No image
      </div>
    ) : (
      <ImageStage
        images={list}
        index={at}
        onStep={step}
        startAt={startZoom(defaultZoom)}
        checkerboard={checkerboard !== false}
        label={nonEmpty(ariaLabel)}
        className="h-full"
      />
    );
  if (!modal) {
    return (
      <div
        {...pickRootProps(rest)}
        className={cn("flex h-full min-h-0 min-w-0 flex-col", str(className))}
      >
        {stage}
      </div>
    );
  }
  const heading = hasContent(title) ? node(title) : "Image";
  return (
    <PluginKitLayerContext.Provider value="modal">
      <AppDialog
        isOpen={open === true}
        onClose={() => notifyOpen?.(false)}
        size="5xl"
        maxHeight="max-h-[92vh]"
      >
        <AppDialog.Header>
          <div className="flex min-w-0 items-baseline gap-2">
            <AppDialog.Title>{heading}</AppDialog.Title>
            {list.length > 1 ? (
              <span className="shrink-0 text-xs tabular-nums text-text-secondary">
                {at + 1} of {list.length}
              </span>
            ) : null}
          </div>
          <AppDialog.CloseButton />
        </AppDialog.Header>
        <AppDialog.Description className="sr-only">
          {list[at]?.alt ?? "Image"}
        </AppDialog.Description>
        <AppDialog.BodyScroll className={cn("flex flex-col", str(className))}>
          <div
            {...pickRootProps(rest)}
            className="flex h-[min(70vh,720px)] min-h-0 flex-col overflow-hidden rounded-[var(--radius-md)] border border-divider"
          >
            {stage}
          </div>
        </AppDialog.BodyScroll>
      </AppDialog>
    </PluginKitLayerContext.Provider>
  );
}

// Table of contents

interface TocEntry extends PluginTocHeading {
  /** The entry's position among every heading in the document, before filtering by level. */
  order: number;
}

/** Markdown's inline syntax stripped from a heading, leaving what renders as text. */
function plainHeading(text: string): string {
  // Code spans render their text as written, so only the text between them is
  // unescaped and loses its emphasis marks.
  return text
    .split(/(`[^`]*`)/)
    .map((part) =>
      part.startsWith("`") && part.endsWith("`") && part.length > 1
        ? part.slice(1, -1)
        : part
            .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
            .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
            .replace(/<((?:https?|mailto):[^>\s]+)>/gi, "$1")
            .replace(/<[^>]+>/g, "")
            .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
            .replace(/([*_])(.+?)\1/g, "$2")
            .replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, "$1")
    )
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The headings of a Markdown document in order, ATX and setext, skipping
 * fenced code. Exported for tests.
 */
export function markdownHeadings(markdown: string): PluginTocHeading[] {
  const out: PluginTocHeading[] = [];
  const lines = markdown.split(/\r?\n/);
  let fence: { char: string; size: number } | null = null;
  let paragraph: string | null = null;
  for (const line of lines) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1]![0] === fence.char && fenceMatch[1]!.length >= fence.size) {
        if (/^ {0,3}(`{3,}|~{3,})\s*$/.test(line)) fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      fence = { char: fenceMatch[1]![0]!, size: fenceMatch[1]!.length };
      paragraph = null;
      continue;
    }
    // A heading may open a blockquote or a list item: `> ## Notes`, `- ## Step`.
    const bare = line
      .replace(/^(?: {0,3}>[ \t]?)+/, "")
      .replace(/^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/, "");
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(bare);
    if (atx) {
      const text = plainHeading(atx[2] ?? "");
      if (text) out.push({ text, level: atx[1]!.length });
      paragraph = null;
      continue;
    }
    const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    if (setext && paragraph !== null) {
      const text = plainHeading(paragraph);
      if (text) out.push({ text, level: setext[1]![0] === "=" ? 1 : 2 });
      paragraph = null;
      continue;
    }
    if (line.trim() === "") paragraph = null;
    else if (/^ {0,3}([-*+]|\d+[.)])\s|^ {0,3}>|^ {4}/.test(line)) paragraph = null;
    else paragraph = paragraph === null ? line.trim() : `${paragraph} ${line.trim()}`;
  }
  return out;
}

function readHeadings(markdown: unknown, headings: unknown): PluginTocHeading[] {
  if (typeof markdown === "string") return markdownHeadings(markdown);
  if (!Array.isArray(headings)) return [];
  return headings.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const text = nonEmpty(field(entry, "text"));
    const level = field(entry, "level");
    if (!text || typeof level !== "number" || !Number.isInteger(level) || level < 1 || level > 6) {
      return [];
    }
    return [{ text, level, id: nonEmpty(field(entry, "id")) }];
  });
}

const normalized = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

/**
 * The element each heading draws as, in `root`: by `id` when it has one,
 * else by position when the document has exactly as many headings, else by
 * matching text in order. Exported for tests.
 */
export function resolveHeadingElements(
  root: Element,
  headings: readonly PluginTocHeading[]
): (HTMLElement | null)[] {
  const drawn = Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"));
  const byPosition = drawn.length === headings.length;
  const used = new Set<HTMLElement>();
  let cursor = 0;
  const take = (at: number) => {
    const element = drawn[at]!;
    used.add(element);
    cursor = Math.max(cursor, at + 1);
    return element;
  };
  return headings.map((heading, index) => {
    if (heading.id) {
      const at = drawn.findIndex((element) => element.id === heading.id && !used.has(element));
      if (at !== -1) return take(at);
    }
    if (byPosition) {
      const element = drawn[index];
      return element && !used.has(element) ? take(index) : null;
    }
    const want = normalized(heading.text);
    for (let at = cursor; at < drawn.length; at++) {
      if (!used.has(drawn[at]!) && normalized(drawn[at]!.textContent) === want) return take(at);
    }
    return null;
  });
}

/** The nearest scrolling ancestor of `element`, or `element` itself with `self`. */
function scrollerOf(element: Element, self = false): HTMLElement | null {
  const first = self && element instanceof HTMLElement ? element : element.parentElement;
  for (let at = first; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") return at;
  }
  return null;
}

function targetElement(target: unknown): Element | null {
  if (target instanceof Element) return target;
  if (typeof target === "object" && target !== null && "current" in target) {
    const current = (target as { current: unknown }).current;
    return current instanceof Element ? current : null;
  }
  return null;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

const DEFAULT_TOC_DEPTH = 3;
// About two seconds of frames to wait for a target ref to be attached.
const TARGET_WAIT_FRAMES = 120;
const DEFAULT_SPY_OFFSET = 24;
const NO_FOLDS: ReadonlySet<number> = new Set();
// How long a click's own scroll holds the highlight on the clicked entry.
const NAVIGATION_HOLD_MS = 800;

function KitTableOfContents({
  markdown,
  headings,
  target,
  maxLevel,
  collapsible,
  sticky,
  title,
  offset,
  onNavigate,
  "aria-label": ariaLabel,
  className,
  ...rest
}: PluginTableOfContentsProps) {
  const all = useMemo(() => readHeadings(markdown, headings), [markdown, headings]);
  const depth =
    typeof maxLevel === "number" && maxLevel >= 1 && maxLevel <= 6
      ? Math.floor(maxLevel)
      : DEFAULT_TOC_DEPTH;
  const entries = useMemo<TocEntry[]>(
    () => all.flatMap((heading, order) => (heading.level <= depth ? [{ ...heading, order }] : [])),
    [all, depth]
  );
  const top = entries.reduce((least, entry) => Math.min(least, entry.level), 6);
  // Each entry's parent: the nearest earlier entry one level or more above it.
  const parents = useMemo(() => {
    const stack: number[] = [];
    return entries.map((entry, index) => {
      while (stack.length > 0 && entries[stack[stack.length - 1]!]!.level >= entry.level)
        stack.pop();
      const parent = stack[stack.length - 1] ?? -1;
      stack.push(index);
      return parent;
    });
  }, [entries]);
  const children = useMemo(() => {
    const map = new Map<number, number[]>();
    parents.forEach((parent, index) => {
      const list = map.get(parent) ?? [];
      list.push(index);
      map.set(parent, list);
    });
    return map;
  }, [parents]);
  const canCollapse = collapsible !== false;
  // Folds belong to the heading list they were made in, and only count while
  // folding is on.
  const [folds, setFolds] = useState<{ entries: TocEntry[]; set: ReadonlySet<number> }>(() => ({
    entries,
    set: new Set(),
  }));
  const collapsed: ReadonlySet<number> =
    canCollapse && folds.entries === entries ? folds.set : NO_FOLDS;
  const [active, setActive] = useState(entries.length > 0 ? 0 : -1);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const spyOffset =
    typeof offset === "number" && Number.isFinite(offset) && offset >= 0
      ? offset
      : DEFAULT_SPY_OFFSET;
  const holdUntil = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);
  const [root, setRoot] = useState<Element | null>(null);
  // Passive, so a ref on a sibling drawn after this one is attached by now. A
  // document that mounts later (after its data loads) is waited for a few
  // frames at a time, and looked for again whenever the headings change.
  useEffect(() => {
    let frame = 0;
    let tries = 0;
    const resolve = () => {
      const element = targetElement(target);
      setRoot((previous) => (previous === element ? previous : element));
      if (element === null && tries++ < TARGET_WAIT_FRAMES) frame = requestAnimationFrame(resolve);
    };
    resolve();
    return () => cancelAnimationFrame(frame);
  }, [target, all]);

  const allRef = useRef(all);
  useEffect(() => {
    allRef.current = all;
  });

  useEffect(() => {
    if (root === null || entries.length === 0) return;
    const scroller = scrollerOf(root, true);
    let frame = 0;
    let elements: (HTMLElement | null)[] = [];
    const resolve = () => {
      const found = resolveHeadingElements(root, allRef.current);
      elements = entries.map((entry) => found[entry.order] ?? null);
    };
    const measure = () => {
      frame = 0;
      if (Date.now() < holdUntil.current) return;
      const edge = (scroller ? scroller.getBoundingClientRect().top : 0) + spyOffset;
      let current = 0;
      for (let index = 0; index < elements.length; index++) {
        const element = elements[index];
        if (!element) continue;
        if (element.getBoundingClientRect().top <= edge + 1) current = index;
        else break;
      }
      // At the very bottom, the last sections may never reach the edge.
      const view = scroller ?? document.scrollingElement;
      if (
        view &&
        view.scrollHeight - view.scrollTop - view.clientHeight < 2 &&
        view.scrollTop > 0
      ) {
        current = elements.length - 1;
      }
      setActive((previous) => (previous === current ? previous : current));
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    resolve();
    measure();
    const source: EventTarget = scroller ?? window;
    source.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    // Markdown renders after its own chunk loads, and documents change: find
    // the headings again whenever the content does.
    const mutations =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            resolve();
            schedule();
          });
    mutations?.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      source.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      mutations?.disconnect();
    };
  }, [root, entries, spyOffset]);

  const hiddenBy = (index: number): number | null => {
    let hidden: number | null = null;
    for (let parent = parents[index]!; parent !== -1; parent = parents[parent]!) {
      if (collapsed.has(parent)) hidden = parent;
    }
    return hidden;
  };
  // A current section folded away is marked on the nearest entry still shown.
  const shownActive = active < 0 || active >= entries.length ? -1 : (hiddenBy(active) ?? active);
  const visible = entries.map((_, index) => hiddenBy(index) === null);
  const order = entries.map((_, index) => index).filter((index) => visible[index]);
  const tabStop =
    focusIndex !== null && visible[focusIndex]
      ? focusIndex
      : shownActive >= 0
        ? shownActive
        : (order[0] ?? -1);

  const toggle = (index: number, open?: boolean) => {
    const next = new Set(collapsed);
    const shut = open === undefined ? !next.has(index) : !open;
    if (shut) next.add(index);
    else next.delete(index);
    setFolds({ entries, set: next });
  };

  const focusEntry = (index: number) => {
    setFocusIndex(index);
    listRef.current?.querySelector<HTMLElement>(`[data-toc-index="${index}"]`)?.focus();
  };

  const navigate = (index: number) => {
    const entry = entries[index];
    if (!entry || root === null) return;
    const element = resolveHeadingElements(root, all)[entry.order];
    if (!element) return;
    const scroller = scrollerOf(element);
    const behavior: ScrollBehavior = prefersReducedMotion() ? "auto" : "smooth";
    if (scroller) {
      const delta = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTo({ top: scroller.scrollTop + delta - 8, behavior });
    } else {
      element.scrollIntoView({ block: "start", behavior });
    }
    holdUntil.current = Date.now() + (behavior === "smooth" ? NAVIGATION_HOLD_MS : 0);
    setActive(index);
    fn(onNavigate)?.({ text: entry.text, level: entry.level, id: entry.id }, index);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const own =
      event.target instanceof Element
        ? event.target.closest("[data-toc-index]")?.getAttribute("data-toc-index")
        : null;
    const from = order.indexOf(own == null ? tabStop : Number(own));
    if (from === -1) return;
    const current = order[from]!;
    let next: number | null = null;
    if (event.key === "ArrowDown") next = order[Math.min(order.length - 1, from + 1)]!;
    else if (event.key === "ArrowUp") next = order[Math.max(0, from - 1)]!;
    else if (event.key === "Home") next = order[0]!;
    else if (event.key === "End") next = order[order.length - 1]!;
    else if (event.key === "ArrowRight" && canCollapse && children.has(current)) {
      if (collapsed.has(current)) toggle(current, true);
      else next = children.get(current)![0]!;
    } else if (event.key === "ArrowLeft") {
      if (canCollapse && children.has(current) && !collapsed.has(current)) toggle(current, false);
      else if (parents[current] !== -1) next = parents[current]!;
    } else return;
    event.preventDefault();
    if (next !== null) focusEntry(next);
  };

  const label = nonEmpty(ariaLabel) ?? "Table of contents";
  const heading = title === undefined ? "On this page" : title;

  const renderLevel = (parent: number): ReactNode => {
    const list = children.get(parent);
    if (!list) return null;
    return list.map((index) => {
      const entry = entries[index]!;
      const kids = children.has(index);
      const folded = collapsed.has(index);
      const current = index === shownActive;
      return (
        <li key={index} className="flex min-w-0 flex-col">
          <div className="relative flex min-w-0 items-center">
            {current ? (
              <span
                aria-hidden="true"
                data-toc-marker=""
                className="absolute -left-px top-0.5 bottom-0.5 w-0.5 rounded-full bg-text-primary"
              />
            ) : null}
            <button
              type="button"
              data-toc-index={index}
              tabIndex={index === tabStop ? 0 : -1}
              aria-current={current ? "location" : undefined}
              aria-expanded={canCollapse && kids ? !folded : undefined}
              onClick={() => navigate(index)}
              onFocus={() => setFocusIndex(index)}
              title={entry.text}
              className={cn(
                "flex min-h-6 min-w-0 flex-1 items-center rounded-[var(--radius-sm)] py-0.5 pr-2 text-left text-xs transition-colors duration-150 ease-out",
                "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary",
                current
                  ? "font-medium text-text-primary"
                  : "text-text-secondary hover:text-text-primary"
              )}
              style={{ paddingLeft: 8 + (entry.level - top) * 12 + (canCollapse ? 18 : 0) }}
            >
              <span className="min-w-0 truncate">{entry.text}</span>
            </button>
            {canCollapse && kids ? (
              // The pointer's way to fold a section; the keyboard's is Left and
              // Right on the entry, so this stays out of the tab order.
              <RowControlTooltip label={folded ? "Expand section" : "Collapse section"}>
                <span
                  aria-hidden="true"
                  data-toc-toggle=""
                  onClick={(event) => {
                    // Folding away the entry that holds focus hands it to this one.
                    const item = event.currentTarget.closest("li");
                    const focused = document.activeElement;
                    const own = item?.querySelector<HTMLElement>(`[data-toc-index="${index}"]`);
                    if (!folded && focused && own && focused !== own && item?.contains(focused)) {
                      own.focus({ preventScroll: true });
                      setFocusIndex(index);
                    }
                    toggle(index);
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  className={cn(ROW_CONTROL_CLASS, "absolute")}
                  style={{ left: (entry.level - top) * 12 }}
                >
                  {folded ? (
                    <ChevronRight className="h-3 w-3" />
                  ) : (
                    <ChevronDown className="h-3 w-3" />
                  )}
                </span>
              </RowControlTooltip>
            ) : null}
          </div>
          {kids && !folded ? <ul className="flex min-w-0 flex-col">{renderLevel(index)}</ul> : null}
        </li>
      );
    });
  };

  return (
    <nav
      {...pickRootProps(rest)}
      aria-label={label}
      className={cn(
        "flex min-w-0 flex-col gap-1.5",
        sticky !== false && "sticky top-0 max-h-full self-start overflow-y-auto",
        str(className)
      )}
    >
      {hasContent(heading) ? (
        <div className={cn("px-2.5", LIST_LABEL_CLASS)}>{node(heading)}</div>
      ) : null}
      {entries.length === 0 ? (
        <p className="px-2.5 text-xs text-text-secondary">No headings</p>
      ) : (
        <ul
          ref={listRef}
          onKeyDown={onKeyDown}
          className="flex min-w-0 flex-col border-l border-divider"
        >
          {renderLevel(-1)}
        </ul>
      )}
    </nav>
  );
}

export const pluginKitRichDisplay = {
  AnsiText: KitAnsiText,
  TerminalOutput: KitTerminalOutput,
  HoverCard: KitHoverCard,
  ImageViewer: KitImageViewer,
  TableOfContents: KitTableOfContents,
  ...pluginKitRichCharts,
};
