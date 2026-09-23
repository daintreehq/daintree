import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useToolbarRoving } from "@/hooks/useToolbarRoving";
import { Check, Copy, Ellipsis, FileText, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

let measureContext: CanvasRenderingContext2D | null = null;

function measureTextWidth(text: string, font: string): number {
  measureContext ??= document.createElement("canvas").getContext("2d");
  if (!measureContext) return text.length * 8;
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

/**
 * The last resort when even the bare file name overflows: collapse the middle
 * of the name's stem and keep its extension, so a clipped pill still says what
 * kind of file it is. End truncation ("useContentPanelKeyboardNavigationAndFo…")
 * throws away exactly the part that distinguishes one file from its siblings.
 * Below the shortest readable form it keeps just the tail and extension;
 * CSS truncation is the backstop below that.
 */
export function fitFileName(name: string, fits: (text: string) => boolean): string {
  const dot = name.lastIndexOf(".");
  // No length cap: ".code-workspace" identifies a file as surely as ".ts".
  const hasExtension = dot > 0 && dot < name.length - 1;
  const stem = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? name.slice(dot) : "";
  // A few characters of the stem's tail stay beside the extension — the end of
  // a name ("…Restoration.ts", "…-v2.png") is often what tells siblings apart.
  const tail = Math.min(4, Math.floor(stem.length / 3));
  const build = (kept: number) =>
    `${stem.slice(0, kept)}…${stem.slice(stem.length - tail)}${extension}`;
  let hi = Math.max(0, stem.length - tail - 1);
  // Nothing with a readable stem fits: keep the tail and extension alone
  // rather than handing back the whole name for CSS to end-truncate, which
  // would cut the extension first.
  if (!fits(build(1))) return `…${stem.slice(stem.length - tail)}${extension}`;
  let lo = 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(build(mid))) lo = mid;
    else hi = mid - 1;
  }
  return build(lo);
}

/**
 * Width-fitted middle truncation: keeps as many characters from the front and
 * the back as actually fit the element, collapsing the middle with a single
 * ellipsis. The basename is reserved first so the file name always survives.
 * Re-fits on resize; measurement uses canvas measureText with the element's
 * own computed font, so no layout thrash.
 */
function useFittedPath(fullText: string | undefined): {
  spanRef: React.RefObject<HTMLElement | null>;
  display: string | undefined;
} {
  const spanRef = useRef<HTMLElement | null>(null);
  const [display, setDisplay] = useState<string | undefined>(fullText);

  useLayoutEffect(() => {
    const el = spanRef.current;
    if (!el || fullText === undefined) {
      setDisplay(fullText);
      return;
    }

    const fit = () => {
      const style = getComputedStyle(el);
      const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const available =
        el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      if (available <= 0) {
        // Not measurable (hidden/zero-width): show the new text rather than a
        // stale fit of the previous path; CSS truncate is the backstop.
        setDisplay(fullText);
        return;
      }
      if (measureTextWidth(fullText, font) <= available) {
        setDisplay(fullText);
        return;
      }
      const slashIdx = fullText.lastIndexOf("/");
      const basename = slashIdx >= 0 ? fullText.slice(slashIdx) : fullText;
      const head = fullText.slice(0, fullText.length - basename.length);
      const build = (kept: number) => {
        const front = Math.ceil(kept / 2);
        const back = kept - front;
        return `${head.slice(0, front)}…${back > 0 ? head.slice(head.length - back) : ""}${basename}`;
      };
      // Binary search the most head characters that still fit.
      let lo = 0;
      let hi = head.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (measureTextWidth(build(mid), font) <= available) lo = mid;
        else hi = mid - 1;
      }
      const candidate = build(lo);
      if (measureTextWidth(candidate, font) <= available) {
        setDisplay(candidate);
        return;
      }
      // Very narrow pane: prefer the bare file name over "…/file.md".
      const bare = basename.startsWith("/") ? basename.slice(1) : basename;
      if (measureTextWidth(`…${basename}`, font) <= available) {
        setDisplay(`…${basename}`);
        return;
      }
      if (measureTextWidth(bare, font) <= available) {
        setDisplay(bare);
        return;
      }
      setDisplay(fitFileName(bare, (text) => measureTextWidth(text, font) <= available));
    };

    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [fullText]);

  return { spanRef, display };
}

/**
 * One icon size for every control in this toolbar family, so every surface that
 * uses it (FilePane, DiffPane, the cross-worktree comparison dialog, and the
 * file browser's two header rows) cannot drift apart a pixel at a time.
 *
 * 14px rather than 16: at 16 the glyphs read heavier than the text beside them
 * and Refresh in particular dominated a row it only shares. With the button's
 * `p-1.5` this still leaves a 26px target, above the 24px WCAG 2.5.8 floor.
 *
 * Load-bearing beyond looks: the file browser's tree header hand-rolls its own
 * row to match `Root`'s height so the border under the two halves reads as one
 * continuous line (#11328). Sizing icons per call site is what would let that
 * line break, so the size lives here and callers spread it.
 */
export const TOOLBAR_ICON_CLASS = "h-3.5 w-3.5";

/**
 * The plain-file-viewing toolbar shared by the FilePane panel and the
 * FileViewerModal dialog, so the two surfaces can't drift apart again. Both
 * render the same viewer bodies (CodeViewer/MarkdownViewer/HtmlViewer); this
 * is the chrome above them.
 *
 * Composed rather than config-driven: the two surfaces own materially
 * different state (the dialog has diff modes and an Open-as-panel action the
 * panel has no concept of), so they supply their own children and keep their
 * own handlers. SegmentedToggle stays a separate import for the same reason —
 * the dialog appends a Diff segment the panel never has.
 *
 * None of these primitives take a className. The chrome is deliberately fixed:
 * `toolbar-icon-button` owns the transition/focus/armed-state contract, and a
 * caller-supplied `transition-*` utility would silently replace its transition
 * under tailwind-merge.
 */
/**
 * `label` is required rather than optional: `role="toolbar"` without an
 * accessible name announces as an unnamed container, and a panel with two
 * toolbars on screen would then have two of them. Making it a required prop
 * means the compiler asks every surface which row this is.
 */
const CompactContext = createContext(false);
const WidthContext = createContext<number | null>(null);

/**
 * The row's measured width, or null before the first measure (or when the
 * caller set no `compactBelow`). For a control that has its own, tighter
 * breakpoint than the row's secondary actions — a mode selector that becomes
 * a menu only once the actions have already folded.
 */
export function useFileViewerToolbarWidth(): number | null {
  return useContext(WidthContext);
}

/**
 * Whether the toolbar is below its caller's `compactBelow` width — the signal
 * for secondary actions to fold into `MoreActions` rather than squeeze the path
 * pill. Read by children rendered inside `Root`.
 */
export function useFileViewerToolbarCompact(): boolean {
  return useContext(CompactContext);
}

function Root({
  label,
  compactBelow,
  children,
}: {
  label: string;
  /**
   * Width in CSS px under which the row reports itself compact. Width of the
   * row, never of the pill: the row's width does not depend on which controls
   * are folded, so the switch cannot oscillate. Omitted, the row is never
   * compact.
   */
  compactBelow?: number;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = useToolbarRoving(ref);
  const [width, setWidth] = useState<number | null>(null);
  const compact = width !== null && compactBelow !== undefined && width < compactBelow;

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || compactBelow === undefined) {
      setWidth(null);
      return;
    }
    const measure = () => {
      const measured = element.getBoundingClientRect().width;
      // Zero means hidden or not laid out yet; keep the last answer rather than
      // flashing the compact layout on every reveal.
      if (measured > 0) setWidth(Math.round(measured));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [compactBelow]);

  return (
    <div
      ref={ref}
      data-compact={compact ? "" : undefined}
      // The APG toolbar pattern: one tab stop for the whole row, Left/Right
      // between its controls. Before this every button here was its own tab
      // stop, so tabbing past a viewer toolbar cost one press per control.
      role="toolbar"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="flex shrink-0 items-center gap-1.5 border-b border-overlay bg-surface px-2 py-1.5"
    >
      <CompactContext.Provider value={compact}>
        <WidthContext.Provider value={width}>{children}</WidthContext.Provider>
      </CompactContext.Provider>
    </div>
  );
}

/**
 * Path pill — mirrors the browser toolbar's address field. Click copies the
 * absolute path; the middle collapses to fit the available width while the
 * file name always survives. `path` is what's shown (root-relative where the
 * surface can compute it); what gets copied is the caller's business.
 */
function Path({
  path,
  copied,
  onCopy,
  icon: Icon = FileText,
  copyLabel = "Copy file path",
}: {
  path?: string;
  copied: boolean;
  onCopy: () => void;
  /**
   * The glyph for what the path names — the same type icon the tree shows on
   * that row, so the pill and the highlighted row read as one object. Defaults
   * to a plain document.
   */
  icon?: LucideIcon;
  /** Accessible name; stable across the copied flash. A folder says so. */
  copyLabel?: string;
}) {
  const { spanRef, display } = useFittedPath(path);
  const truncated = display !== undefined && display !== path;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onCopy}
          data-toolbar-path=""
          // The subject is part of the name at every width, not only when the
          // pill had to elide it: the visible text is the path, so a name of
          // just "Copy file path" would drop what the eye reads (label in name).
          aria-label={path ? `${copyLabel}: ${path}` : copyLabel}
          className="relative flex items-center min-w-0 flex-1 group/path"
        >
          {copied ? (
            <Check className="absolute left-2 w-3.5 h-3.5 text-status-success pointer-events-none" />
          ) : (
            <Icon
              aria-hidden="true"
              className="absolute left-2 w-3.5 h-3.5 text-text-secondary pointer-events-none"
            />
          )}
          <span
            ref={spanRef}
            className="w-full min-w-0 overflow-hidden pl-7 pr-2 py-1 text-left text-xs rounded-lg bg-surface-canvas border border-overlay text-text-secondary truncate transition-colors group-hover/path:border-border-strong group-hover/path:text-text-primary"
          >
            {display}
          </span>
        </button>
      </TooltipTrigger>
      {/* The whole path when the pill had to elide any of it, so hovering is
          how a clipped name is read in full; the copy hint rides underneath. */}
      <TooltipContent side="bottom" className="break-words">
        {truncated && <span className="block">{path}</span>}
        <span className={truncated ? "block text-text-secondary" : undefined}>
          {copied ? "Copied!" : "Click to copy"}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/** Right-aligned action group; holds the IconButtons. */
function Actions({ children }: { children: React.ReactNode }) {
  return <div className="ml-auto flex items-center gap-1.5 shrink-0">{children}</div>;
}

function IconButton({
  label,
  onClick,
  pressed,
  expanded,
  controls,
  sidebarToggle,
  children,
  "data-testid": testId,
}: {
  label: string;
  onClick: () => void;
  /** Renders the button as a toggle with an `aria-pressed` state. */
  pressed?: boolean;
  /**
   * Renders the button as a disclosure control with `aria-expanded` (show/hide
   * a region), the WAI-ARIA APG pattern for a collapsible sidebar. Mutually
   * exclusive with `pressed` — never set both, so the button carries one role.
   */
  expanded?: boolean;
  /** id of the region a disclosure button controls; omit while that region is unmounted. */
  controls?: string;
  /**
   * Opts the button out of the persistent `toolbar-icon-button` armed chip via
   * `data-sidebar-toggle` (see `toolbar.css`): a sidebar toggle sits in its
   * "on" state almost always, so the icon swap, not a lit background, carries
   * the state.
   */
  sidebarToggle?: boolean;
  children: React.ReactNode;
  "data-testid"?: string;
}) {
  const active = pressed === true || expanded === true;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          aria-pressed={pressed}
          aria-expanded={expanded}
          aria-controls={controls}
          data-sidebar-toggle={sidebarToggle ? "" : undefined}
          data-testid={testId}
          className={cn(
            "toolbar-icon-button p-1.5 rounded-lg",
            active ? "text-text-primary" : "text-text-secondary"
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * How long a copy confirmation stays on screen. One value for the one shared
 * button, rather than a prop: the two panes' own path pills already flash for
 * different durations, and handing this control the same seam is how the next
 * divergence would get in.
 */
const COPY_FEEDBACK_MS = 2000;

/**
 * Copies the file's raw text — the bytes the source view shows, whichever view
 * mode is on screen, so rendered markdown and rendered HTML copy their source
 * rather than the DOM they produced.
 *
 * Stateful where the rest of this namespace is chrome, and deliberately so:
 * both file viewers need this action and neither should be able to grow it
 * without the other (#12136). Owning the copied flag, the timer and the
 * clipboard call here is what makes that structural rather than a convention
 * two large panes have to keep. `Actions` stays a plain slot — DiffPane renders
 * one too and holds diff hunks, not raw file text.
 *
 * `contents === null` renders nothing: a read still in flight, an image, an SVG
 * (both viewers keep only sanitized markup), or a read that failed as binary,
 * oversized or an LFS pointer. An empty file is `""` and stays copyable, so the
 * gate is a null check and never a truthiness one.
 */
function CopyContentsButton({ contents }: { contents: string | null }) {
  // The text the clipboard was last confirmed to hold, not a boolean. The
  // checkmark then belongs to a value rather than to a moment: new contents
  // retire it in the very commit that paints them instead of a frame later via
  // an effect, and a write that resolves late can only ever confirm the text it
  // actually wrote. That is one piece of state doing what a flag plus a reset
  // effect plus a generation counter were doing before.
  const [copiedContents, setCopiedContents] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Only unmount needs a ref: a resolution arriving after teardown would
  // otherwise schedule a timer nothing is left to clear.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleClick = useCallback(() => {
    if (contents === null) return;
    if (!navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(contents).then(
      () => {
        if (!mountedRef.current) return;
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        setCopiedContents(contents);
        timeoutRef.current = setTimeout(() => {
          setCopiedContents(null);
          timeoutRef.current = null;
        }, COPY_FEEDBACK_MS);
      },
      () => {
        // Clipboard unavailable or refused. Silent, exactly like the path pill
        // above: the checkmark simply never appears, and a toast for a gesture
        // whose whole feedback is on the button would be the louder tier.
      }
    );
  }, [contents]);

  if (contents === null) return null;

  const copied = copiedContents === contents;

  return (
    <IconButton label="Copy file contents" onClick={handleClick}>
      {copied ? (
        <Check className={cn(TOOLBAR_ICON_CLASS, "text-status-success")} />
      ) : (
        <Copy className={TOOLBAR_ICON_CLASS} />
      )}
    </IconButton>
  );
}

/**
 * Where secondary actions go once the row is compact: one trigger, the same
 * footprint as an `IconButton`, holding whatever the caller would otherwise
 * have laid out as buttons. The caller supplies `DropdownMenuItem`s so each
 * surface keeps its own handlers. The standard narrow-toolbar pattern —
 * collapse secondary actions into an overflow menu before the identity or the
 * mode control has to give up a pixel.
 */
function MoreActions({
  children,
  "data-testid": testId,
}: {
  children: React.ReactNode;
  "data-testid"?: string;
}) {
  const label = "More actions";
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={label}
              data-testid={testId}
              className="toolbar-icon-button shrink-0 p-1.5 rounded-lg text-text-secondary"
            >
              <Ellipsis className={TOOLBAR_ICON_CLASS} aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-[200px]">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const FileViewerToolbar = {
  Root,
  Path,
  Actions,
  IconButton,
  CopyContentsButton,
  MoreActions,
};
